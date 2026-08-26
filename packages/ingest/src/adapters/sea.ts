/**
 * DEADRECKON :: sea domain.
 *
 * aisstream.io is a push feed, not a poll feed -- which is exactly right
 * for dark-vessel work. A poll can only tell you a ship was absent from
 * the last snapshot. A stream tells you the instant it stopped talking.
 *
 * Operational realities this handles:
 *   - the socket WILL drop; reconnect with backoff or you lose the night
 *   - AIS delivers duplicates and out-of-order fixes; we coalesce per MMSI
 *     and let the DB's GREATEST() guard sort out the rest
 *   - static data (name, type, flag) arrives on a different message type
 *     and far less often, so it is cached and merged onto position reports
 *   - a silent socket is worse than a closed one: if no message arrives
 *     for STALE_MS we tear it down ourselves rather than believe the sea
 *     went quiet
 */

import { WebSocket } from 'ws';
import { Domain, type Observation } from '@deadreckon/core';

export const SEA_PARSER_VERSION = 'sea/2';

const ENDPOINT = 'wss://stream.aisstream.io/v0/stream';
const STALE_MS = 90_000;
const MAX_BACKOFF_MS = 60_000;

export interface SeaStreamOpts {
  apiKey: string;
  /** [[[minLat,minLon],[maxLat,maxLon]], ...] */
  boundingBoxes: number[][][];
  onBatch: (obs: Observation[], rawSample: string) => void | Promise<void>;
  onStatus?: (s: { connected: boolean; note: string }) => void;
}

interface AisEnvelope {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
    time_utc?: string;
  };
  Message?: {
    PositionReport?: {
      UserID?: number;
      Latitude?: number;
      Longitude?: number;
      Cog?: number;
      Sog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
      RateOfTurn?: number;
    };
    ShipStaticData?: {
      UserID?: number;
      Name?: string;
      Type?: number;
      CallSign?: string;
      ImoNumber?: number;
      Destination?: string;
      MaximumStaticDraught?: number;
    };
  };
}

/** MMSI -> static attributes. Bounded so a long run cannot grow forever. */
const staticCache = new Map<
  number,
  { name?: string; type?: string; callSign?: string; imo?: number; dest?: string }
>();
const STATIC_CACHE_MAX = 60_000;

