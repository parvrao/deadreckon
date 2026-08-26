/**
 * DEADRECKON :: ingest worker.
 *
 * Exactly one of these runs. Forever. That is the entire scalability
 * argument in one sentence: upstream load is a function of what we watch,
 * never of how many people are watching.
 *
 * The worker never serves a request and never holds a socket from a
 * browser. It polls, normalizes, stamps provenance, writes, and evaluates.
 * If every reader disappeared tomorrow the archive would keep filling --
 * which is the point, because the archive is what makes it possible to
 * scrub back to a moment nobody thought to record.
 */

import {
  Domain,
  SOURCE_BY_KEY,
  geohashEncode,
  type Observation,
} from '@deadreckon/core';
import {
  archiveStats,
  closePool,
  getPool,
  insertObservations,
  loadChainHeads,
  noteIngest,
  recordProvenance,
  runRetention,
  sourcesBackedOff,
  updateBaselines,
  upsertEntities,
} from '@deadreckon/store';
import { runEngine, hourOfWeekUtc, type WatchboxRow } from '@deadreckon/engine';

import {
  AIR_PARSER_VERSION,
  fetchAdsbCircle,
  fetchAdsbMil,
  fetchAdsbSquawk,
  fetchOpenSky,
} from './adapters/air.js';
import { SEA_PARSER_VERSION, SeaStream } from './adapters/sea.js';
import {
  MISC_PARSER_VERSION,
  TLE_GROUPS,
  fetchFirms,
  fetchQuakes,
  fetchTles,
} from './adapters/misc.js';
import { sleep } from './http.js';

const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

const POLL_AIR_S = num('POLL_AIR_S', 10);
const POLL_GEO_S = num('POLL_GEO_S', 60);
const POLL_THERMAL_S = num('POLL_THERMAL_S', 900);
const POLL_ORBIT_S = num('POLL_ORBIT_S', 21600);
const RETAIN_RAW_H = num('RETAIN_RAW_H', 48);
const RETAIN_TRACK_H = num('RETAIN_TRACK_H', 720);
const ENGINE_TICK_S = num('ENGINE_TICK_S', 30);

const ac = new AbortController();
let shuttingDown = false;

/** Observations accumulated since the last engine tick. */
let pending: Observation[] = [];
let pendingProvenance: number[] = [];
let watchboxes: WatchboxRow[] = [];

/* ------------------------------------------------------------------ */

async function loadWatchboxes(): Promise<void> {
  const { rows } = await getPool().query<WatchboxRow>(
    `SELECT key, label, min_lat, min_lon, max_lat, max_lon, dark_threshold_s
       FROM watchbox WHERE active ORDER BY id`,
  );
  watchboxes = rows;
  console.log(`[worker] ${rows.length} watchboxes active`);
}

/**
 * Every write to the archive goes through here, so every row in
 * `observation` is attributable to a provenance record, always. There is
 * no code path that inserts an unsourced observation.
 */
async function commit(
  sourceKey: string,
  url: string,
  httpStatus: number,
  payload: string,
  parserVersion: string,
  obs: Observation[],
): Promise<void> {
  const source = SOURCE_BY_KEY.get(sourceKey);
  if (!source) throw new Error(`unknown source key: ${sourceKey}`);

  const ok = httpStatus >= 200 && httpStatus < 300;
  if (!ok || obs.length === 0) {
    await noteIngest(source.id, ok, httpStatus, 0, ok ? undefined : `HTTP ${httpStatus}`);
    return;
  }

  const prov = await recordProvenance({
    sourceId: source.id,
    url,
    httpStatus,
    payload,
    parserVersion,
    recordCount: obs.length,
  });

  for (const o of obs) {
    o.sourceId = source.id;
    o.provenanceId = prov.id;
  }

  await insertObservations(obs);
  await upsertEntities(obs);
  await noteIngest(source.id, true, httpStatus, obs.length);

  pending.push(...obs);
  if (prov.id != null) pendingProvenance.push(prov.id);
  // Bound memory if the engine tick is starved.
  if (pending.length > 120_000) pending = pending.slice(-80_000);
  if (pendingProvenance.length > 400) pendingProvenance = pendingProvenance.slice(-200);
}

/* ------------------------------------------------------- air poll loop */

/**
 * Targeted, not exhaustive. Watchbox circles plus two global high-signal
 * queries. Scraping the whole sky every ten seconds would be antisocial,
 * would get us rate-limited within the hour, and would bury the signal.
 */
