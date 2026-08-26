/**
 * DEADRECKON :: binary wire protocol.
 *
 * Why this exists, concretely:
 *
 *   One aircraft as JSON  ~ 118 bytes
 *   One aircraft as DRWP  =  28 bytes, fixed
 *
 * At 12,000 tracked entities and a 1 Hz tick that is 1.35 MB/s per viewer
 * versus 328 KB/s -- before gzip, and gzip cannot help a JSON stream that
 * changes every field every second. Entity IDs are interned once and then
 * referenced by u32, so the repeated-string tax is paid a single time.
 *
 * Zero dependencies, zero Buffer, runs identically in Node and the browser.
 *
 * Control messages stay JSON text frames. Only the hot path is binary --
 * optimizing the handshake would be a waste of everyone's afternoon.
 */

export const MAGIC = 0xd2;
export const VERSION = 0x01;

export const Msg = {
  HELLO: 0x01, // srv -> cli, JSON
  STRINGS: 0x02, // srv -> cli, BINARY  id interning table
  POSITIONS: 0x03, // srv -> cli, BINARY  the hot path
  REMOVE: 0x04, // srv -> cli, BINARY  refs that left the viewport
  EVENT: 0x05, // srv -> cli, JSON    detection / incident
  STATS: 0x06, // srv -> cli, JSON
  SUBSCRIBE: 0x10, // cli -> srv, JSON
  SEEK: 0x11, // cli -> srv, JSON    replay control
  PING: 0x12,
} as const;

export const FrameFlag = {
  NONE: 0,
  FULL_SNAPSHOT: 1 << 0,
  REPLAY: 1 << 1,
} as const;

export const HEADER_BYTES = 20;
export const RECORD_BYTES = 28;
export const U16_UNKNOWN = 0xffff;

export interface WireRecord {
  ref: number;
  domain: number;
  kind: number;
  flags: number;
  lat: number;
  lon: number;
  altM: number;
  cogDeg: number | null;
  sogKt: number | null;
  ageS: number;
  conf: number;
}

export interface PositionFrame {
  seq: number;
  frameTimeMs: number;
  flags: number;
  records: WireRecord[];
}

/* ------------------------------------------------------------------ */
/* POSITIONS                                                           */
/* ------------------------------------------------------------------ */

export function encodePositions(
  seq: number,
  frameTimeMs: number,
  records: readonly WireRecord[],
  flags: number = FrameFlag.NONE,
): Uint8Array {
  const buf = new ArrayBuffer(HEADER_BYTES + records.length * RECORD_BYTES);
  const dv = new DataView(buf);

  dv.setUint8(0, MAGIC);
  dv.setUint8(1, VERSION);
  dv.setUint8(2, Msg.POSITIONS);
  dv.setUint8(3, flags);
  dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, frameTimeMs, true);
  dv.setUint32(16, records.length, true);

  let o = HEADER_BYTES;
  for (const r of records) {
    dv.setUint32(o, r.ref >>> 0, true);
    dv.setUint8(o + 4, r.domain & 0xff);
    dv.setUint8(o + 5, r.kind & 0xff);
    dv.setUint16(o + 6, r.flags & 0xffff, true);
    dv.setFloat32(o + 8, r.lat, true);
    dv.setFloat32(o + 12, r.lon, true);
    dv.setFloat32(o + 16, r.altM, true);
    dv.setUint16(
      o + 20,
      r.cogDeg == null ? U16_UNKNOWN : clampU16(Math.round(r.cogDeg * 10)),
      true,
    );
    dv.setUint16(
      o + 22,
      r.sogKt == null ? U16_UNKNOWN : clampU16(Math.round(r.sogKt * 10)),
      true,
    );
    dv.setUint16(o + 24, clampU16(Math.round(r.ageS * 10)), true);
    dv.setUint8(o + 26, clampU8(r.conf));
    dv.setUint8(o + 27, 0);
    o += RECORD_BYTES;
  }
  return new Uint8Array(buf);
}