export class SeaStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 1000;
  private lastMessageAt = 0;
  private buffer: Observation[] = [];
  private lastRaw = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SeaStreamOpts) {}

  start(): void {
    this.closed = false;
    this.connect();
    // Batch DB writes on a 5s cadence. AIS can burst to thousands of
    // messages a second; one INSERT per message would melt the free tier.
    this.flushTimer = setInterval(() => void this.flush(), 5000);
    this.watchdog = setInterval(() => this.checkStale(), 20_000);
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    await this.flush();
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.note('connecting');

    const ws = new WebSocket(ENDPOINT, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      this.lastMessageAt = Date.now();
      ws.send(
        JSON.stringify({
          APIKey: this.opts.apiKey,
          BoundingBoxes: this.opts.boundingBoxes,
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
      this.opts.onStatus?.({ connected: true, note: 'subscribed' });
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      const text = data.toString();
      this.lastRaw = text;
      const env = parse(text);
      if (!env) return;
      const obs = toObservation(env);
      if (obs) this.buffer.push(obs);
      // Guard against an unbounded buffer if the DB is wedged.
      if (this.buffer.length > 50_000) this.buffer.splice(0, 20_000);
    });

    ws.on('error', (err) => {
      this.note(`socket error: ${(err as Error).message}`);
    });

    ws.on('close', (code) => {
      this.opts.onStatus?.({ connected: false, note: `closed ${code}` });
      this.ws = null;
      if (this.closed) return;
      const wait = Math.min(MAX_BACKOFF_MS, this.backoff) * (0.5 + Math.random());
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
      setTimeout(() => this.connect(), wait);
    });
  }

  /**
   * A socket that is open but silent is the dangerous failure mode: every
   * vessel would look like it went dark simultaneously and the engine
   * would emit thousands of false positives. Kill it and reconnect.
   */
  private checkStale(): void {
    if (this.closed || !this.ws) return;
    if (Date.now() - this.lastMessageAt > STALE_MS) {
      this.note(`no traffic for ${Math.round(STALE_MS / 1000)}s -- forcing reconnect`);
      try {
        this.ws.terminate();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  private async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];

    // Coalesce: keep only the newest fix per vessel in this window.
    const newest = new Map<string, Observation>();
    for (const o of batch) {
      const prev = newest.get(o.entityId);
      if (!prev || o.ts > prev.ts) newest.set(o.entityId, o);
    }

    try {
      await this.opts.onBatch([...newest.values()], this.lastRaw);
    } catch (err) {
      console.error('[sea] batch handler failed:', (err as Error).message);
    }
  }

  private note(n: string): void {
    console.log(`[sea] ${n}`);
    this.opts.onStatus?.({ connected: !!this.ws, note: n });
  }

  get healthy(): boolean {
    return !!this.ws && Date.now() - this.lastMessageAt < STALE_MS;
  }
}

function parse(text: string): AisEnvelope | null {
  try {
    return JSON.parse(text) as AisEnvelope;
  } catch {
    return null;
  }
}

function toObservation(env: AisEnvelope): Observation | null {
  const meta = env.MetaData;

  if (env.MessageType === 'ShipStaticData') {
    const s = env.Message?.ShipStaticData;
    const mmsi = s?.UserID ?? meta?.MMSI;
    if (!mmsi || !s) return null;
    if (staticCache.size > STATIC_CACHE_MAX) staticCache.clear();
    staticCache.set(mmsi, {
      name: clean(s.Name) ?? clean(meta?.ShipName),
      type: shipType(s.Type),
      callSign: clean(s.CallSign),
      imo: s.ImoNumber || undefined,
      dest: clean(s.Destination),
    });
    return null;
  }

  const p = env.Message?.PositionReport;
  if (!p) return null;

  const mmsi = p.UserID ?? meta?.MMSI;
  const lat = p.Latitude ?? meta?.latitude;
  const lon = p.Longitude ?? meta?.longitude;
  if (!mmsi || lat == null || lon == null) return null;
  // AIS uses 91/181 as "not available"; letting those through puts ghost
  // hulls at the poles and on the prime meridian.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;

  const ts = meta?.time_utc ? Date.parse(meta.time_utc) : Date.now();
  const cached = staticCache.get(mmsi);

  // Sog 102.3 is the AIS "unavailable" sentinel.
  const sog = p.Sog != null && p.Sog < 102 ? p.Sog : null;
  const cog = p.Cog != null && p.Cog < 360 ? p.Cog : null;

  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    domain: Domain.SEA,
    entityId: `sea:${mmsi}`,
    lat,
    lon,
    altM: null,
    sogKt: sog,
    cogDeg: cog,
    flags: 0,
    conf: 220,
    props: {
      label: cached?.name ?? clean(meta?.ShipName) ?? String(mmsi),
      kind: cached?.type ?? null,
      mmsi,
      imo: cached?.imo ?? null,
      callSign: cached?.callSign ?? null,
      destination: cached?.dest ?? null,
      navStatus: p.NavigationalStatus ?? null,
      heading: p.TrueHeading != null && p.TrueHeading < 360 ? p.TrueHeading : null,
    },
  };
}

function clean(s?: string): string | undefined {
  const t = s?.replace(/[@ ]+/g, '').trim();
  return t ? t : undefined;
}

/** ITU-R M.1371 ship-type codes, collapsed to the classes our kinematic
 *  profiles care about. Getting this wrong means the wrong speed ceiling
 *  and therefore the wrong verdict. */
function shipType(code?: number): string | undefined {
  if (code == null) return undefined;
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 40 && code <= 49) return 'high speed craft';
  if (code >= 50 && code <= 59) return 'special craft';
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32 || code === 52) return 'tug';
  if (code === 35) return 'military';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure craft';
  return `type ${code}`;
}