async function pollAir(): Promise<void> {
  const backedOff = await sourcesBackedOff();
  const useOpenSky =
    !!process.env.OPENSKY_CLIENT_ID && !backedOff.has(SOURCE_BY_KEY.get('opensky')!.id);

  if (!backedOff.has(SOURCE_BY_KEY.get('adsb_lol')!.id)) {
    for (const b of watchboxes) {
      if (ac.signal.aborted) return;
      const lat = (b.min_lat + b.max_lat) / 2;
      const lon = (b.min_lon + b.max_lon) / 2;
      // Cover the diagonal, capped at the provider's 250 nm limit.
      const distNm = Math.min(
        250,
        Math.max(
          40,
          (Math.hypot(b.max_lat - b.min_lat, (b.max_lon - b.min_lon) * Math.cos((lat * Math.PI) / 180)) *
            60) /
            2,
        ),
      );
      const { observations, raw } = await fetchAdsbCircle(lat, lon, distNm, ac.signal);
      await commit('adsb_lol', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
    }

    for (const fn of [
      () => fetchAdsbMil(ac.signal),
      () => fetchAdsbSquawk('7700', ac.signal),
      () => fetchAdsbSquawk('7600', ac.signal),
      () => fetchAdsbSquawk('7500', ac.signal),
    ]) {
      if (ac.signal.aborted) return;
      const { observations, raw } = await fn();
      await commit('adsb_lol', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
    }
  }

  if (useOpenSky) {
    const { observations, raw } = await fetchOpenSky(null, ac.signal);
    await commit('opensky', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
  }
}

/* ----------------------------------------------------------- other polls */

async function pollGeo(): Promise<void> {
  const { observations, raw } = await fetchQuakes(ac.signal);
  await commit('usgs_quake', raw.url, raw.status, raw.body, MISC_PARSER_VERSION, observations);
}

async function pollThermal(): Promise<void> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return;
  for (const b of watchboxes) {
    if (ac.signal.aborted) return;
    const area = `${b.min_lon},${b.min_lat},${b.max_lon},${b.max_lat}`;
    const { observations, raw } = await fetchFirms(key, area, ac.signal);
    await commit('nasa_firms', raw.url, raw.status, raw.body, MISC_PARSER_VERSION, observations);
  }
}

/**
 * Orbital elements are stored, not propagated. See adapters/misc.ts --
 * the client does SGP4 locally so the orbital layer costs the server
 * one fetch every six hours and nothing per viewer.
 */
async function pollOrbit(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS tle (
       norad_id int PRIMARY KEY,
       name text NOT NULL,
       line1 text NOT NULL,
       line2 text NOT NULL,
       grp  text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now())`,
  );

  for (const group of TLE_GROUPS) {
    if (ac.signal.aborted) return;
    const { tles, raw } = await fetchTles(group, ac.signal);
    if (!raw.ok || !tles.length) {
      // Some groups do not exist on every mirror. Not an error worth backing off for.
      continue;
    }
    await pool.query(
      `INSERT INTO tle (norad_id, name, line1, line2, grp)
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (norad_id) DO UPDATE SET
         name = EXCLUDED.name, line1 = EXCLUDED.line1,
         line2 = EXCLUDED.line2, grp = EXCLUDED.grp, updated_at = now()`,
      [
        tles.map((t) => t.noradId),
        tles.map((t) => t.name),
        tles.map((t) => t.line1),
        tles.map((t) => t.line2),
        tles.map((t) => t.group),
      ],
    );
    const src = SOURCE_BY_KEY.get('celestrak')!;
    await recordProvenance({
      sourceId: src.id,
      url: raw.url,
      httpStatus: raw.status,
      payload: raw.body,
      parserVersion: MISC_PARSER_VERSION,
      recordCount: tles.length,
    });
    await noteIngest(src.id, true, raw.status, tles.length);
    console.log(`[orbit] ${group}: ${tles.length} element sets`);
  }
}

/* ------------------------------------------------------------- sea stream */

function startSea(): SeaStream | null {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) {
    console.warn(
      '[worker] AISSTREAM_API_KEY not set -- the sea domain is DISABLED. ' +
        'Dark-vessel detection is the flagship rule; get a free key at aisstream.io.',
    );
    return null;
  }

  const boxes = watchboxes.map((b) => [
    [b.min_lat, b.min_lon],
    [b.max_lat, b.max_lon],
  ]);

  const stream = new SeaStream({
    apiKey,
    boundingBoxes: boxes.length ? boxes : [[[-90, -180], [90, 180]]],
    onBatch: async (obs, rawSample) => {
      await commit(
        'aisstream',
        'wss://stream.aisstream.io/v0/stream',
        200,
        rawSample,
        SEA_PARSER_VERSION,
        obs,
      );
    },
  });
  stream.start();
  return stream;
}

/* ----------------------------------------------------------- engine tick */

async function engineTick(): Promise<void> {
  if (!pending.length) return;
  const batch = pending;
  const provIds = pendingProvenance;
  pending = [];
  pendingProvenance = [];

  const t0 = Date.now();
  const result = await runEngine({
    now: Date.now(),
    batch,
    provenanceIds: provIds,
    watchboxes,
  });

  if (result.newDetectionIds.length || result.incidents || result.gapsOpened) {
    console.log(
      `[engine] ${batch.length} obs -> ${result.newDetectionIds.length} new detections, ` +
        `${result.incidents} incidents, ${result.gapsOpened} gaps opened ` +
        `(${Date.now() - t0}ms)`,
    );
    for (const d of result.detections) {
      if (d.id) console.log(`         [${d.severity}] ${d.rule}: ${d.title}`);
    }
  }
  for (const e of result.errors) console.error(`[engine] ${e.rule}: ${e.message}`);

  await learnBaselines(batch);
}

/**
 * Feed the rolling normal. Without this the AIRSPACE_VOID rule has nothing
 * to compare against and stays silent -- which is correct behaviour on a
 * cold start, and why a fresh deployment gets quieter, not louder, over
 * its first week.
 */
let lastBaselineHour = -1;
async function learnBaselines(batch: readonly Observation[]): Promise<void> {
  const hour = Math.floor(Date.now() / 3600_000);
  if (hour === lastBaselineHour) return;
  lastBaselineHour = hour;

  const counts = new Map<string, number>();
  for (const o of batch) {
    if (o.domain !== Domain.AIR) continue;
    const c = geohashEncode(o.lat, o.lon, 4);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (!counts.size) return;

  await updateBaselines(
    [...counts].map(([geohash4, count]) => ({
      geohash4,
      domain: Domain.AIR,
      hourOfWeek: hourOfWeekUtc(Date.now()),
      count,
    })),
  );
  console.log(`[baseline] updated ${counts.size} cells for hour ${hourOfWeekUtc(Date.now())}`);
}

/* ---------------------------------------------------------------- runner */

/**
 * A loop that logs and continues rather than one that throws and dies.
 * A worker that exits on a transient upstream error is a worker that is
 * offline for exactly the events it exists to catch.
 */
function every(label: string, seconds: number, fn: () => Promise<void>): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (shuttingDown || running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] tick failed:`, (err as Error).message);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), seconds * 1000).unref?.();
}

