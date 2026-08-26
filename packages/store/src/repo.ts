/**
 * DEADRECKON :: data access.
 *
 * Plain SQL on purpose. Every query here is one you can paste into psql
 * and EXPLAIN, which matters far more on a 1 GB free tier than the
 * ergonomics of an ORM would.
 */

import type { Observation, Detection, Incident, Provenance } from '@deadreckon/core';
import { GENESIS_SHA, chainNext, sha256 } from '@deadreckon/core/provenance';
import { geohashEncode } from '@deadreckon/core';
import { getPool, withRetry } from './pool.js';

/* ------------------------------------------------------------ provenance */

/** In-memory chain heads, one per source. Reloaded on boot. */
const chainHead = new Map<number, string>();

export async function loadChainHeads(): Promise<void> {
  const { rows } = await getPool().query<{ source_id: number; chain_sha: string }>(
    `SELECT DISTINCT ON (source_id) source_id, chain_sha
       FROM provenance ORDER BY source_id, id DESC`,
  );
  for (const r of rows) chainHead.set(r.source_id, r.chain_sha);
}

export async function recordProvenance(p: {
  sourceId: number;
  url: string;
  httpStatus: number;
  payload: string | Uint8Array;
  parserVersion: string;
  recordCount: number;
}): Promise<Provenance> {
  const payloadSha = sha256(p.payload);
  const prev = chainHead.get(p.sourceId) ?? GENESIS_SHA;
  const chainSha = chainNext(prev, payloadSha);
  const bytes =
    typeof p.payload === 'string' ? Buffer.byteLength(p.payload) : p.payload.length;

  const { rows } = await withRetry(() =>
    getPool().query<{ id: number }>(
      `INSERT INTO provenance
         (source_id, url, fetched_at, http_status, payload_sha,
          prev_chain_sha, chain_sha, parser_version, record_count, bytes)
       VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        p.sourceId,
        p.url,
        p.httpStatus,
        payloadSha,
        prev,
        chainSha,
        p.parserVersion,
        p.recordCount,
        bytes,
      ],
    ),
  );

  chainHead.set(p.sourceId, chainSha);
  return {
    id: rows[0]!.id,
    sourceId: p.sourceId,
    url: p.url,
    fetchedAt: Date.now(),
    httpStatus: p.httpStatus,
    payloadSha,
    prevChainSha: prev,
    chainSha,
    parserVersion: p.parserVersion,
    recordCount: p.recordCount,
    bytes,
  };
}

/* ----------------------------------------------------------- observation */

/**
 * Bulk insert via unnest. One round trip, one plan, one parse for an
 * arbitrary number of rows -- versus N round trips for naive inserts.
 * At 10k aircraft per tick that is the difference between 40 ms and 12 s.
 */
export async function insertObservations(obs: readonly Observation[]): Promise<number> {
  if (obs.length === 0) return 0;

  const n = obs.length;
  const ts = new Array<Date>(n);
  const domain = new Array<number>(n);
  const entityId = new Array<string>(n);
  const lat = new Array<number>(n);
  const lon = new Array<number>(n);
  const altM = new Array<number | null>(n);
  const sog = new Array<number | null>(n);
  const cog = new Array<number | null>(n);
  const flags = new Array<number>(n);
  const conf = new Array<number>(n);
  const gh = new Array<string>(n);
  const src = new Array<number>(n);
  const prov = new Array<number | null>(n);
  const props = new Array<string | null>(n);

  for (let i = 0; i < n; i++) {
    const o = obs[i]!;
    ts[i] = new Date(o.ts);
    domain[i] = o.domain;
    entityId[i] = o.entityId;
    lat[i] = o.lat;
    lon[i] = o.lon;
    altM[i] = o.altM ?? null;
    sog[i] = o.sogKt ?? null;
    cog[i] = o.cogDeg ?? null;
    flags[i] = o.flags;
    conf[i] = o.conf;
    gh[i] = geohashEncode(o.lat, o.lon, 5);
    src[i] = o.sourceId ?? 0;
    prov[i] = o.provenanceId ?? null;
    props[i] = o.props ? JSON.stringify(o.props) : null;
  }

  await withRetry(() =>
    getPool().query(
      `INSERT INTO observation
         (ts, domain, entity_id, lat, lon, alt_m, sog_kt, cog_deg,
          flags, conf, geohash5, source_id, provenance_id, props)
       SELECT * FROM unnest(
         $1::timestamptz[], $2::smallint[], $3::text[],
         $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[],
         $9::int[], $10::smallint[], $11::char(5)[], $12::int[],
         $13::bigint[], $14::jsonb[])`,
      [ts, domain, entityId, lat, lon, altM, sog, cog, flags, conf, gh, src, prov, props],
    ),
  );
  return n;
}

/**
 * Upsert current state. GREATEST on last_seen keeps out-of-order arrivals
 * from rewinding an entity -- AIS in particular delivers late fixes.
 */
export async function upsertEntities(obs: readonly Observation[]): Promise<void> {
  if (obs.length === 0) return;

  // Collapse to the newest observation per entity within this batch.
  const latest = new Map<string, Observation>();
  for (const o of obs) {
    const prev = latest.get(o.entityId);
    if (!prev || o.ts > prev.ts) latest.set(o.entityId, o);
  }
  const rows = [...latest.values()];
  const n = rows.length;

  const ids = new Array<string>(n);
  const domain = new Array<number>(n);
  const label = new Array<string | null>(n);
  const kind = new Array<string | null>(n);
  const flagC = new Array<string | null>(n);
  const seen = new Array<Date>(n);
  const lat = new Array<number>(n);
  const lon = new Array<number>(n);
  const sog = new Array<number | null>(n);
  const cog = new Array<number | null>(n);
  const alt = new Array<number | null>(n);
  const fl = new Array<number>(n);
  const gh = new Array<string>(n);
  const props = new Array<string>(n);

  for (let i = 0; i < n; i++) {
    const o = rows[i]!;
    const p = (o.props ?? {}) as Record<string, unknown>;
    ids[i] = o.entityId;
    domain[i] = o.domain;
    label[i] = (p.label as string) ?? null;
    kind[i] = (p.kind as string) ?? null;
    flagC[i] = (p.flag as string) ?? null;
    seen[i] = new Date(o.ts);
    lat[i] = o.lat;
    lon[i] = o.lon;
    sog[i] = o.sogKt ?? null;
    cog[i] = o.cogDeg ?? null;
    alt[i] = o.altM ?? null;
    fl[i] = o.flags;
    gh[i] = geohashEncode(o.lat, o.lon, 5);
    props[i] = JSON.stringify(p);
  }

  await withRetry(() =>
    getPool().query(
      `INSERT INTO entity
         (entity_id, domain, label, kind, flag, first_seen, last_seen,
          last_lat, last_lon, last_sog_kt, last_cog_deg, last_alt_m,
          flags, geohash5, props)
       SELECT * FROM unnest(
         $1::text[], $2::smallint[], $3::text[], $4::text[], $5::text[],
         $6::timestamptz[], $6::timestamptz[],
         $7::float8[], $8::float8[], $9::real[], $10::real[], $11::real[],
         $12::int[], $13::char(5)[], $14::jsonb[])
       ON CONFLICT (entity_id) DO UPDATE SET
         last_seen    = GREATEST(entity.last_seen, EXCLUDED.last_seen),
         last_lat     = CASE WHEN EXCLUDED.last_seen >= entity.last_seen
                             THEN EXCLUDED.last_lat ELSE entity.last_lat END,
         last_lon     = CASE WHEN EXCLUDED.last_seen >= entity.last_seen
                             THEN EXCLUDED.last_lon ELSE entity.last_lon END,
         last_sog_kt  = COALESCE(EXCLUDED.last_sog_kt, entity.last_sog_kt),
         last_cog_deg = COALESCE(EXCLUDED.last_cog_deg, entity.last_cog_deg),
         last_alt_m   = COALESCE(EXCLUDED.last_alt_m, entity.last_alt_m),
         label        = COALESCE(EXCLUDED.label, entity.label),
         kind         = COALESCE(EXCLUDED.kind, entity.kind),
         flag         = COALESCE(EXCLUDED.flag, entity.flag),
         flags        = EXCLUDED.flags,
         geohash5     = EXCLUDED.geohash5,
         props        = entity.props || EXCLUDED.props`,
      [ids, domain, label, kind, flagC, seen, lat, lon, sog, cog, alt, fl, gh, props],
    ),
  );
}

export interface EntityRow {
  entity_id: string;
  domain: number;
  label: string | null;
  kind: string | null;
  flag: string | null;
  last_seen: number;
  last_lat: number;
  last_lon: number;
  last_sog_kt: number | null;
  last_cog_deg: number | null;
  last_alt_m: number | null;
  flags: number;
  geohash5: string;
}

export async function entitiesInCells(
  cells: readonly string[],
  domains: readonly number[],
  maxAgeS: number,
  limit = 20000,
): Promise<EntityRow[]> {
  if (cells.length === 0) return [];
  const { rows } = await getPool().query<EntityRow>(
    `SELECT entity_id, domain, label, kind, flag,
            last_seen, last_lat, last_lon,
            last_sog_kt, last_cog_deg, last_alt_m, flags, geohash5
       FROM entity
      WHERE geohash5 = ANY($1::char(5)[])
        AND domain    = ANY($2::smallint[])
        AND last_seen > now() - ($3 || ' seconds')::interval
      ORDER BY last_seen DESC
      LIMIT $4`,
    [cells, domains, String(maxAgeS), limit],
  );
  return rows;
}

/** The Scrubber's query: reconstruct a moment from the archive. */
export async function snapshotAt(
  atMs: number,
  cells: readonly string[],
  domains: readonly number[],
  windowS = 120,
  limit = 20000,
): Promise<EntityRow[]> {
  if (cells.length === 0) return [];
  const { rows } = await getPool().query<EntityRow>(
    `SELECT DISTINCT ON (entity_id)
            entity_id,
            domain,
            NULL::text  AS label,
            NULL::text  AS kind,
            NULL::text  AS flag,
            ts          AS last_seen,
            lat         AS last_lat,
            lon         AS last_lon,
            sog_kt      AS last_sog_kt,
            cog_deg     AS last_cog_deg,
            alt_m       AS last_alt_m,
            flags,
            geohash5
       FROM observation
      WHERE geohash5 = ANY($1::char(5)[])
        AND domain    = ANY($2::smallint[])
        AND ts <= to_timestamp($3 / 1000.0)
        AND ts >  to_timestamp($3 / 1000.0) - ($4 || ' seconds')::interval
      ORDER BY entity_id, ts DESC
      LIMIT $5`,
    [cells, domains, atMs, String(windowS), limit],
  );
  return rows;
}

export async function trackFor(
  entityId: string,
  fromMs: number,
  toMs: number,
  limit = 5000,
): Promise<
  { ts: number; lat: number; lon: number; sog: number | null; cog: number | null }[]
> {
  const { rows } = await getPool().query(
    `SELECT ts, lat, lon, sog_kt AS sog, cog_deg AS cog
       FROM observation
      WHERE entity_id = $1
        AND ts BETWEEN to_timestamp($2/1000.0) AND to_timestamp($3/1000.0)
      ORDER BY ts ASC
      LIMIT $4`,
    [entityId, fromMs, toMs, limit],
  );
  return rows as never;
}

/* ------------------------------------------------------------- detection */

/**
 * ON CONFLICT (hash) DO NOTHING is the idempotency guarantee. The engine
 * re-evaluates overlapping windows constantly; without a content hash it
 * would emit the same finding every tick and the ticker would be useless.
 * Returns null when the detection was already known.
 */
export async function insertDetection(d: Detection): Promise<number | null> {
  const { rows } = await withRetry(() =>
    getPool().query<{ id: number }>(
      `INSERT INTO detection
         (rule, severity, ts_start, ts_end, lat, lon, geohash5,
          entity_ids, title, summary, evidence, provenance_ids, state, hash)
       VALUES ($1,$2,to_timestamp($3/1000.0),
               CASE WHEN $4::float8 IS NULL THEN NULL
                    ELSE to_timestamp($4/1000.0) END,
               $5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (hash) DO NOTHING
       RETURNING id`,
      [
        d.rule,
        d.severity,
        d.tsStart,
        d.tsEnd,
        d.lat,
        d.lon,
        d.geohash5,
        d.entityIds,
        d.title,
        d.summary,
        JSON.stringify(d.evidence),
        d.provenanceIds,
        d.state,
        d.hash,
      ],
    ),
  );
  return rows[0]?.id ?? null;
}

export interface DetectionRow {
  id: number;
  rule: string;
  severity: number;
  ts_start: number;
  ts_end: number | null;
  lat: number;
  lon: number;
  geohash5: string;
  entity_ids: string[];
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  provenance_ids: number[];
  state: string;
  hash: string;
  incident_id: number | null;
}

export async function recentDetections(opts: {
  sinceMs?: number;
  minSeverity?: number;
  limit?: number;
  rules?: string[];
}): Promise<DetectionRow[]> {
  const { rows } = await getPool().query<DetectionRow>(
    `SELECT * FROM detection
      WHERE ts_start > to_timestamp($1/1000.0)
        AND severity >= $2
        AND ($3::text[] IS NULL OR rule = ANY($3::text[]))
      ORDER BY ts_start DESC
      LIMIT $4`,
    [
      opts.sinceMs ?? Date.now() - 24 * 3600_000,
      opts.minSeverity ?? 0,
      opts.rules ?? null,
      Math.min(opts.limit ?? 200, 1000),
    ],
  );
  return rows;
}

export async function detectionById(id: number): Promise<DetectionRow | null> {
  const { rows } = await getPool().query<DetectionRow>(
    `SELECT * FROM detection WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Candidates for CONFLUENCE: unabsorbed detections in a recent window. */
export async function unlinkedDetections(sinceMs: number): Promise<DetectionRow[]> {
  const { rows } = await getPool().query<DetectionRow>(
    `SELECT * FROM detection
      WHERE incident_id IS NULL
        AND ts_start > to_timestamp($1/1000.0)
      ORDER BY ts_start ASC
      LIMIT 2000`,
    [sinceMs],
  );
  return rows;
}

export async function upsertIncident(inc: Incident): Promise<number> {
  const { rows } = await withRetry(() =>
    getPool().query<{ id: number }>(
      `INSERT INTO incident
         (ts_start, ts_end, lat, lon, radius_km, severity, title,
          narrative, detection_ids, domains, hash, state)
       VALUES (to_timestamp($1/1000.0), to_timestamp($2/1000.0),
               $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (hash) DO UPDATE SET
         ts_end        = GREATEST(incident.ts_end, EXCLUDED.ts_end),
         severity      = GREATEST(incident.severity, EXCLUDED.severity),
         detection_ids = EXCLUDED.detection_ids,
         domains       = EXCLUDED.domains,
         narrative     = EXCLUDED.narrative,
         updated_at    = now()
       RETURNING id`,
      [
        inc.tsStart,
        inc.tsEnd,
        inc.lat,
        inc.lon,
        inc.radiusKm,
        inc.severity,
        inc.title,
        inc.narrative,
        inc.detectionIds,
        inc.domains,
        inc.hash,
        inc.state,
      ],
    ),
  );
  const id = rows[0]!.id;
  if (inc.detectionIds.length) {
    await getPool().query(
      `UPDATE detection SET incident_id = $1 WHERE id = ANY($2::bigint[])`,
      [id, inc.detectionIds],
    );
  }
  return id;
}

export async function recentIncidents(sinceMs: number, limit = 50) {
  const { rows } = await getPool().query(
    `SELECT * FROM incident
      WHERE ts_start > to_timestamp($1/1000.0)
      ORDER BY severity DESC, ts_start DESC
      LIMIT $2`,
    [sinceMs, limit],
  );
  return rows;
}

/* ------------------------------------------------------------- track gap */

export async function openGap(g: {
  entityId: string;
  domain: number;
  wentDarkAt: number;
  lat: number;
  lon: number;
  sogKt: number | null;
  cogDeg: number | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO track_gap
       (entity_id, domain, went_dark_at, last_lat, last_lon, last_sog_kt, last_cog_deg)
     SELECT $1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7
      WHERE NOT EXISTS (
        SELECT 1 FROM track_gap
         WHERE entity_id = $1 AND reacquired_at IS NULL)`,
    [g.entityId, g.domain, g.wentDarkAt, g.lat, g.lon, g.sogKt, g.cogDeg],
  );
}

export interface OpenGapRow {
  id: number;
  entity_id: string;
  domain: number;
  went_dark_at: number;
  last_lat: number;
  last_lon: number;
  last_sog_kt: number | null;
  last_cog_deg: number | null;
}

export async function openGapsFor(entityIds: readonly string[]): Promise<OpenGapRow[]> {
  if (!entityIds.length) return [];
  const { rows } = await getPool().query<OpenGapRow>(
    `SELECT id, entity_id, domain, went_dark_at, last_lat, last_lon,
            last_sog_kt, last_cog_deg
       FROM track_gap
      WHERE reacquired_at IS NULL AND entity_id = ANY($1::text[])`,
    [entityIds],
  );
  return rows;
}

export async function closeGap(
  id: number,
  at: number,
  lat: number,
  lon: number,
  verdict: string,
  score: number,
  evidence: Record<string, unknown>,
): Promise<void> {
  await getPool().query(
    `UPDATE track_gap
        SET reacquired_at = to_timestamp($2/1000.0),
            reacq_lat = $3, reacq_lon = $4,
            verdict = $5, anomaly_score = $6, evidence = $7
      WHERE id = $1`,
    [id, at, lat, lon, verdict, score, JSON.stringify(evidence)],
  );
}

/** Targets that have stopped reporting for longer than the threshold. */
export async function findNewlyDark(
  domain: number,
  thresholdS: number,
  maxAgeS: number,
  limit = 500,
): Promise<EntityRow[]> {
  const { rows } = await getPool().query<EntityRow>(
    `SELECT e.entity_id, e.domain, e.label, e.kind, e.flag, e.last_seen,
            e.last_lat, e.last_lon, e.last_sog_kt, e.last_cog_deg,
            e.last_alt_m, e.flags, e.geohash5
       FROM entity e
      WHERE e.domain = $1
        AND e.last_seen < now() - ($2 || ' seconds')::interval
        AND e.last_seen > now() - ($3 || ' seconds')::interval
        AND NOT EXISTS (
              SELECT 1 FROM track_gap g
               WHERE g.entity_id = e.entity_id AND g.reacquired_at IS NULL)
      ORDER BY e.last_seen DESC
      LIMIT $4`,
    [domain, String(thresholdS), String(maxAgeS), limit],
  );
  return rows;
}

/* -------------------------------------------------------------- baseline */

/**
 * Welford online update. Lets us hold a rolling mean and variance for
 * every cell/hour without ever storing the samples -- which is the only
 * way "what is normal here at 3am on a Tuesday" fits in a free tier.
 */
export async function updateBaselines(
  samples: { geohash4: string; domain: number; hourOfWeek: number; count: number }[],
): Promise<void> {
  if (!samples.length) return;
  const gh = samples.map((s) => s.geohash4);
  const dom = samples.map((s) => s.domain);
  const how = samples.map((s) => s.hourOfWeek);
  const cnt = samples.map((s) => s.count);

  await getPool().query(
    `INSERT INTO baseline (geohash4, domain, hour_of_week, n, mean_count, m2)
     SELECT g, d, h, 1, c, 0
       FROM unnest($1::char(4)[], $2::smallint[], $3::smallint[], $4::real[])
            AS t(g, d, h, c)
     ON CONFLICT (geohash4, domain, hour_of_week) DO UPDATE SET
       n          = baseline.n + 1,
       mean_count = baseline.mean_count
                    + (EXCLUDED.mean_count - baseline.mean_count) / (baseline.n + 1),
       m2         = baseline.m2
                    + (EXCLUDED.mean_count - baseline.mean_count)
                    * (EXCLUDED.mean_count - (baseline.mean_count
                       + (EXCLUDED.mean_count - baseline.mean_count) / (baseline.n + 1))),
       updated_at = now()`,
    [gh, dom, how, cnt],
  );
}

export interface BaselineRow {
  geohash4: string;
  domain: number;
  hour_of_week: number;
  n: number;
  mean_count: number;
  stddev: number;
}

export async function baselinesFor(
  hourOfWeek: number,
  domain: number,
  minN = 8,
): Promise<Map<string, BaselineRow>> {
  const { rows } = await getPool().query<BaselineRow>(
    `SELECT geohash4, domain, hour_of_week, n, mean_count,
            CASE WHEN n > 1 THEN sqrt(m2 / (n - 1)) ELSE 0 END AS stddev
       FROM baseline
      WHERE hour_of_week = $1 AND domain = $2 AND n >= $3`,
    [hourOfWeek, domain, minN],
  );
  return new Map(rows.map((r) => [r.geohash4, r]));
}

/* --------------------------------------------------------------- health */

export async function noteIngest(
  sourceId: number,
  ok: boolean,
  status: number,
  records: number,
  error?: string,
): Promise<void> {
  await getPool()
    .query(
      `INSERT INTO ingest_health
         (source_id, last_attempt, last_success, last_status, last_error,
          consec_errors, records_total, fetches_total)
       VALUES ($1, now(), CASE WHEN $2 THEN now() END, $3, $4,
               CASE WHEN $2 THEN 0 ELSE 1 END, $5, 1)
       ON CONFLICT (source_id) DO UPDATE SET
         last_attempt  = now(),
         last_success  = CASE WHEN $2 THEN now() ELSE ingest_health.last_success END,
         last_status   = $3,
         last_error    = CASE WHEN $2 THEN NULL ELSE $4 END,
         consec_errors = CASE WHEN $2 THEN 0 ELSE ingest_health.consec_errors + 1 END,
         records_total = ingest_health.records_total + $5,
         fetches_total = ingest_health.fetches_total + 1,
         backoff_until = CASE WHEN $2 THEN NULL
                              ELSE now() + (least(300,
                                   power(2, least(8, ingest_health.consec_errors + 1)))
                                   || ' seconds')::interval END`,
      [sourceId, ok, status, error ?? null, records],
    )
    .catch((e) => console.error('[health] write failed:', (e as Error).message));
}

export async function ingestHealth() {
  const { rows } = await getPool().query(
    `SELECT h.*, s.key, s.label, s.domain
       FROM ingest_health h JOIN source s ON s.id = h.source_id
      ORDER BY s.id`,
  );
  return rows;
}

export async function sourcesBackedOff(): Promise<Set<number>> {
  const { rows } = await getPool().query<{ source_id: number }>(
    `SELECT source_id FROM ingest_health WHERE backoff_until > now()`,
  );
  return new Set(rows.map((r) => r.source_id));
}

/* ------------------------------------------------------------- retention */

/**
 * Tiered retention. Everything is kept at full fidelity for RETAIN_RAW_H,
 * then thinned to one fix per entity per 5 minutes out to RETAIN_TRACK_H.
 * A dark-vessel verdict only needs the fix either side of the gap, so the
 * thinning costs nothing analytically and buys an order of magnitude of
 * history on the same disk.
 */
export async function runRetention(rawHours: number, trackHours: number) {
  const thinned = await getPool().query(
    `WITH ranked AS (
       SELECT id,
              row_number() OVER (
                PARTITION BY entity_id, date_trunc('hour', ts),
                             floor(extract(minute from ts) / 5)
                ORDER BY ts DESC) AS rn
         FROM observation
        WHERE ts <  now() - ($1 || ' hours')::interval
          AND ts >= now() - ($2 || ' hours')::interval)
     DELETE FROM observation o USING ranked r
      WHERE o.id = r.id AND r.rn > 1`,
    [String(rawHours), String(trackHours)],
  );

  const purged = await getPool().query(
    `DELETE FROM observation WHERE ts < now() - ($1 || ' hours')::interval`,
    [String(trackHours)],
  );

  await getPool().query(
    `DELETE FROM entity WHERE last_seen < now() - ($1 || ' hours')::interval`,
    [String(trackHours)],
  );

  return { thinned: thinned.rowCount ?? 0, purged: purged.rowCount ?? 0 };
}

export async function archiveStats() {
  const { rows } = await getPool().query(
    `SELECT
       (SELECT count(*) FROM observation)                       AS observations,
       (SELECT count(*) FROM entity)                            AS entities,
       (SELECT count(*) FROM detection)                         AS detections,
       (SELECT count(*) FROM incident)                          AS incidents,
       (SELECT count(*) FROM provenance)                        AS provenance_records,
       (SELECT min(ts) FROM observation)                        AS archive_from,
       (SELECT max(ts) FROM observation)                        AS archive_to,
       (SELECT pg_database_size(current_database()))            AS db_bytes`,
  );
  return rows[0];
}
