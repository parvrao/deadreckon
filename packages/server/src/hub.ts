/**
 * DEADRECKON :: fan-out hub.
 *
 * This file is the scalability argument.
 *
 * The naive design -- and the one most live-map projects ship -- has every
 * browser hit the upstream APIs directly, or hit a proxy that re-fetches
 * per request. Cost is O(viewers x sources). The moment the project goes
 * viral it gets rate-limited into oblivion by the exact traffic that made
 * it worth building.
 *
 * Here:
 *
 *   ONE query per tick, shared by every connected socket.
 *   The result is bucketed by geohash cell once.
 *   Each socket reads only its own cells out of that shared index.
 *   Each socket receives only what CHANGED since its last frame.
 *
 * Upstream cost is constant in viewers. Database cost is constant in
 * viewers. Only the per-socket diff scales, and it scales with viewport
 * size rather than with world size.
 *
 * Per-socket state is deliberately small: a Map of entityId -> ref and a
 * Map of ref -> lastSentAt. At 5k entities in view that is well under a
 * megabyte, so a free 512 MB instance holds hundreds of sockets.
 */

import type { WebSocket } from 'ws';
import {
  DOMAIN_BY_NAME,
  Msg,
  FrameFlag,
  cellsForBounds,
  encodePositions,
  encodeRemove,
  encodeStrings,
  precisionForBounds,
  wireSavings,
  type Bounds,
  type WireRecord,
} from '@deadreckon/core';
import { entitiesInCells, snapshotAt, type EntityRow } from '@deadreckon/store';

const TICK_MS = Number(process.env.FANOUT_TICK_MS) || 1000;
const MAX_CELLS = Number(process.env.MAX_CELLS_PER_SOCKET) || 512;
const MAX_ENTITIES_PER_SOCKET = 8000;
const LIVE_MAX_AGE_S = 900;
/** Do not resend a position that has not moved and is not stale. */
const RESEND_AFTER_MS = 20_000;

interface Client {
  id: number;
  ws: WebSocket;
  cells: string[];
  domains: number[];
  /** entityId -> ref, assigned per socket so refs stay small. */
  refs: Map<string, number>;
  /** ref -> [lastSeenTs, lastSentAtMs] */
  sent: Map<number, [number, number]>;
  nextRef: number;
  seq: number;
  /** Non-null when the client is scrubbing history rather than watching live. */
  replayAt: number | null;
  bytesOut: number;
  framesOut: number;
  connectedAt: number;
  alive: boolean;
}

let clientSeq = 0;
const clients = new Map<number, Client>();

/** Shared snapshot, rebuilt once per tick regardless of client count. */
let cellIndex = new Map<string, EntityRow[]>();
let snapshotAtMs = 0;
let lastTickMs = 0;
let lastTickEntities = 0;

/* ------------------------------------------------------------- lifecycle */

export function attach(ws: WebSocket): void {
  const c: Client = {
    id: ++clientSeq,
    ws,
    cells: [],
    domains: [1, 2, 4, 5],
    refs: new Map(),
    sent: new Map(),
    nextRef: 1,
    seq: 0,
    replayAt: null,
    bytesOut: 0,
    framesOut: 0,
    connectedAt: Date.now(),
    alive: true,
  };
  clients.set(c.id, c);

  sendJson(c, {
    type: Msg.HELLO,
    clientId: c.id,
    tickMs: TICK_MS,
    maxCells: MAX_CELLS,
    protocol: 'DRWP/1',
    note:
      'Subscribe with {type:16,bbox:{minLat,minLon,maxLat,maxLon},domains:["air","sea"]}. ' +
      'Positions arrive as binary frames; everything else is JSON.',
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handle(c, msg);
  });

  ws.on('pong', () => {
    c.alive = true;
  });
  ws.on('close', () => clients.delete(c.id));
  ws.on('error', () => clients.delete(c.id));
}

