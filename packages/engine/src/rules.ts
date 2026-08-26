/**
 * DEADRECKON :: detection rules.
 *
 * The distinction that defines this product: a viewer renders what is
 * present. These rules fire on what is ABSENT, what is INCONSISTENT, and
 * what is OUT OF FAMILY -- without a human having been watching.
 *
 * Every rule returns fully-formed Detections carrying:
 *   - a content hash, so re-evaluating an overlapping window is idempotent
 *   - the provenance ids the finding rests on
 *   - an `evidence` blob the Case File renders verbatim
 *
 * A finding a reader cannot audit is an opinion. These are not opinions.
 */

import {
  Domain,
  ObsFlag,
  type Detection,
  type Observation,
  geohashEncode,
  geohashBounds,
  haversineM,
  bearingDeg,
  angleDelta,
  evaluateReacquisition,
  profileFor,
  reachableSet,
  reachableSetPolygon,
  KT_TO_MS,
} from '@deadreckon/core';
import { detectionHash } from '@deadreckon/core/provenance';
import {
  baselinesFor,
  closeGap,
  findNewlyDark,
  openGap,
  openGapsFor,
  trackFor,
  type EntityRow,
} from '@deadreckon/store';

export interface RuleCtx {
  now: number;
  /** Observations ingested on this tick. */
  batch: readonly Observation[];
  /** Provenance ids backing this tick. */
  provenanceIds: number[];
  watchboxes: WatchboxRow[];
}

export interface WatchboxRow {
  key: string;
  label: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
  dark_threshold_s: number;
}

function mk(
  d: Omit<Detection, 'hash' | 'geohash5' | 'state'> & { state?: Detection['state'] },
): Detection {
  return {
    ...d,
    state: d.state ?? 'open',
    geohash5: geohashEncode(d.lat, d.lon, 5),
    hash: detectionHash({
      rule: d.rule,
      tsStart: d.tsStart,
      entityIds: d.entityIds,
      lat: d.lat,
      lon: d.lon,
      evidence: d.evidence,
    }),
  };
}

function inBox(lat: number, lon: number, b: WatchboxRow): boolean {
  return lat >= b.min_lat && lat <= b.max_lat && lon >= b.min_lon && lon <= b.max_lon;
}

function boxFor(lat: number, lon: number, boxes: readonly WatchboxRow[]) {
  return boxes.find((b) => inBox(lat, lon, b));
}

/* =================================================================== */
/* 1 + 2. GOING DARK, AND COMING BACK                                  */
/* =================================================================== */

/**
 * Phase one: open a gap when a target stops reporting.
 *
 * No detection is emitted here. A vessel going quiet is common -- coverage
 * is patchy, receivers fail, and crying wolf on every silence would make
 * the ticker worthless. We only record that the clock started.
 *
 * Inside a watchbox the threshold tightens, because in the Strait of
 * Hormuz coverage is dense and silence is a decision, not an accident.
 */
export async function scanGoingDark(ctx: RuleCtx): Promise<number> {
  const DEFAULT_DARK_S = 3600;
  const MAX_AGE_S = 36 * 3600;
  let opened = 0;

  for (const domain of [Domain.SEA, Domain.AIR] as const) {
    const dark = await findNewlyDark(domain, DEFAULT_DARK_S / 2, MAX_AGE_S, 400);
    for (const e of dark) {
      const box = boxFor(e.last_lat, e.last_lon, ctx.watchboxes);
      const threshold = box ? box.dark_threshold_s : DEFAULT_DARK_S;
      if (ctx.now - e.last_seen < threshold * 1000) continue;
      // A moored ship is not a dark ship.
      if (domain === Domain.SEA && (e.last_sog_kt ?? 0) < 0.4) continue;
      if (domain === Domain.AIR && (e.flags & ObsFlag.ON_GROUND) !== 0) continue;

      await openGap({
        entityId: e.entity_id,
        domain: e.domain,
        wentDarkAt: e.last_seen,
        lat: e.last_lat,
        lon: e.last_lon,
        sogKt: e.last_sog_kt,
        cogDeg: e.last_cog_deg,
      });
      opened++;
    }
  }
  return opened;
}

/**
 * Phase two: the payoff.
 *
 * A target we had marked dark just reported a position. Compute the set of
 * places physics allowed it to be, and check whether it is in one of them.
 * This is the only rule in the system that can distinguish "we lost the
 * signal" from "something happened in the dark".
 */
