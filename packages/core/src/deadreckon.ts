/**
 * DEADRECKON :: the namesake algorithm.
 *
 * "Dead reckoning" is the pre-GPS practice of computing where you must be
 * from where you last knew you were, plus heading, speed and elapsed time.
 *
 * We use it in reverse. When a transponder goes quiet, we compute the set
 * of positions the target could physically occupy. When it comes back, we
 * ask one question:
 *
 *     Is it where physics says it should be?
 *
 * If yes, it was a coverage gap. If no, something happened in the dark --
 * an AIS spoof, a ship-to-ship transfer, a false position injection, or a
 * hull that simply is not the hull it claims to be.
 *
 * This is the operationalized form of "the absence is the signal". Nothing
 * about it requires a human to have been watching.
 */

import { bearingDeg, destination, haversineM, angleDelta, KT_TO_MS } from './geo.js';

export interface Fix {
  ts: number; // ms epoch
  lat: number;
  lon: number;
  sogKt: number | null;
  cogDeg: number | null;
}

/** Per-class kinematic envelope. Wrong numbers here = false positives. */
export interface KinematicProfile {
  /** Absolute ceiling for this class, knots. Hard physics bound. */
  maxSpeedKt: number;
  /** How fast the course can plausibly wander, deg per hour. */
  courseDriftDegPerH: number;
  /** Immediate heading uncertainty at t=0, degrees. */
  courseEpsilonDeg: number;
  /** Deceleration floor: fraction of last speed still plausible after 1h. */
  speedDecayFloor: number;
}

export const PROFILE: Record<string, KinematicProfile> = {
  // Merchant hulls. A VLCC does not sprint.
  vessel_cargo: {
    maxSpeedKt: 24,
    courseDriftDegPerH: 22,
    courseEpsilonDeg: 6,
    speedDecayFloor: 0,
  },
  vessel_tanker: {
    maxSpeedKt: 18,
    courseDriftDegPerH: 18,
    courseEpsilonDeg: 5,
    speedDecayFloor: 0,
  },
  vessel_fast: {
    maxSpeedKt: 45,
    courseDriftDegPerH: 60,
    courseEpsilonDeg: 12,
    speedDecayFloor: 0,
  },
  vessel_default: {
    maxSpeedKt: 28,
    courseDriftDegPerH: 30,
    courseEpsilonDeg: 8,
    speedDecayFloor: 0,
  },
  // Aircraft cannot stop, which tightens the inner radius considerably.
  aircraft_jet: {
    maxSpeedKt: 620,
    courseDriftDegPerH: 240,
    courseEpsilonDeg: 4,
    speedDecayFloor: 0.35,
  },
  aircraft_prop: {
    maxSpeedKt: 300,
    courseDriftDegPerH: 300,
    courseEpsilonDeg: 6,
    speedDecayFloor: 0.3,
  },
  aircraft_default: {
    maxSpeedKt: 560,
    courseDriftDegPerH: 260,
    courseEpsilonDeg: 5,
    speedDecayFloor: 0.3,
  },
};

/**
 * The reachable set: an annulus sector centred on the last fix.
 *
 *                     .-'''-.        <- rMax  (max speed x elapsed)
 *                  .-'       `-.
 *                 /   ,-----.   \
 *                |   /       \   |   <- rMin  (min plausible transit)
 *                |   |   X   |   |      X = last known fix
 *                 \   `-----'   /
 *                  `-.       .-'
 *                     `-...-'
 *                  |<-- 2*halfAngle -->|   centred on last course
 */
export interface ReachableSet {
  centerLat: number;
  centerLon: number;
  rMinM: number;
  rMaxM: number;
  bearingCenterDeg: number;
  halfAngleDeg: number;
  elapsedS: number;
  /** True once halfAngle hits 180 -- the sector has become a full disc. */
  omnidirectional: boolean;
  profile: KinematicProfile;
}