function handle(c: Client, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case Msg.SUBSCRIBE: {
      const bbox = msg.bbox as Bounds | undefined;
      if (!bbox || !Number.isFinite(bbox.minLat)) return;

      // The client does not get to choose how many cells it costs us.
      const precision = precisionForBounds(bbox, 256);
      c.cells = cellsForBounds(bbox, precision, MAX_CELLS);

      const names = Array.isArray(msg.domains) ? (msg.domains as string[]) : null;
      c.domains = names
        ? names.map((n) => DOMAIN_BY_NAME[n] ?? 0).filter(Boolean)
        : [1, 2, 4, 5];
      if (!c.domains.length) c.domains = [1, 2, 4, 5];

      // Viewport changed: forget what we thought it had, resend fresh.
      c.refs.clear();
      c.sent.clear();
      c.nextRef = 1;

      sendJson(c, {
        type: Msg.STATS,
        subscribed: { cells: c.cells.length, precision, domains: c.domains },
      });
      break;
    }

    case Msg.SEEK: {
      const at = Number(msg.at);
      c.replayAt = Number.isFinite(at) && at > 0 ? at : null;
      c.refs.clear();
      c.sent.clear();
      c.nextRef = 1;
      sendJson(c, { type: Msg.STATS, replayAt: c.replayAt });
      break;
    }

    case Msg.PING:
      sendJson(c, { type: Msg.PING, t: Date.now() });
      break;
  }
}

/* ------------------------------------------------------------------ tick */

export function startHub(): () => void {
  const timer = setInterval(() => void tick(), TICK_MS);
  const pinger = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(c.id);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        clients.delete(c.id);
      }
    }
  }, 30_000);

  return () => {
    clearInterval(timer);
    clearInterval(pinger);
  };
}

async function tick(): Promise<void> {
  if (clients.size === 0) {
    cellIndex = new Map();
    return;
  }
  const t0 = Date.now();

  // The union of every client's interest. One query covers all of them.
  const wanted = new Set<string>();
  const domains = new Set<number>();
  let anyLive = false;
  for (const c of clients.values()) {
    if (c.replayAt == null) {
      anyLive = true;
      for (const cell of c.cells) wanted.add(cell);
      for (const d of c.domains) domains.add(d);
    }
  }

  if (anyLive && wanted.size) {
    try {
      const rows = await entitiesInCells(
        [...wanted],
        [...domains],
        LIVE_MAX_AGE_S,
        40_000,
      );
      cellIndex = indexByCell(rows);
      snapshotAtMs = Date.now();
      lastTickEntities = rows.length;
    } catch (err) {
      console.error('[hub] snapshot query failed:', (err as Error).message);
      return;
    }
  }

  for (const c of clients.values()) {
    try {
      await pushTo(c);
    } catch (err) {
      console.error(`[hub] push to client ${c.id} failed:`, (err as Error).message);
    }
  }
  lastTickMs = Date.now() - t0;
}

function indexByCell(rows: EntityRow[]): Map<string, EntityRow[]> {
  const idx = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const cell = r.geohash5;
    const list = idx.get(cell);
    if (list) list.push(r);
    else idx.set(cell, [r]);
  }
  return idx;
}

async function pushTo(c: Client): Promise<void> {
  if (c.ws.readyState !== 1 || !c.cells.length) return;

  // A scrubbing client reads the archive; it does not share the live index.
  const rows: EntityRow[] =
    c.replayAt != null
      ? await snapshotAt(c.replayAt, c.cells, c.domains, 180, MAX_ENTITIES_PER_SOCKET)
      : gatherLive(c);

  const now = Date.now();
  const frameTime = c.replayAt ?? snapshotAtMs ?? now;

  const newStrings: { ref: number; id: string; label: string }[] = [];
  const records: WireRecord[] = [];
  const seenRefs = new Set<number>();

  for (const r of rows) {
    let ref = c.refs.get(r.entity_id);
    if (ref === undefined) {
      ref = c.nextRef++;
      c.refs.set(r.entity_id, ref);
      newStrings.push({
        ref,
        id: r.entity_id,
        label: r.label ?? r.entity_id.split(':')[1] ?? r.entity_id,
      });
    }
    seenRefs.add(ref);

    // Delta gate: skip anything whose fix has not advanced and which we
    // sent recently. This is where most of the bandwidth saving lives --
    // a stationary vessel costs nothing at all after the first frame.
    const prior = c.sent.get(ref);
    if (prior && prior[0] === r.last_seen && now - prior[1] < RESEND_AFTER_MS) {
      continue;
    }
    c.sent.set(ref, [r.last_seen, now]);

    records.push({
      ref,
      domain: r.domain,
      kind: kindCode(r.kind),
      flags: r.flags,
      lat: r.last_lat,
      lon: r.last_lon,
      altM: r.last_alt_m ?? 0,
      cogDeg: r.last_cog_deg,
      sogKt: r.last_sog_kt,
      ageS: Math.max(0, (frameTime - r.last_seen) / 1000),
      conf: 200,
    });
  }

  // Anything we had that is no longer in view or no longer live.
  const gone: number[] = [];
  for (const ref of c.sent.keys()) {
    if (!seenRefs.has(ref)) gone.push(ref);
  }
  for (const ref of gone) c.sent.delete(ref);

  if (newStrings.length) sendBin(c, encodeStrings(++c.seq, newStrings));
  if (records.length) {
    const flags =
      (c.replayAt != null ? FrameFlag.REPLAY : 0) |
      (c.framesOut === 0 ? FrameFlag.FULL_SNAPSHOT : 0);
    sendBin(c, encodePositions(++c.seq, frameTime, records, flags));
  }
  if (gone.length) sendBin(c, encodeRemove(++c.seq, gone));

  // Keep the per-socket ref table from growing without bound over hours.
  if (c.refs.size > MAX_ENTITIES_PER_SOCKET * 2) {
    c.refs.clear();
    c.sent.clear();
    c.nextRef = 1;
  }
}