export async function ruleReacquisition(ctx: RuleCtx): Promise<Detection[]> {
  const seen = new Map<string, Observation>();
  for (const o of ctx.batch) {
    if (o.domain !== Domain.SEA && o.domain !== Domain.AIR) continue;
    const prev = seen.get(o.entityId);
    if (!prev || o.ts > prev.ts) seen.set(o.entityId, o);
  }
  if (!seen.size) return [];

  const gaps = await openGapsFor([...seen.keys()]);
  const out: Detection[] = [];

  for (const g of gaps) {
    const obs = seen.get(g.entity_id);
    if (!obs) continue;

    const gapS = (obs.ts - g.went_dark_at) / 1000;
    if (gapS < 300) continue; // not a real gap

    const kind = (obs.props?.kind as string) ?? null;
    const profile = profileFor(g.domain, kind);

    const result = evaluateReacquisition(
      {
        ts: g.went_dark_at,
        lat: g.last_lat,
        lon: g.last_lon,
        sogKt: g.last_sog_kt,
        cogDeg: g.last_cog_deg,
      },
      { ts: obs.ts, lat: obs.lat, lon: obs.lon, sogKt: obs.sogKt ?? null, cogDeg: obs.cogDeg ?? null },
      profile,
    );

    const box = boxFor(g.last_lat, g.last_lon, ctx.watchboxes);
    const label = (obs.props?.label as string) ?? g.entity_id;

    const evidence = {
      verdict: result.verdict,
      gapSeconds: Math.round(gapS),
      wentDarkAt: g.went_dark_at,
      reacquiredAt: obs.ts,
      lastFix: {
        lat: g.last_lat,
        lon: g.last_lon,
        sogKt: g.last_sog_kt,
        cogDeg: g.last_cog_deg,
      },
      reacquiredAtPos: { lat: obs.lat, lon: obs.lon },
      observedDistanceNm: +(result.observedDistanceM / 1852).toFixed(2),
      observedBearingDeg: +result.observedBearingDeg.toFixed(1),
      impliedSpeedKt: +result.impliedSpeedKt.toFixed(2),
      classCeilingKt: profile.maxSpeedKt,
      speedRatio: +result.speedRatio.toFixed(3),
      bearingExcessDeg: +result.bearingExcessDeg.toFixed(1),
      rangeExcessNm: +(result.rangeExcessM / 1852).toFixed(2),
      reachableSet: {
        rMinNm: +(result.set.rMinM / 1852).toFixed(2),
        rMaxNm: +(result.set.rMaxM / 1852).toFixed(2),
        bearingCenterDeg: +result.set.bearingCenterDeg.toFixed(1),
        halfAngleDeg: +result.set.halfAngleDeg.toFixed(1),
        omnidirectional: result.set.omnidirectional,
      },
      /** Drawn on the map in the Case File. The verdict, made visible. */
      reachableSetPolygon: reachableSetPolygon(result.set, 36),
      watchbox: box?.key ?? null,
      kinematicProfile: profile,
    };

    await closeGap(
      g.id,
      obs.ts,
      obs.lat,
      obs.lon,
      result.verdict,
      result.anomalyScore,
      evidence,
    );

    if (result.verdict === 'CONSISTENT') continue;

    // Inside a chokepoint the same physics means more.
    const severity = Math.min(
      100,
      Math.round(result.anomalyScore * (box ? 1.15 : 1)),
    );
    if (severity < 25) continue;

    out.push(
      mk({
        rule:
          result.verdict === 'IMPOSSIBLE_TRANSIT'
            ? 'SPOOF_DISCONTINUITY'
            : 'DARK_VESSEL',
        severity,
        tsStart: g.went_dark_at,
        tsEnd: obs.ts,
        lat: obs.lat,
        lon: obs.lon,
        entityIds: [g.entity_id],
        title:
          result.verdict === 'IMPOSSIBLE_TRANSIT'
            ? `${label} reappeared where it could not be`
            : `${label} went dark for ${fmtDur(gapS)}${box ? ` in ${box.label}` : ''}`,
        summary: result.human,
        evidence,
        provenanceIds: ctx.provenanceIds.slice(0, 8),
      }),
    );
  }
  return out;
}

/* =================================================================== */
/* 3. AIRSPACE VOID -- "the absence is the signal", as a rule           */
/* =================================================================== */

/**
 * Compare the live aircraft count in each cell against its own rolling
 * normal for this hour of the week. A corridor that is always busy at
 * 14:00 on a Tuesday and is suddenly empty is not a quiet afternoon.
 *
 * The baseline is per cell AND per hour-of-week precisely so that a
 * normally-quiet 3 a.m. does not read as an evacuation.
 */