export function decodePositions(bytes: ArrayBuffer | Uint8Array): PositionFrame {
  const { dv, base } = view(bytes);
  assertHeader(dv, base, Msg.POSITIONS);

  const flags = dv.getUint8(base + 3);
  const seq = dv.getUint32(base + 4, true);
  const frameTimeMs = dv.getFloat64(base + 8, true);
  const count = dv.getUint32(base + 16, true);

  const records: WireRecord[] = new Array(count);
  let o = base + HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const cog = dv.getUint16(o + 20, true);
    const sog = dv.getUint16(o + 22, true);
    records[i] = {
      ref: dv.getUint32(o, true),
      domain: dv.getUint8(o + 4),
      kind: dv.getUint8(o + 5),
      flags: dv.getUint16(o + 6, true),
      lat: dv.getFloat32(o + 8, true),
      lon: dv.getFloat32(o + 12, true),
      altM: dv.getFloat32(o + 16, true),
      cogDeg: cog === U16_UNKNOWN ? null : cog / 10,
      sogKt: sog === U16_UNKNOWN ? null : sog / 10,
      ageS: dv.getUint16(o + 24, true) / 10,
      conf: dv.getUint8(o + 26),
    };
    o += RECORD_BYTES;
  }
  return { seq, frameTimeMs, flags, records };
}

/**
 * Decode straight into typed arrays for deck.gl binary attributes.
 * Skips building `count` throwaway objects per tick, which at 12k entities
 * and 1 Hz is the difference between a smooth console and a GC sawtooth.
 */
export interface PositionColumns {
  seq: number;
  frameTimeMs: number;
  flags: number;
  count: number;
  refs: Uint32Array;
  /** Interleaved [lon, lat, lon, lat, ...] -- deck.gl's expected order. */
  positions: Float32Array;
  altM: Float32Array;
  domains: Uint8Array;
  kinds: Uint8Array;
  entFlags: Uint16Array;
  cogDeci: Uint16Array;
  sogDeci: Uint16Array;
}

export function decodePositionColumns(
  bytes: ArrayBuffer | Uint8Array,
): PositionColumns {
  const { dv, base } = view(bytes);
  assertHeader(dv, base, Msg.POSITIONS);

  const flags = dv.getUint8(base + 3);
  const seq = dv.getUint32(base + 4, true);
  const frameTimeMs = dv.getFloat64(base + 8, true);
  const count = dv.getUint32(base + 16, true);

  const refs = new Uint32Array(count);
  const positions = new Float32Array(count * 2);
  const altM = new Float32Array(count);
  const domains = new Uint8Array(count);
  const kinds = new Uint8Array(count);
  const entFlags = new Uint16Array(count);
  const cogDeci = new Uint16Array(count);
  const sogDeci = new Uint16Array(count);

  let o = base + HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    refs[i] = dv.getUint32(o, true);
    domains[i] = dv.getUint8(o + 4);
    kinds[i] = dv.getUint8(o + 5);
    entFlags[i] = dv.getUint16(o + 6, true);
    positions[i * 2 + 1] = dv.getFloat32(o + 8, true); // lat
    positions[i * 2] = dv.getFloat32(o + 12, true); // lon
    altM[i] = dv.getFloat32(o + 16, true);
    cogDeci[i] = dv.getUint16(o + 20, true);
    sogDeci[i] = dv.getUint16(o + 22, true);
    o += RECORD_BYTES;
  }

  return {
    seq,
    frameTimeMs,
    flags,
    count,
    refs,
    positions,
    altM,
    domains,
    kinds,
    entFlags,
    cogDeci,
    sogDeci,
  };
}

/* ------------------------------------------------------------------ */
/* STRINGS -- entity id interning                                      */
/* ------------------------------------------------------------------ */

export interface StringEntry {
  ref: number;
  id: string;
  label: string;
}

const TE = new TextEncoder();
const TD = new TextDecoder();

