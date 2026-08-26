/**
 * DEADRECKON :: read API + WebSocket hub.
 *
 * This service is stateless and read-only. It can be scaled to N replicas
 * behind a load balancer without coordination, because it never writes to
 * the archive and never talks to an upstream OSINT provider. The only
 * writer in the entire system is the single ingest worker.
 *
 * That separation is not tidiness. It is the reason a traffic spike costs
 * containers instead of costing us our data sources.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer } from 'ws';
import {
  SOURCES,
  DOMAIN_NAME,
  cellsForBounds,
  precisionForBounds,
  reachableSetPolygon,
  reachableSet,
  profileFor,
  type Bounds,
} from '@deadreckon/core';
import { verifyChain } from '@deadreckon/core/provenance';
import {
  archiveStats,
  closePool,
  detectionById,
  getPool,
  ingestHealth,
  recentDetections,
  recentIncidents,
  trackFor,
} from '@deadreckon/store';
import { attach, startHub, hubStats, broadcastEvent } from './hub.js';
import { buildEvidenceBundle } from './evidence.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const STARTED = Date.now();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'production' ? undefined : undefined,
  },
  trustProxy: true,
  bodyLimit: 64 * 1024,
});

await app.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()) ?? true,
  methods: ['GET', 'OPTIONS'],
});

getPool({ label: 'api', max: 5 });

/* ------------------------------------------------------------------ meta */

app.get('/api/health', async () => {
  const t0 = Date.now();
  let db = 'down';
  let dbMs = -1;
  try {
    await getPool().query('SELECT 1');
    db = 'up';
    dbMs = Date.now() - t0;
  } catch {
    /* reported as down */
  }
  return {
    service: 'deadreckon-api',
    status: db === 'up' ? 'ok' : 'degraded',
    uptimeS: Math.round((Date.now() - STARTED) / 1000),
    db,
    dbLatencyMs: dbMs,
    hub: hubStats(),
  };
});

/**
 * Full source disclosure, served to anyone who asks. If a reader cannot
 * see which feeds a map rests on and under what licence, the map is
 * asking for trust it has not earned.
 */
app.get('/api/sources', async () => {
  let health: unknown[] = [];
  try {
    health = await ingestHealth();
  } catch {
    /* the catalogue is still worth serving */
  }
  return {
    sources: SOURCES.map((s) => ({ ...s, domainName: DOMAIN_NAME[s.domain] })),
    health,
  };
});

app.get('/api/stats', async () => {
  const [archive, health] = await Promise.all([
    archiveStats().catch(() => null),
    ingestHealth().catch(() => []),
  ]);
  return {
    archive,
    ingest: health,
    hub: hubStats(),
    architecture: {
      writers: 1,
      note:
        'Upstream fetch volume is a function of the watch list, not of ' +
        'concurrent viewers. Adding a viewer adds one WebSocket and zero ' +
        'upstream requests.',
    },
  };
});

app.get('/api/watchboxes', async () => {
  const { rows } = await getPool().query(
    `SELECT key, label, min_lat, min_lon, max_lat, max_lon,
            dark_threshold_s, active
       FROM watchbox ORDER BY id`,
  );
  return { watchboxes: rows };
});

/* ------------------------------------------------------------ detections */

app.get('/api/detections', async (req) => {
  const q = req.query as Record<string, string>;
  const rows = await recentDetections({
    sinceMs: q.since ? Number(q.since) : Date.now() - 24 * 3600_000,
    minSeverity: q.minSeverity ? Number(q.minSeverity) : 0,
    limit: q.limit ? Number(q.limit) : 200,
    rules: q.rule ? q.rule.split(',') : undefined,
  });
  return { detections: rows, count: rows.length };
});

/**
 * The Case File.
 *
 * A detection on its own is a claim. This endpoint returns the claim plus
 * everything needed to refute it: the exact provenance records, their hash
 * chain, the target's track either side of the event, and -- for
 * dead-reckoning verdicts -- the reachable-set polygon the verdict was
 * computed against, so the reader can see the envelope rather than take
 * our word for it.
 */