export async function ruleAirspaceVoid(ctx: RuleCtx): Promise<Detection[]> {
  const hourOfWeek = hourOfWeekUtc(ctx.now);
  const baselines = await baselinesFor(hourOfWeek, Domain.AIR, 8);
  if (!baselines.size) return [];

  const live = new Map<string, number>();
  const centroid = new Map<string, { lat: number; lon: number; n: number }>();
  for (const o of ctx.batch) {
    if (o.domain !== Domain.AIR) continue;
    if (o.flags & ObsFlag.ON_GROUND) continue;
    const c = geohashEncode(o.lat, o.lon, 4);
    live.set(c, (live.get(c) ?? 0) + 1);
    const p = centroid.get(c) ?? { lat: 0, lon: 0, n: 0 };
    p.lat += o.lat;
    p.lon += o.lon;
    p.n++;
    centroid.set(c, p);
  }

  const out: Detection[] = [];
  for (const [cell, b] of baselines) {
    // Only cells that are reliably busy can meaningfully empty.
    if (b.mean_count < 8) continue;
    const observed = live.get(cell) ?? 0;
    const sd = Math.max(1, b.stddev);
    const z = (observed - b.mean_count) / sd;
    if (z > -3) continue;

    const drop = 1 - observed / b.mean_count;
    if (drop < 0.6) continue;

    const c = centroid.get(cell);
    const [lat, lon] = c && c.n ? [c.lat / c.n, c.lon / c.n] : cellCenter(cell);
    const box = boxFor(lat, lon, ctx.watchboxes);

    out.push(
      mk({
        rule: 'AIRSPACE_VOID',
        severity: Math.min(100, Math.round(40 + Math.abs(z) * 8 + drop * 25)),
        // Quantized so the same ongoing void does not re-fire every tick.
        tsStart: quantize(ctx.now, 15 * 60_000),
        tsEnd: null,
        lat,
        lon,
        entityIds: [],
        title: `Airspace cleared over ${box?.label ?? cell} (${Math.round(drop * 100)}% below normal)`,
        summary:
          `${observed} aircraft airborne in cell ${cell}, against a rolling ` +
          `mean of ${b.mean_count.toFixed(1)} (sd ${b.stddev.toFixed(1)}, n=${b.n}) ` +
          `for this hour of the week. z = ${z.toFixed(1)}. ` +
          `Commercial traffic does not evacuate a corridor for no reason.`,
        evidence: {
          cell,
          observed,
          baselineMean: +b.mean_count.toFixed(2),
          baselineStddev: +b.stddev.toFixed(2),
          baselineSamples: b.n,
          zScore: +z.toFixed(2),
          dropFraction: +drop.toFixed(3),
          hourOfWeekUtc: hourOfWeek,
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/* =================================================================== */
/* 4. GNSS INTERFERENCE BLOOM                                          */
/* =================================================================== */

/**
 * Nobody publishes a jamming feed. But every ADS-B aircraft broadcasts its
 * own navigation integrity, and an aircraft whose GNSS solution is being
 * degraded says so. Aggregate enough of them and the commercial fleet
 * becomes a distributed electronic-warfare sensor network.
 *
 * The rate matters, not the count: five degraded aircraft out of five is
 * an event, five out of four hundred is avionics.
 */
export function ruleGnssBloom(ctx: RuleCtx): Detection[] {
  const tally = new Map<
    string,
    { deg: number; tot: number; lat: number; lon: number; ids: string[] }
  >();

  for (const o of ctx.batch) {
    if (o.domain !== Domain.AIR) continue;
    if (o.flags & ObsFlag.ON_GROUND) continue;
    const c = geohashEncode(o.lat, o.lon, 4);
    const t = tally.get(c) ?? { deg: 0, tot: 0, lat: 0, lon: 0, ids: [] };
    t.tot++;
    if (o.flags & ObsFlag.GNSS_DEGRADED) {
      t.deg++;
      t.lat += o.lat;
      t.lon += o.lon;
      if (t.ids.length < 25) t.ids.push(o.entityId);
    }
    tally.set(c, t);
  }

  const out: Detection[] = [];
  for (const [cell, t] of tally) {
    if (t.deg < 5 || t.tot < 8) continue;
    const rate = t.deg / t.tot;
    if (rate < 0.35) continue;

    const lat = t.lat / t.deg;
    const lon = t.lon / t.deg;
    const box = boxFor(lat, lon, ctx.watchboxes);

    out.push(
      mk({
        rule: 'GNSS_BLOOM',
        severity: Math.min(100, Math.round(35 + rate * 45 + Math.min(20, t.deg))),
        tsStart: quantize(ctx.now, 10 * 60_000),
        tsEnd: null,
        lat,
        lon,
        entityIds: t.ids,
        title: `GNSS interference over ${box?.label ?? cell}: ${t.deg}/${t.tot} aircraft degraded`,
        summary:
          `${(rate * 100).toFixed(0)}% of aircraft in cell ${cell} are reporting ` +
          `degraded navigation integrity (NIC<=4 or NACp<=5). Inferred from the ` +
          `fleet itself -- no jamming sensor is involved, and none is needed.`,
        evidence: {
          cell,
          degraded: t.deg,
          total: t.tot,
          rate: +rate.toFixed(3),
          sampleEntities: t.ids.slice(0, 25),
          method: 'ADS-B navigation integrity category aggregation',
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/* =================================================================== */
/* 5. EMERGENCY SQUAWK                                                 */
/* =================================================================== */

const SQUAWK_MEANING: Record<string, [string, number]> = {
  '7500': ['unlawful interference (hijack)', 100],
  '7600': ['radio communication failure', 62],
  '7700': ['general emergency', 88],
};

export function ruleSquawk(ctx: RuleCtx): Detection[] {
  const out: Detection[] = [];
  const seen = new Set<string>();

  for (const o of ctx.batch) {
    if (o.domain !== Domain.AIR) continue;
    const sq = (o.props?.squawk as string) ?? '';
    const meaning = SQUAWK_MEANING[sq];
    if (!meaning) continue;
    if (seen.has(o.entityId)) continue;
    seen.add(o.entityId);

    const label = (o.props?.label as string) ?? o.entityId;
    out.push(
      mk({
        rule: 'SQUAWK_EMERGENCY',
        severity: meaning[1],
        // Hourly bucket: one detection per aircraft per hour, not per tick.
        tsStart: quantize(o.ts, 3600_000),
        tsEnd: null,
        lat: o.lat,
        lon: o.lon,
        entityIds: [o.entityId],
        title: `${label} squawking ${sq} -- ${meaning[0]}`,
        summary:
          `Transponder code ${sq} observed at ${new Date(o.ts).toISOString()} ` +
          `at ${o.lat.toFixed(3)}, ${o.lon.toFixed(3)}` +
          `${o.altM != null ? `, ${Math.round(o.altM * 3.28084).toLocaleString()} ft` : ''}.`,
        evidence: {
          squawk: sq,
          meaning: meaning[0],
          altFt: o.altM != null ? Math.round(o.altM * 3.28084) : null,
          speedKt: o.sogKt,
          headingDeg: o.cogDeg,
          registration: o.props?.reg ?? null,
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/* =================================================================== */
/* 6. RENDEZVOUS -- ship-to-ship transfer signature                    */
/* =================================================================== */

/**
 * Two hulls, close together, both essentially stopped, for long enough
 * that it is not a passing. On open water that is a ship-to-ship transfer:
 * the standard mechanism for moving sanctioned cargo into a clean hull.
 *
 * Deliberately excluded: anything slow-moving near a port. The point is to
 * find transfers where no transfer should be happening.
 */
export function ruleRendezvous(ctx: RuleCtx): Detection[] {
  const vessels = ctx.batch.filter(
    (o) => o.domain === Domain.SEA && (o.sogKt ?? 99) < 1.2,
  );
  if (vessels.length < 2) return [];

  // Grid-bucket to avoid an O(n^2) sweep over every stopped hull on earth.
  const grid = new Map<string, Observation[]>();
  for (const v of vessels) {
    const c = geohashEncode(v.lat, v.lon, 5);
    (grid.get(c) ?? grid.set(c, []).get(c)!).push(v);
  }

  const out: Detection[] = [];
  const paired = new Set<string>();

  for (const [, group] of grid) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const key = [a.entityId, b.entityId].sort().join('|');
        if (paired.has(key)) continue;

        const d = haversineM(a.lat, a.lon, b.lat, b.lon);
        if (d > 500 || d < 5) continue;

        const box = boxFor(a.lat, a.lon, ctx.watchboxes);
        const la = (a.props?.label as string) ?? a.entityId;
        const lb = (b.props?.label as string) ?? b.entityId;
        const ka = (a.props?.kind as string) ?? 'unknown';
        const kb = (b.props?.kind as string) ?? 'unknown';
        const bothTankers = ka.includes('tanker') && kb.includes('tanker');

        paired.add(key);
        out.push(
          mk({
            rule: 'RENDEZVOUS',
            severity: Math.min(
              100,
              Math.round(40 + (bothTankers ? 25 : 0) + (box ? 12 : 0) + (500 - d) / 25),
            ),
            tsStart: quantize(Math.min(a.ts, b.ts), 30 * 60_000),
            tsEnd: null,
            lat: (a.lat + b.lat) / 2,
            lon: (a.lon + b.lon) / 2,
            entityIds: [a.entityId, b.entityId],
            title: `${la} and ${lb} alongside at sea${bothTankers ? ' (tanker/tanker)' : ''}`,
            summary:
              `Two vessels ${Math.round(d)} m apart, both under 1.2 kt` +
              `${box ? `, in ${box.label}` : ''}. Sustained proximity at near-zero ` +
              `speed away from a berth is the ship-to-ship transfer signature.`,
            evidence: {
              separationM: Math.round(d),
              vessels: [
                { id: a.entityId, label: la, kind: ka, sogKt: a.sogKt, mmsi: a.props?.mmsi },
                { id: b.entityId, label: lb, kind: kb, sogKt: b.sogKt, mmsi: b.props?.mmsi },
              ],
              bothTankers,
              watchbox: box?.key ?? null,
            },
            provenanceIds: ctx.provenanceIds.slice(0, 4),
          }),
        );
      }
    }
  }
  return out;
}

/* =================================================================== */
/* 7. LOITER -- the ISR racetrack                                      */
/* =================================================================== */

/**
 * An aircraft that has flown a long way and got nowhere is orbiting.
 * Airliners do not orbit; surveillance and tanker aircraft do. The metric
 * is straightness: net displacement over path length.
 */
export async function ruleLoiter(ctx: RuleCtx): Promise<Detection[]> {
  const candidates = new Map<string, Observation>();
  for (const o of ctx.batch) {
    if (o.domain !== Domain.AIR) continue;
    if (o.flags & ObsFlag.ON_GROUND) continue;
    if ((o.sogKt ?? 0) < 90) continue;
    // Checking every airliner would cost a query each. Military registration
    // or a watchbox is a cheap, high-yield pre-filter.
    const interesting =
      (o.flags & ObsFlag.MILITARY) !== 0 || !!boxFor(o.lat, o.lon, ctx.watchboxes);
    if (!interesting) continue;
    candidates.set(o.entityId, o);
  }
  if (!candidates.size) return [];

  const out: Detection[] = [];
  const from = ctx.now - 45 * 60_000;

  for (const [id, o] of [...candidates].slice(0, 60)) {
    const track = await trackFor(id, from, ctx.now, 400);
    if (track.length < 12) continue;

    let pathM = 0;
    let turning = 0;
    for (let i = 1; i < track.length; i++) {
      const p = track[i - 1]!;
      const q = track[i]!;
      pathM += haversineM(p.lat, p.lon, q.lat, q.lon);
      if (p.cog != null && q.cog != null) {
        turning += Math.abs(angleDelta(p.cog, q.cog));
      }
    }
    if (pathM < 60_000) continue;

    const first = track[0]!;
    const last = track[track.length - 1]!;
    const netM = haversineM(first.lat, first.lon, last.lat, last.lon);
    const straightness = netM / pathM;
    if (straightness > 0.32) continue;

    const durMin = (last.ts - first.ts) / 60_000;
    const label = (o.props?.label as string) ?? id;
    const box = boxFor(o.lat, o.lon, ctx.watchboxes);

    out.push(
      mk({
        rule: 'LOITER',
        severity: Math.min(
          100,
          Math.round(
            35 + (1 - straightness) * 40 + ((o.flags & ObsFlag.MILITARY) !== 0 ? 18 : 0),
          ),
        ),
        tsStart: quantize(first.ts, 30 * 60_000),
        tsEnd: last.ts,
        lat: o.lat,
        lon: o.lon,
        entityIds: [id],
        title: `${label} holding a racetrack${box ? ` over ${box.label}` : ''}`,
        summary:
          `${(pathM / 1852).toFixed(0)} nm flown over ${durMin.toFixed(0)} minutes for ` +
          `${(netM / 1852).toFixed(0)} nm of progress (straightness ${straightness.toFixed(2)}, ` +
          `cumulative turn ${Math.round(turning)}deg). Consistent with an ISR or ` +
          `tanker orbit rather than transit.`,
        evidence: {
          pathNm: +(pathM / 1852).toFixed(1),
          netNm: +(netM / 1852).toFixed(1),
          straightness: +straightness.toFixed(3),
          cumulativeTurnDeg: Math.round(turning),
          durationMin: +durMin.toFixed(1),
          samples: track.length,
          military: (o.flags & ObsFlag.MILITARY) !== 0,
          trackSample: track
            .filter((_, i) => i % Math.ceil(track.length / 60) === 0)
            .map((t) => [+t.lon.toFixed(4), +t.lat.toFixed(4)]),
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/* =================================================================== */
/* 8 + 9. THERMAL AND SEISMIC                                          */
/* =================================================================== */

export function ruleThermal(ctx: RuleCtx): Detection[] {
  const out: Detection[] = [];
  for (const o of ctx.batch) {
    if (o.domain !== Domain.THERMAL) continue;
    const frp = Number(o.props?.frp ?? 0);
    if (frp < 40) continue; // wildfire noise floor
    const box = boxFor(o.lat, o.lon, ctx.watchboxes);

    out.push(
      mk({
        rule: 'THERMAL_ANOMALY',
        severity: Math.min(100, Math.round(28 + Math.log10(frp) * 22 + (box ? 15 : 0))),
        tsStart: o.ts,
        tsEnd: null,
        lat: o.lat,
        lon: o.lon,
        entityIds: [o.entityId],
        title: `High-energy thermal signature (${frp.toFixed(0)} MW)${box ? ` in ${box.label}` : ''}`,
        summary:
          `VIIRS 375 m detection with fire radiative power ${frp.toFixed(1)} MW at ` +
          `${o.lat.toFixed(4)}, ${o.lon.toFixed(4)}. On its own this is a fire. ` +
          `Correlated with other domains it may not be.`,
        evidence: {
          frpMw: frp,
          brightnessK: o.props?.brightnessK ?? null,
          sensor: o.props?.sensor ?? 'VIIRS',
          dayNight: o.props?.dayNight ?? null,
          watchbox: box?.key ?? null,
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/**
 * Shallow and moderate beats deep and large. A magnitude 4.2 at 0 km depth
 * is the profile of a surface event; a magnitude 6 at 300 km is a subduction
 * zone doing what it always does.
 */
export function ruleSeismic(ctx: RuleCtx): Detection[] {
  const out: Detection[] = [];
  for (const o of ctx.batch) {
    if (o.domain !== Domain.GEO) continue;
    const mag = Number(o.props?.mag ?? 0);
    const depth = Number(o.props?.depthKm ?? 999);
    if (!(mag >= 3.2 && depth <= 6)) continue;

    const box = boxFor(o.lat, o.lon, ctx.watchboxes);
    out.push(
      mk({
        rule: 'SEISMIC_SHALLOW',
        severity: Math.min(100, Math.round(25 + mag * 9 + (6 - depth) * 3)),
        tsStart: o.ts,
        tsEnd: null,
        lat: o.lat,
        lon: o.lon,
        entityIds: [o.entityId],
        title: `M${mag.toFixed(1)} at ${depth.toFixed(1)} km -- ${o.props?.label ?? 'unnamed'}`,
        summary:
          `Shallow seismic event, magnitude ${mag.toFixed(1)}, focal depth ` +
          `${depth.toFixed(1)} km. Shallow-and-moderate is the profile of a ` +
          `surface release rather than tectonic slip.`,
        evidence: {
          magnitude: mag,
          depthKm: depth,
          place: o.props?.label ?? null,
          usgsId: o.entityId.replace(/^geo:/, ''),
          watchbox: box?.key ?? null,
        },
        provenanceIds: ctx.provenanceIds.slice(0, 4),
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------- helpers */

export function hourOfWeekUtc(ms: number): number {
  const d = new Date(ms);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

/** Snap to a bucket so a persisting condition hashes to one detection. */
function quantize(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

function cellCenter(cell: string): [number, number] {
  const b = geohashBounds(cell);
  return [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2];
}

function fmtDur(s: number): string {
  if (s < 5400) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const KINEMATICS_NOTE = `Speed ceilings are per-class and deliberately
generous. A false negative costs one missed hull; a false positive costs the
reader's trust in every other finding on the board.`;

export { KT_TO_MS, bearingDeg, reachableSet, type EntityRow };