export function encodeStrings(seq: number, entries: readonly StringEntry[]): Uint8Array {
  const encoded = entries.map((e) => ({
    ref: e.ref,
    id: TE.encode(e.id),
    label: TE.encode(e.label ?? ''),
  }));
  let size = HEADER_BYTES;
  for (const e of encoded) size += 8 + e.id.length + e.label.length;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint8(0, MAGIC);
  dv.setUint8(1, VERSION);
  dv.setUint8(2, Msg.STRINGS);
  dv.setUint8(3, 0);
  dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, Date.now(), true);
  dv.setUint32(16, encoded.length, true);

  let o = HEADER_BYTES;
  for (const e of encoded) {
    dv.setUint32(o, e.ref >>> 0, true);
    dv.setUint16(o + 4, e.id.length, true);
    dv.setUint16(o + 6, e.label.length, true);
    o += 8;
    u8.set(e.id, o);
    o += e.id.length;
    u8.set(e.label, o);
    o += e.label.length;
  }
  return u8;
}

export function decodeStrings(bytes: ArrayBuffer | Uint8Array): StringEntry[] {
  const { dv, base, u8 } = view(bytes);
  assertHeader(dv, base, Msg.STRINGS);

  const count = dv.getUint32(base + 16, true);
  const out: StringEntry[] = new Array(count);

  let o = base + HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const ref = dv.getUint32(o, true);
    const idLen = dv.getUint16(o + 4, true);
    const labelLen = dv.getUint16(o + 6, true);
    o += 8;
    const id = TD.decode(u8.subarray(o, o + idLen));
    o += idLen;
    const label = TD.decode(u8.subarray(o, o + labelLen));
    o += labelLen;
    out[i] = { ref, id, label };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* REMOVE                                                              */
/* ------------------------------------------------------------------ */

export function encodeRemove(seq: number, refs: readonly number[]): Uint8Array {
  const buf = new ArrayBuffer(HEADER_BYTES + refs.length * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, MAGIC);
  dv.setUint8(1, VERSION);
  dv.setUint8(2, Msg.REMOVE);
  dv.setUint8(3, 0);
  dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, Date.now(), true);
  dv.setUint32(16, refs.length, true);
  let o = HEADER_BYTES;
  for (const r of refs) {
    dv.setUint32(o, r >>> 0, true);
    o += 4;
  }
  return new Uint8Array(buf);
}

export function decodeRemove(bytes: ArrayBuffer | Uint8Array): number[] {
  const { dv, base } = view(bytes);
  assertHeader(dv, base, Msg.REMOVE);
  const count = dv.getUint32(base + 16, true);
  const out: number[] = new Array(count);
  let o = base + HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    out[i] = dv.getUint32(o, true);
    o += 4;
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** Peek the message type without decoding the body. */
export function frameType(bytes: ArrayBuffer | Uint8Array): number {
  const { dv, base } = view(bytes);
  if (dv.getUint8(base) !== MAGIC) return 0;
  return dv.getUint8(base + 2);
}

function view(bytes: ArrayBuffer | Uint8Array): {
  dv: DataView;
  base: number;
  u8: Uint8Array;
} {
  if (bytes instanceof Uint8Array) {
    return {
      dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      base: 0,
      u8: bytes,
    };
  }
  return { dv: new DataView(bytes), base: 0, u8: new Uint8Array(bytes) };
}

function assertHeader(dv: DataView, base: number, expect: number): void {
  if (dv.getUint8(base) !== MAGIC) throw new Error('DRWP: bad magic');
  const v = dv.getUint8(base + 1);
  if (v !== VERSION) throw new Error(`DRWP: unsupported version ${v}`);
  const t = dv.getUint8(base + 2);
  if (t !== expect) throw new Error(`DRWP: expected msg ${expect}, got ${t}`);
}

function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65534 ? 65534 : v | 0;
}

function clampU8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Reporting helper for the STATS panel. Sells the architecture at a glance. */
export function wireSavings(entityCount: number): {
  binaryBytes: number;
  jsonBytes: number;
  ratio: number;
} {
  const binaryBytes = HEADER_BYTES + entityCount * RECORD_BYTES;
  const jsonBytes = entityCount * 118; // measured mean for a full ADS-B row
  return { binaryBytes, jsonBytes, ratio: jsonBytes / Math.max(1, binaryBytes) };
}