export function reachableSet(
  fix: Fix,
  atTs: number,
  profile: KinematicProfile,
): ReachableSet {
  const elapsedS = Math.max(0, (atTs - fix.ts) / 1000);
  const elapsedH = elapsedS / 3600;

  const lastSog = fix.sogKt ?? 0;

  // Outer bound is pure physics: it cannot have gone further than this.
  const rMaxM = profile.maxSpeedKt * KT_TO_MS * elapsedS;

  // Inner bound. A ship can stop dead; a jet cannot. speedDecayFloor
  // encodes "how much of your last speed you are still obliged to carry".
  const floorKt = lastSog * profile.speedDecayFloor;
  const rMinM = Math.max(0, floorKt * KT_TO_MS * elapsedS);

  // Course uncertainty opens linearly and saturates at a full circle.
  const halfAngleDeg = Math.min(
    180,
    profile.courseEpsilonDeg + profile.courseDriftDegPerH * elapsedH,
  );

  return {
    centerLat: fix.lat,
    centerLon: fix.lon,
    rMinM,
    rMaxM,
    bearingCenterDeg: fix.cogDeg ?? 0,
    halfAngleDeg,
    elapsedS,
    omnidirectional: halfAngleDeg >= 180 || fix.cogDeg == null,
    profile,
  };
}

export type ReacquisitionVerdict =
  | 'CONSISTENT'
  | 'COURSE_DISCONTINUITY'
  | 'IMPOSSIBLE_TRANSIT'
  | 'IMPLAUSIBLE_LOITER';

export interface ReacquisitionResult {
  verdict: ReacquisitionVerdict;
  /** 0..100. Feeds Detection.severity directly. */
  anomalyScore: number;
  observedDistanceM: number;
  observedBearingDeg: number;
  impliedSpeedKt: number;
  /** How many times over the physics ceiling the implied speed is. */
  speedRatio: number;
  /** Degrees outside the permitted sector. 0 if inside. */
  bearingExcessDeg: number;
  /** Metres beyond rMax. 0 if inside. */
  rangeExcessM: number;
  set: ReachableSet;
  gapS: number;
  human: string;
}

/**
 * The whole product, in one function.
 *
 * Given the last fix before a target went dark and the first fix after it
 * came back, decide whether physics was obeyed -- and if not, by how much.
 */
export function evaluateReacquisition(
  lastFix: Fix,
  reacquired: Fix,
  profile: KinematicProfile,
): ReacquisitionResult {
  const set = reachableSet(lastFix, reacquired.ts, profile);
  const gapS = set.elapsedS;

  const observedDistanceM = haversineM(
    lastFix.lat,
    lastFix.lon,
    reacquired.lat,
    reacquired.lon,
  );
  const observedBearingDeg = bearingDeg(
    lastFix.lat,
    lastFix.lon,
    reacquired.lat,
    reacquired.lon,
  );

  const impliedSpeedKt =
    gapS > 0 ? observedDistanceM / KT_TO_MS / gapS : 0;
  const speedRatio =
    profile.maxSpeedKt > 0 ? impliedSpeedKt / profile.maxSpeedKt : 0;

  const rangeExcessM = Math.max(0, observedDistanceM - set.rMaxM);
  const bearingExcessDeg = set.omnidirectional
    ? 0
    : Math.max(
        0,
        Math.abs(angleDelta(set.bearingCenterDeg, observedBearingDeg)) -
          set.halfAngleDeg,
      );
  const rangeShortfallM = Math.max(0, set.rMinM - observedDistanceM);

  let verdict: ReacquisitionVerdict = 'CONSISTENT';
  let score = 0;
  let human = 'Reacquired inside its reachable set. Consistent with a coverage gap.';

  if (rangeExcessM > 0) {
    verdict = 'IMPOSSIBLE_TRANSIT';
    // Ratio 1.0 -> 55. Ratio 2.0 -> ~85. Ratio 4.0+ -> 100.
    score = clamp01(0.55 + 0.3 * Math.log2(Math.max(1.001, speedRatio))) * 100;
    human =
      `Reacquired ${fmtNm(observedDistanceM)} from its last fix after a ` +
      `${fmtDur(gapS)} gap. That implies ${impliedSpeedKt.toFixed(1)} kt against a ` +
      `${profile.maxSpeedKt} kt ceiling for this class. The position is not reachable.`;
  } else if (bearingExcessDeg > 0) {
    verdict = 'COURSE_DISCONTINUITY';
    score = clamp01(0.25 + bearingExcessDeg / 240) * 100;
    human =
      `Reacquired on bearing ${observedBearingDeg.toFixed(0)}deg, ` +
      `${bearingExcessDeg.toFixed(0)}deg outside the ` +
      `+/-${set.halfAngleDeg.toFixed(0)}deg envelope around its last course of ` +
      `${set.bearingCenterDeg.toFixed(0)}deg. Reachable by range, not by heading.`;
  } else if (rangeShortfallM > 0 && set.rMinM > 0) {
    verdict = 'IMPLAUSIBLE_LOITER';
    score = clamp01(0.2 + rangeShortfallM / Math.max(1, set.rMinM) / 2) * 100;
    human =
      `Reacquired only ${fmtNm(observedDistanceM)} from its last fix after ` +
      `${fmtDur(gapS)}. For this class that is closer than the minimum ` +
      `plausible transit -- it stopped, or it never left.`;
  }

  // Long gaps are more suspicious than short ones, but only up to a point:
  // after ~12h at sea, coverage gaps genuinely are common.
  const gapWeight = 0.75 + 0.25 * Math.min(1, gapS / (6 * 3600));

  return {
    verdict,
    anomalyScore: Math.round(Math.min(100, score * gapWeight)),
    observedDistanceM,
    observedBearingDeg,
    impliedSpeedKt,
    speedRatio,
    bearingExcessDeg,
    rangeExcessM,
    set,
    gapS,
    human,
  };
}

