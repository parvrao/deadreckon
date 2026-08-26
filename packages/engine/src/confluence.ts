/**
 * DEADRECKON :: CONFLUENCE.
 *
 * The whole thesis of open-source intelligence is that no single feed
 * means anything and all of them together mean a great deal. Everyone
 * agrees with that. Almost nobody automates it -- the fusion step is
 * traditionally a human with six browser tabs and a weekend.
 *
 * CONFLUENCE is that step as a rule.
 *
 * It clusters independent detections that agree in space and time, and
 * only escalates when the agreement comes from DIFFERENT sensing
 * modalities. Two aircraft squawking is a coincidence. An airspace void,
 * a GNSS bloom and a shallow seismic event inside the same 150 km and
 * ninety minutes is a sequence of events, and the ordering of them is
 * itself the finding.
 *
 * Corroboration across independent modalities is the only cheap defence
 * against a single bad feed inventing a war. Requiring >= 2 domains is
 * therefore a correctness property, not a tuning knob.
 */

import {
  DOMAIN_NAME,
  geohashEncode,
  haversineM,
  type Detection,
  type DomainCode,
  type Incident,
} from '@deadreckon/core';
import { detectionHash } from '@deadreckon/core/provenance';
import { unlinkedDetections, upsertIncident, type DetectionRow } from '@deadreckon/store';

/** Which sensing modality each rule actually rests on. */
const RULE_DOMAIN: Record<string, DomainCode> = {
  DARK_VESSEL: 2,
  SPOOF_DISCONTINUITY: 2,
  RENDEZVOUS: 2,
  AIRSPACE_VOID: 1,
  GNSS_BLOOM: 1,
  SQUAWK_EMERGENCY: 1,
  LOITER: 1,
  THERMAL_ANOMALY: 5,
  SEISMIC_SHALLOW: 4,
};

/**
 * How much a rule contributes to an incident, independent of its own
 * severity. A GNSS bloom is a strong indicator of deliberate activity;
 * a single emergency squawk usually is not.
 */
const RULE_WEIGHT: Record<string, number> = {
  GNSS_BLOOM: 1.35,
  AIRSPACE_VOID: 1.3,
  SPOOF_DISCONTINUITY: 1.25,
  SEISMIC_SHALLOW: 1.15,
  THERMAL_ANOMALY: 1.1,
  RENDEZVOUS: 1.0,
  DARK_VESSEL: 0.95,
  LOITER: 0.9,
  SQUAWK_EMERGENCY: 0.8,
};

export interface ConfluenceOpts {
  /** Cluster radius. 150 km is roughly one theatre of operations. */
  radiusKm?: number;
  /** Cluster window. */
  windowMs?: number;
  /** Lookback for unabsorbed detections. */
  lookbackMs?: number;
  /** Floor for escalation. */
  minSeverity?: number;
}

export async function runConfluence(
  now: number,
  opts: ConfluenceOpts = {},
): Promise<Incident[]> {
  const radiusKm = opts.radiusKm ?? 150;
  const windowMs = opts.windowMs ?? 90 * 60_000;
  const lookbackMs = opts.lookbackMs ?? 6 * 3600_000;
  const minSeverity = opts.minSeverity ?? 55;

  const rows = await unlinkedDetections(now - lookbackMs);
  if (rows.length < 2) return [];

  const clusters = cluster(rows, radiusKm * 1000, windowMs);
  const out: Incident[] = [];

  for (const c of clusters) {
    if (c.length < 2) continue;

    const domains = new Set<DomainCode>();
    const rules = new Set<string>();
    for (const d of c) {
      rules.add(d.rule);
      const dom = RULE_DOMAIN[d.rule];
      if (dom) domains.add(dom);
    }

    // The corroboration gate. Three dark vessels are a fishing fleet.
    if (domains.size < 2) continue;

    const severity = scoreCluster(c, domains.size);
    if (severity < minSeverity) continue;

    const inc = buildIncident(c, severity, [...domains], radiusKm);
    const id = await upsertIncident(inc);
    out.push({ ...inc, id });
  }
  return out;
}

/* ------------------------------------------------------------ clustering */

/**
 * Single-linkage clustering in a space-time metric. Union-find over pairs
 * that are within BOTH the spatial and temporal thresholds.
 *
 * Detection volume in a lookback window is in the hundreds, so the
 * quadratic pass is cheap and exact. If that ever stops being true, the
 * fix is a geohash pre-bucket, not a fancier algorithm.
 */
export function cluster(
  rows: DetectionRow[],
  radiusM: number,
  windowMs: number,
): DetectionRow[][] {
  const n = rows.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const nx = parent[x]!;
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (Math.abs(a.ts_start - b.ts_start) > windowMs) continue;
      if (haversineM(a.lat, a.lon, b.lat, b.lon) > radiusM) continue;
      union(i, j);
    }
  }

  const groups = new Map<number, DetectionRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(rows[i]!);
  }
  return [...groups.values()];
}

/**
 * Severity is NOT the max, and NOT the mean.
 *
 * Max ignores corroboration; mean punishes it (adding a weak third
 * witness would lower the score, which is absurd). So: take the strongest
 * signal, then add a decaying contribution from each additional one, then
 * multiply by how many independent modalities agree.
 */