async function main(): Promise<void> {
  console.log('DEADRECKON ingest worker');
  console.log('  always on. nobody has to press record.\n');

  getPool({ label: 'ingest', max: 4 });
  await loadChainHeads();
  await loadWatchboxes();

  const sea = startSea();

  every('air', POLL_AIR_S, pollAir);
  every('geo', POLL_GEO_S, pollGeo);
  every('thermal', POLL_THERMAL_S, pollThermal);
  every('orbit', POLL_ORBIT_S, pollOrbit);
  every('engine', ENGINE_TICK_S, engineTick);

  every('retention', 3600, async () => {
    const r = await runRetention(RETAIN_RAW_H, RETAIN_TRACK_H);
    const s = await archiveStats();
    console.log(
      `[retention] thinned ${r.thinned}, purged ${r.purged} | ` +
        `archive ${Number(s.observations).toLocaleString()} obs, ` +
        `${(Number(s.db_bytes) / 1e6).toFixed(1)} MB`,
    );
  });

  every('heartbeat', 300, async () => {
    const s = await archiveStats();
    console.log(
      `[heartbeat] entities=${s.entities} detections=${s.detections} ` +
        `incidents=${s.incidents} sea=${sea?.healthy ? 'up' : 'down'} ` +
        `db=${(Number(s.db_bytes) / 1e6).toFixed(1)}MB`,
    );
  });

  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[worker] ${sig} -- draining`);
    ac.abort();
    await sea?.stop();
    // Flush whatever the engine has not yet seen so the last tick before
    // a deploy is not silently lost.
    await engineTick().catch(() => {});
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (r) =>
    console.error('[worker] unhandled rejection:', r),
  );

  // Keep the process alive.
  for (;;) await sleep(3600_000);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