/**
 * Render the reachable set as a GeoJSON-ready ring so the Case File can
 * draw the exact cone the verdict was computed against. If a reader cannot
 * see the envelope, the verdict is just an assertion.
 */
export function reachableSetPolygon(
  set: ReachableSet,
  steps = 48,
): [number, number][] {
  const pts: [number, number][] = [];
  const start = set.omnidirectional
    ? 0
    : set.bearingCenterDeg - set.halfAngleDeg;
  const sweep = set.omnidirectional ? 360 : set.halfAngleDeg * 2;

  // outer arc, left to right
  for (let i = 0; i <= steps; i++) {
    const b = start + (sweep * i) / steps;
    const [la, lo] = destination(set.centerLat, set.centerLon, b, set.rMaxM);
    pts.push([lo, la]);
  }
  // inner arc, back again (produces an annulus sector, not a pie slice)
  if (set.rMinM > 0) {
    for (let i = steps; i >= 0; i--) {
      const b = start + (sweep * i) / steps;
      const [la, lo] = destination(set.centerLat, set.centerLon, b, set.rMinM);
      pts.push([lo, la]);
    }
  } else if (!set.omnidirectional) {
    pts.push([set.centerLon, set.centerLat]);
  }
  if (pts.length) pts.push(pts[0]!);
  return pts;
}

/** Where we believe it is right now, if it never came back. */
export function extrapolate(fix: Fix, atTs: number): [number, number] {
  const elapsedS = Math.max(0, (atTs - fix.ts) / 1000);
  if (!fix.sogKt || fix.cogDeg == null) return [fix.lat, fix.lon];
  return destination(
    fix.lat,
    fix.lon,
    fix.cogDeg,
    fix.sogKt * KT_TO_MS * elapsedS,
  );
}

export function profileFor(domain: number, kind?: string | null): KinematicProfile {
  const k = (kind ?? '').toLowerCase();
  if (domain === 2) {
    if (k.includes('tanker')) return PROFILE.vessel_tanker!;
    if (k.includes('cargo') || k.includes('bulk')) return PROFILE.vessel_cargo!;
    if (k.includes('high speed') || k.includes('craft') || k.includes('pilot'))
      return PROFILE.vessel_fast!;
    return PROFILE.vessel_default!;
  }
  if (domain === 1) {
    if (k.includes('prop') || k.includes('turboprop')) return PROFILE.aircraft_prop!;
    if (k.includes('jet')) return PROFILE.aircraft_jet!;
    return PROFILE.aircraft_default!;
  }
  return PROFILE.vessel_default!;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function fmtNm(m: number): string {
  return `${(m / 1852).toFixed(1)} nm`;
}

function fmtDur(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