export function scoreCluster(c: DetectionRow[], domainCount: number): number {
  const weighted = c
    .map((d) => d.severity * (RULE_WEIGHT[d.rule] ?? 1))
    .sort((a, b) => b - a);

  let score = weighted[0] ?? 0;
  for (let i = 1; i < weighted.length; i++) {
    score += weighted[i]! * Math.pow(0.45, i);
  }
  const diversity = 1 + 0.16 * (domainCount - 1);
  return Math.min(100, Math.round(score * diversity * 0.72));
}

/* -------------------------------------------------------------- narrative */

function buildIncident(
  c: DetectionRow[],
  severity: number,
  domains: DomainCode[],
  radiusKm: number,
): Incident {
  const ordered = [...c].sort((a, b) => a.ts_start - b.ts_start);
  const tsStart = ordered[0]!.ts_start;
  const tsEnd = Math.max(...ordered.map((d) => d.ts_end ?? d.ts_start));

  // Centroid weighted by severity: the incident sits where the strongest
  // evidence is, not at the arithmetic middle of unrelated noise.
  let wSum = 0;
  let lat = 0;
  let lon = 0;
  for (const d of ordered) {
    const w = Math.max(1, d.severity);
    lat += d.lat * w;
    lon += d.lon * w;
    wSum += w;
  }
  lat /= wSum;
  lon /= wSum;

  const spreadKm =
    Math.max(...ordered.map((d) => haversineM(lat, lon, d.lat, d.lon))) / 1000;

  const lead = ordered.reduce((a, b) => (b.severity > a.severity ? b : a));
  const place = describePlace(ordered, lat, lon);
  const title = `${domains.length}-domain confluence over ${place}: ${headline(lead.rule)}`;

  const narrative = writeNarrative(ordered, tsStart, domains, severity, spreadKm);

  return {
    tsStart,
    tsEnd,
    lat,
    lon,
    radiusKm: Math.max(1, Math.round(spreadKm)),
    severity,
    title,
    narrative,
    detectionIds: ordered.map((d) => d.id),
    domains,
    state: 'open',
    // Hash over the member detection hashes: the same set of facts always
    // produces the same incident, so re-running the pass updates rather
    // than duplicates.
    hash: detectionHash({
      rule: 'CONFLUENCE',
      tsStart,
      entityIds: ordered.map((d) => d.hash).sort(),
      lat,
      lon,
      evidence: { radiusKm: Math.round(radiusKm) },
    }),
  };
}

/**
 * Deterministic prose. No model call, no API key, no nondeterminism, and
 * nothing in the narrative that is not directly derived from a detection
 * already on the record.
 *
 * A language model could write this more elegantly. It could also write
 * something that is not true, and this text is the part a reader is most
 * likely to quote.
 */
function writeNarrative(
  ordered: DetectionRow[],
  tsStart: number,
  domains: DomainCode[],
  severity: number,
  spreadKm: number,
): string {
  const lines: string[] = [];

  lines.push(
    `${ordered.length} independent detections across ${domains.length} sensing ` +
      `domains (${domains.map((d) => DOMAIN_NAME[d]).join(', ')}) agree within ` +
      `${Math.round(spreadKm)} km and ` +
      `${Math.round((ordered[ordered.length - 1]!.ts_start - tsStart) / 60_000)} minutes. ` +
      `Composite severity ${severity}/100.`,
  );
  lines.push('');
  lines.push('SEQUENCE');

  for (const d of ordered) {
    const offset = (d.ts_start - tsStart) / 60_000;
    const stamp =
      offset < 1 ? 'T+0' : `T+${offset < 60 ? `${Math.round(offset)}m` : `${(offset / 60).toFixed(1)}h`}`;
    lines.push(`  ${stamp.padEnd(8)} [${d.rule}] ${d.title}`);
  }

  lines.push('');
  lines.push('WHAT THIS IS NOT');
  lines.push(
    '  Correlation in space and time. No causal claim is made, no source is ' +
      'named as authoritative, and every constituent detection is auditable ' +
      'to the HTTP response it came from via its provenance chain.',
  );

  return lines.join('\n');
}

function headline(rule: string): string {
  switch (rule) {
    case 'AIRSPACE_VOID':
      return 'commercial traffic cleared the area';
    case 'GNSS_BLOOM':
      return 'navigation interference across the fleet';
    case 'SPOOF_DISCONTINUITY':
      return 'a hull reappeared where it could not be';
    case 'DARK_VESSEL':
      return 'a vessel went dark and returned off-envelope';
    case 'RENDEZVOUS':
      return 'vessels alongside at sea';
    case 'SEISMIC_SHALLOW':
      return 'a shallow seismic release';
    case 'THERMAL_ANOMALY':
      return 'a high-energy thermal signature';
    case 'LOITER':
      return 'sustained aerial orbit';
    case 'SQUAWK_EMERGENCY':
      return 'an emergency transponder code';
    default:
      return rule.toLowerCase().replace(/_/g, ' ');
  }
}

/** Prefer a named watchbox from the evidence over a bare cell code. */
function describePlace(rows: DetectionRow[], lat: number, lon: number): string {
  for (const r of rows) {
    const wb = (r.evidence as Record<string, unknown>)?.watchbox;
    if (typeof wb === 'string' && wb) return wb.replace(/_/g, ' ');
  }
  return `${Math.abs(lat).toFixed(1)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}${
    lon >= 0 ? 'E' : 'W'
  } (${geohashEncode(lat, lon, 4)})`;
}

export type { Detection };