app.get('/api/detections/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const d = await detectionById(id);
  if (!d) return reply.code(404).send({ error: 'no such detection' });

  const provenance = d.provenance_ids.length
    ? (
        await getPool().query(
          `SELECT p.*, s.key AS source_key, s.label AS source_label, s.license
             FROM provenance p JOIN source s ON s.id = p.source_id
            WHERE p.id = ANY($1::bigint[]) ORDER BY p.id`,
          [d.provenance_ids],
        )
      ).rows
    : [];

  const tracks: Record<string, unknown> = {};
  for (const eid of d.entity_ids.slice(0, 4)) {
    tracks[eid] = await trackFor(
      eid,
      d.ts_start - 6 * 3600_000,
      (d.ts_end ?? d.ts_start) + 3600_000,
      1500,
    );
  }

  // Recompute the envelope from the stored fix so the drawing on screen is
  // derived live, not a cached picture that could drift from the verdict.
  let envelope: [number, number][] | null = null;
  const ev = d.evidence as Record<string, unknown>;
  if (ev?.lastFix && ev?.reacquiredAt && ev?.wentDarkAt) {
    const lf = ev.lastFix as {
      lat: number;
      lon: number;
      sogKt: number | null;
      cogDeg: number | null;
    };
    const profile = profileFor(
      d.rule === 'DARK_VESSEL' || d.rule === 'SPOOF_DISCONTINUITY' ? 2 : 1,
      (ev.kinematicProfile as { kind?: string })?.kind ?? null,
    );
    envelope = reachableSetPolygon(
      reachableSet(
        { ts: Number(ev.wentDarkAt), lat: lf.lat, lon: lf.lon, sogKt: lf.sogKt, cogDeg: lf.cogDeg },
        Number(ev.reacquiredAt),
        profile,
      ),
      48,
    );
  }

  const incident = d.incident_id
    ? (await getPool().query(`SELECT * FROM incident WHERE id = $1`, [d.incident_id]))
        .rows[0]
    : null;

  return { detection: d, provenance, tracks, reachableSetPolygon: envelope, incident };
});

/**
 * Evidence bundle. Everything a third party needs to independently
 * re-derive the finding, as one JSON document with a manifest and hashes.
 */
app.get('/api/detections/:id/evidence', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const bundle = await buildEvidenceBundle(id);
  if (!bundle) return reply.code(404).send({ error: 'no such detection' });
  const short = String(bundle.detection.hash ?? id).slice(0, 12);
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header(
      'content-disposition',
      `attachment; filename="deadreckon-evidence-${id}-${short}.json"`,
    )
    .send(bundle);
});

/* ------------------------------------------------------------- incidents */

app.get('/api/incidents', async (req) => {
  const q = req.query as Record<string, string>;
  const rows = await recentIncidents(
    q.since ? Number(q.since) : Date.now() - 7 * 24 * 3600_000,
    q.limit ? Number(q.limit) : 50,
  );
  return { incidents: rows, count: rows.length };
});

app.get('/api/incidents/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { rows } = await getPool().query(`SELECT * FROM incident WHERE id = $1`, [id]);
  const inc = rows[0];
  if (!inc) return reply.code(404).send({ error: 'no such incident' });

  const { rows: members } = await getPool().query(
    `SELECT * FROM detection WHERE id = ANY($1::bigint[]) ORDER BY ts_start`,
    [inc.detection_ids],
  );
  return { incident: inc, detections: members };
});

/* ---------------------------------------------------------------- replay */

/**
 * The Scrubber's backing query. No "start recording" ever happened; the
 * moment is simply in the archive because the worker never stopped.
 */
