/**
 * DEADRECKON :: ingest core.
 *
 * The collection logic, with its state made explicit so it can be driven
 * two different ways:
 *
 *   worker.ts   a long-lived process on intervals. One replica, forever.
 *   once.ts     a bounded run that collects for N seconds and exits, for
 *               a scheduled CI job.
 *
 * The second exists because Render has no free background worker tier, and
 * the alternative -- folding ingest into the web service -- would mean the
 * archive only fills while somebody has the page open. That would quietly
 * invert the entire premise: "nobody has to press record" would become
 * "somebody has to keep a tab open". A cron job with five-minute gaps is
 * a worse archive than a continuous one, but it is still an archive that
 * fills whether or not anyone is looking, which is the property that
 * matters.
 */

import {
  Domain,
  SOURCE_BY_KEY,
  geohashEncode,
  type Observation,
} from '@deadreckon/core';
import {
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
import { runEngine, hourOfWeekUtc, type WatchboxRow, type EngineResult } from '@deadreckon/engine';

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

export const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export class Ingest {
  private pending: Observation[] = [];
  private pendingProvenance: number[] = [];
  private ac = new AbortController();
  private sea: SeaStream | null = null;
  private lastBaselineHour = -1;

  watchboxes: WatchboxRow[] = [];

  get signal(): AbortSignal {
    return this.ac.signal;
  }
  get seaHealthy(): boolean {
    return this.sea?.healthy ?? false;
  }
  get queued(): number {
    return this.pending.length;
  }

  async init(): Promise<void> {
    await loadChainHeads();
    const { rows } = await getPool().query<WatchboxRow>(
      `SELECT key, label, min_lat, min_lon, max_lat, max_lon, dark_threshold_s
         FROM watchbox WHERE active ORDER BY id`,
    );
    this.watchboxes = rows;
  }

  /**
   * Every write to the archive goes through here, so every row in
   * `observation` is attributable to a provenance record. There is no code
   * path that inserts an unsourced observation.
   */
  private async commit(
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

    this.pending.push(...obs);
    if (prov.id != null) this.pendingProvenance.push(prov.id);
    if (this.pending.length > 120_000) this.pending = this.pending.slice(-80_000);
    if (this.pendingProvenance.length > 400) {
      this.pendingProvenance = this.pendingProvenance.slice(-200);
    }
  }

  /* ------------------------------------------------------------- air */

  /**
   * Targeted, not exhaustive. Watchbox circles plus two global
   * high-signal queries. Scraping the whole sky every ten seconds would be
   * antisocial, would get us rate-limited within the hour, and would bury
   * the signal we are actually looking for.
   */
  async pollAir(): Promise<void> {
    const backedOff = await sourcesBackedOff();

    if (!backedOff.has(SOURCE_BY_KEY.get('adsb_lol')!.id)) {
      for (const b of this.watchboxes) {
        if (this.ac.signal.aborted) return;
        const lat = (b.min_lat + b.max_lat) / 2;
        const lon = (b.min_lon + b.max_lon) / 2;
        const distNm = Math.min(
          250,
          Math.max(
            40,
            (Math.hypot(
              b.max_lat - b.min_lat,
              (b.max_lon - b.min_lon) * Math.cos((lat * Math.PI) / 180),
            ) *
              60) /
              2,
          ),
        );
        const { observations, raw } = await fetchAdsbCircle(lat, lon, distNm, this.ac.signal);
        await this.commit('adsb_lol', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
      }

      for (const fn of [
        () => fetchAdsbMil(this.ac.signal),
        () => fetchAdsbSquawk('7700', this.ac.signal),
        () => fetchAdsbSquawk('7600', this.ac.signal),
        () => fetchAdsbSquawk('7500', this.ac.signal),
      ]) {
        if (this.ac.signal.aborted) return;
        const { observations, raw } = await fn();
        await this.commit('adsb_lol', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
      }
    }

    if (process.env.OPENSKY_CLIENT_ID && !backedOff.has(SOURCE_BY_KEY.get('opensky')!.id)) {
      const { observations, raw } = await fetchOpenSky(null, this.ac.signal);
      await this.commit('opensky', raw.url, raw.status, raw.body, AIR_PARSER_VERSION, observations);
    }
  }

  /* ----------------------------------------------------- geo, thermal */

  async pollGeo(): Promise<void> {
    const { observations, raw } = await fetchQuakes(this.ac.signal);
    await this.commit('usgs_quake', raw.url, raw.status, raw.body, MISC_PARSER_VERSION, observations);
  }

  async pollThermal(): Promise<void> {
    const key = process.env.FIRMS_MAP_KEY;
    if (!key) return;
    for (const b of this.watchboxes) {
      if (this.ac.signal.aborted) return;
      const area = `${b.min_lon},${b.min_lat},${b.max_lon},${b.max_lat}`;
      const { observations, raw } = await fetchFirms(key, area, this.ac.signal);
      await this.commit('nasa_firms', raw.url, raw.status, raw.body, MISC_PARSER_VERSION, observations);
    }
  }

  /* --------------------------------------------------------- orbital */

  /**
   * Elements are stored, never propagated server-side. A satellite's
   * position is a deterministic function of (elements, time), so the
   * browser runs SGP4 locally and the orbital layer costs the backend one
   * fetch every six hours and nothing per viewer.
   *
   * `maxAgeS` exists for the cron path: a job running every five minutes
   * must not refetch 11,000 element sets every time.
   */
  async pollOrbit(maxAgeS = 0): Promise<boolean> {
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

    if (maxAgeS > 0) {
      const { rows } = await pool.query<{ fresh: boolean }>(
        `SELECT coalesce(max(updated_at) > now() - ($1 || ' seconds')::interval, false) AS fresh
           FROM tle`,
        [String(maxAgeS)],
      );
      if (rows[0]?.fresh) return false;
    }

    for (const group of TLE_GROUPS) {
      if (this.ac.signal.aborted) return true;
      const { tles, raw } = await fetchTles(group, this.ac.signal);
      if (!raw.ok || !tles.length) continue;

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
    return true;
  }

  /* ------------------------------------------------------------- sea */

  startSea(): boolean {
    const apiKey = process.env.AISSTREAM_API_KEY;
    if (!apiKey) {
      console.warn(
        '[worker] AISSTREAM_API_KEY not set -- the sea domain is DISABLED. ' +
          'Dark-vessel detection is the flagship rule; get a free key at aisstream.io.',
      );
      return false;
    }

    const boxes = this.watchboxes.map((b) => [
      [b.min_lat, b.min_lon],
      [b.max_lat, b.max_lon],
    ]);

    this.sea = new SeaStream({
      apiKey,
      boundingBoxes: boxes.length ? boxes : [[[-90, -180], [90, 180]]],
      onBatch: async (obs, rawSample) => {
        await this.commit(
          'aisstream',
          'wss://stream.aisstream.io/v0/stream',
          200,
          rawSample,
          SEA_PARSER_VERSION,
          obs,
        );
      },
    });
    this.sea.start();
    return true;
  }

  /* ---------------------------------------------------------- engine */

  async engineTick(): Promise<EngineResult | null> {
    if (!this.pending.length) return null;
    const batch = this.pending;
    const provIds = this.pendingProvenance;
    this.pending = [];
    this.pendingProvenance = [];

    const result = await runEngine({
      now: Date.now(),
      batch,
      provenanceIds: provIds,
      watchboxes: this.watchboxes,
    });

    await this.learnBaselines(batch);
    return result;
  }

  /**
   * Feed the rolling normal. Without it AIRSPACE_VOID has nothing to
   * compare against and stays silent, which is correct on a cold start and
   * why a fresh deployment gets quieter, not louder, over its first week.
   */
  private async learnBaselines(batch: readonly Observation[]): Promise<void> {
    const hour = Math.floor(Date.now() / 3600_000);
    if (hour === this.lastBaselineHour) return;
    this.lastBaselineHour = hour;

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
    console.log(`[baseline] updated ${counts.size} cells`);
  }

  async retention(): Promise<{ thinned: number; purged: number }> {
    return runRetention(num('RETAIN_RAW_H', 48), num('RETAIN_TRACK_H', 720));
  }

  /* --------------------------------------------------------- shutdown */

  async stop(): Promise<void> {
    this.ac.abort();
    await this.sea?.stop();
    this.sea = null;
  }

  /** Log an engine result in the shape both entrypoints use. */
  static report(result: EngineResult | null, obsCount: number, ms: number): void {
    if (!result) return;
    if (result.newDetectionIds.length || result.incidents || result.gapsOpened) {
      console.log(
        `[engine] ${obsCount} obs -> ${result.newDetectionIds.length} new detections, ` +
          `${result.incidents} incidents, ${result.gapsOpened} gaps opened (${ms}ms)`,
      );
      for (const d of result.detections) {
        if (d.id) console.log(`         [${d.severity}] ${d.rule}: ${d.title}`);
      }
    }
    for (const s of result.suppressed) {
      console.warn(
        `[engine] BREAKER TRIPPED: ${s.rule} tried to emit ${s.produced}, kept ${s.kept}. ` +
          `Investigate the rule rather than raising the cap.`,
      );
    }
    for (const e of result.errors) console.error(`[engine] ${e.rule}: ${e.message}`);
  }
}
