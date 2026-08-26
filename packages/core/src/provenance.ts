/**
 * DEADRECKON :: provenance hash chain.
 *
 * Bilawal's own writeup names the unsolved problem: "so many of those
 * conflict depending on which journalistic outlet you look at."
 *
 * The fix is not better sources. It is making every single pixel on the
 * map trace back to a byte range in a specific HTTP response fetched at a
 * specific instant -- and making the archive tamper-evident so nobody
 * (including us) can quietly revise history after the fact.
 *
 *   chain[n] = sha256( chain[n-1] || sha256(payload[n]) )
 *
 * Publish the head hash and every prior record is frozen.
 */

import { createHash } from 'node:crypto';

export const GENESIS_SHA =
  '0000000000000000000000000000000000000000000000000000000000000000';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function chainNext(prevChainSha: string, payloadSha: string): string {
  return sha256(`${prevChainSha}${payloadSha}`);
}

/**
 * Canonical JSON: sorted keys, no insignificant whitespace, undefined
 * dropped. Two semantically identical objects must hash identically or
 * the whole chain is theatre.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue;
      out[k] = sortDeep(src[k]);
    }
    return out;
  }
  return v;
}

/** Stable, citable identifier for a detection. Same facts -> same hash. */
export function detectionHash(d: {
  rule: string;
  tsStart: number;
  entityIds: string[];
  lat: number;
  lon: number;
  evidence: Record<string, unknown>;
}): string {
  return sha256(
    canonicalize({
      rule: d.rule,
      tsStart: d.tsStart,
      entityIds: [...d.entityIds].sort(),
      lat: round6(d.lat),
      lon: round6(d.lon),
      evidence: d.evidence,
    }),
  );
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Walk a chain and report the first index where it breaks.
 * Called by GET /api/provenance/verify -- the audit is a public endpoint,
 * because an unverifiable integrity claim is worth nothing.
 */
export function verifyChain(
  records: { payloadSha: string; prevChainSha: string; chainSha: string }[],
): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  let prev = GENESIS_SHA;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.prevChainSha !== prev) {
      return {
        ok: false,
        brokenAt: i,
        reason: `prevChainSha mismatch: expected ${prev}, stored ${r.prevChainSha}`,
      };
    }
    const expect = chainNext(r.prevChainSha, r.payloadSha);
    if (expect !== r.chainSha) {
      return {
        ok: false,
        brokenAt: i,
        reason: `chainSha mismatch: recomputed ${expect}, stored ${r.chainSha}`,
      };
    }
    prev = r.chainSha;
  }
  return { ok: true };
}