app.get('/api/replay', async (req, reply) => {
  const q = req.query as Record<string, string>;
  const at = Number(q.at);
  if (!Number.isFinite(at)) return reply.code(400).send({ error: 'at (ms) required' });

  const bbox: Bounds = {
    minLat: Number(q.minLat ?? -90),
    minLon: Number(q.minLon ?? -180),
    maxLat: Number(q.maxLat ?? 90),
    maxLon: Number(q.maxLon ?? 180),
  };
  const precision = precisionForBounds(bbox, 256);
  const cells = cellsForBounds(bbox, precision, 512);
  const domains = (q.domains ?? 'air,sea')
    .split(',')
    .map((n) => Object.entries(DOMAIN_NAME).find(([, v]) => v === n)?.[0])
    .filter(Boolean)
    .map(Number);

  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (entity_id)
            entity_id, domain, ts, lat, lon, sog_kt, cog_deg, alt_m, flags
       FROM observation
      WHERE geohash5 = ANY($1::char(5)[]) AND domain = ANY($2::smallint[])
        AND ts <= to_timestamp($3/1000.0)
        AND ts >  to_timestamp($3/1000.0) - interval '3 minutes'
      ORDER BY entity_id, ts DESC
      LIMIT 20000`,
    [cells, domains.length ? domains : [1, 2], at],
  );

  return { at, cells: cells.length, precision, entities: rows, count: rows.length };
});

app.get('/api/track/:entityId', async (req) => {
  const { entityId } = req.params as { entityId: string };
  const q = req.query as Record<string, string>;
  const to = q.to ? Number(q.to) : Date.now();
  const from = q.from ? Number(q.from) : to - 12 * 3600_000;
  const track = await trackFor(entityId, from, to, 5000);
  return { entityId, from, to, track, count: track.length };
});

/* ------------------------------------------------------------ provenance */

/**
 * Public integrity audit. Anyone can recompute the chain and find out
 * whether the archive has been edited since it was written. An integrity
 * claim nobody can check is decoration.
 */
app.get('/api/provenance/verify', async (req) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(Number(q.limit) || 500, 5000);
  const results: Record<string, unknown> = {};

  for (const s of SOURCES) {
    const { rows } = await getPool().query(
      `SELECT payload_sha AS "payloadSha", prev_chain_sha AS "prevChainSha",
              chain_sha AS "chainSha"
         FROM provenance WHERE source_id = $1 ORDER BY id ASC LIMIT $2`,
      [s.id, limit],
    );
    if (!rows.length) continue;
    results[s.key] = { records: rows.length, ...verifyChain(rows as never) };
  }
  return {
    checked: Object.keys(results).length,
    results,
    note:
      'chain[n] = sha256(chain[n-1] || sha256(payload[n])). Any retroactive ' +
      'edit to a stored payload breaks every link after it.',
  };
});

app.get('/api/tles', async () => {
  try {
    const { rows } = await getPool().query(
      `SELECT norad_id, name, line1, line2, grp FROM tle ORDER BY norad_id LIMIT 6000`,
    );
    return { tles: rows, count: rows.length };
  } catch {
    return { tles: [], count: 0, note: 'orbital ingest has not run yet' };
  }
});

/* ------------------------------------------------------- event streaming */

/**
 * Detections are written by the worker, not by this process, so the API
 * learns about them via Postgres LISTEN rather than polling. One
 * notification, fanned out to every socket, with no query per client.
 */
async function listenForDetections(): Promise<void> {
  try {
    const client = await getPool().connect();
    await client.query('LISTEN deadreckon_event');
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        broadcastEvent(JSON.parse(msg.payload));
      } catch {
        /* malformed payload from a future version */
      }
    });
    app.log.info('listening on channel deadreckon_event');
  } catch (err) {
    app.log.warn(`LISTEN unavailable, falling back to poll: ${(err as Error).message}`);
    let lastSeen = Date.now();
    setInterval(() => {
      void (async () => {
        const rows = await recentDetections({ sinceMs: lastSeen, limit: 50 }).catch(
          () => [],
        );
        for (const d of rows) {
          broadcastEvent({
            kind: 'detection',
            id: d.id,
            rule: d.rule,
            severity: d.severity,
            lat: d.lat,
            lon: d.lon,
            geohash5: d.geohash5,
            title: d.title,
            ts: d.ts_start,
          });
        }
        if (rows.length) lastSeen = Math.max(...rows.map((r) => r.ts_start)) + 1;
      })();
    }, 5000).unref?.();
  }
}

/* ------------------------------------------------------------------ boot */

const stopHub = startHub();

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
app.server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/stream')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
});

const shutdown = async (sig: string): Promise<void> => {
  app.log.info(`${sig} -- closing`);
  stopHub();
  wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: PORT, host: HOST });
  await listenForDetections();
  app.log.info(`DEADRECKON api on :${PORT} -- ws at /stream`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