function gatherLive(c: Client): EntityRow[] {
  const out: EntityRow[] = [];
  const want = new Set(c.domains);
  for (const cell of c.cells) {
    const list = cellIndex.get(cell);
    if (!list) continue;
    for (const r of list) {
      if (!want.has(r.domain)) continue;
      out.push(r);
      if (out.length >= MAX_ENTITIES_PER_SOCKET) return out;
    }
  }
  return out;
}

/* ------------------------------------------------------------ broadcast */

/** Push a detection or incident to every socket whose viewport contains it. */
export function broadcastEvent(evt: {
  kind: 'detection' | 'incident';
  id: number;
  rule?: string;
  severity: number;
  lat: number;
  lon: number;
  geohash5: string;
  title: string;
  ts: number;
}): void {
  for (const c of clients.values()) {
    // High-severity findings reach everyone, in view or not. If the world
    // is on fire outside your viewport you should still be told.
    if (evt.severity < 70 && !c.cells.some((cell) => evt.geohash5.startsWith(cell))) {
      continue;
    }
    sendJson(c, { type: Msg.EVENT, ...evt });
  }
}

/* --------------------------------------------------------------- helpers */

function sendJson(c: Client, obj: unknown): void {
  if (c.ws.readyState !== 1) return;
  const s = JSON.stringify(obj);
  c.bytesOut += s.length;
  c.framesOut++;
  try {
    c.ws.send(s);
  } catch {
    clients.delete(c.id);
  }
}

function sendBin(c: Client, bytes: Uint8Array): void {
  if (c.ws.readyState !== 1) return;
  // Backpressure: if the socket is already 4 MB behind, drop the frame
  // rather than buffering. A late position is worthless; an OOM is fatal.
  if (c.ws.bufferedAmount > 4_000_000) return;
  c.bytesOut += bytes.byteLength;
  c.framesOut++;
  try {
    c.ws.send(bytes, { binary: true });
  } catch {
    clients.delete(c.id);
  }
}

const KIND_CODES: Record<string, number> = {
  tanker: 1,
  cargo: 2,
  passenger: 3,
  'high speed craft': 4,
  fishing: 5,
  tug: 6,
  military: 7,
  sailing: 8,
  'pleasure craft': 9,
  earthquake: 20,
  thermal_anomaly: 21,
};

function kindCode(kind: string | null): number {
  if (!kind) return 0;
  return KIND_CODES[kind.toLowerCase()] ?? 0;
}

export function hubStats() {
  let bytes = 0;
  let tracked = 0;
  for (const c of clients.values()) {
    bytes += c.bytesOut;
    tracked += c.sent.size;
  }
  const savings = wireSavings(lastTickEntities);
  return {
    clients: clients.size,
    tickMs: lastTickMs,
    tickBudgetMs: TICK_MS,
    entitiesInSharedSnapshot: lastTickEntities,
    cellsIndexed: cellIndex.size,
    trackedAcrossClients: tracked,
    bytesOutTotal: bytes,
    /** Upstream fetches caused by these clients. Always zero. That is the point. */
    upstreamFetchesCausedByClients: 0,
    wire: {
      binaryBytesPerFullFrame: savings.binaryBytes,
      jsonBytesPerFullFrame: savings.jsonBytes,
      compressionRatio: +savings.ratio.toFixed(2),
    },
  };
}
