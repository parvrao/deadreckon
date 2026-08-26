/**
 * DEADRECKON :: orbital layer.
 *
 * The elements are fetched once. Every position after that is computed in
 * this browser with SGP4.
 *
 * A satellite's position is a pure function of (elements, time). Streaming
 * it from a server would mean paying, per viewer, per tick, for a number
 * the client can derive for free -- so the orbital layer costs the backend
 * one HTTP request every six hours and exactly nothing per viewer.
 *
 * Propagation runs in a 2 Hz timer rather than a rAF loop: orbital motion
 * is slow, and burning a core to redraw 60 times a second would be silly.
 */

import { getJson } from './net.js';

interface Tle {
  norad_id: number;
  name: string;
  line1: string;
  line2: string;
  grp: string;
}

export interface SatPoint {
  lon: number;
  lat: number;
  name: string;
}

/**
 * Propagation budget, sized to the machine rather than assumed.
 *
 * SGP4 is ~15µs per satellite per solve, so 900 at 2 Hz is about 3% of a
 * core on a desktop and considerably worse on a phone sharing that core
 * with a WebGL globe. `hardwareConcurrency` is a crude proxy but it is
 * the only signal available before we have measured anything, and the
 * loop below then measures and adapts.
 */
const MAX_SATS = (() => {
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores <= 2) return 250;
  if (cores <= 4) return 500;
  return 900;
})();

/** Budget per propagation pass. Exceed it and the set shrinks. */
const FRAME_BUDGET_MS = 12;

export async function startOrbits(
  onUpdate: (pts: SatPoint[]) => void,
): Promise<void> {
  let satellite: typeof import('satellite.js');
  try {
    satellite = await import('satellite.js');
  } catch {
    return; // optional layer; never break the console over it
  }

  let recs: { rec: ReturnType<typeof satellite.twoline2satrec>; name: string }[] = [];

  const load = async (): Promise<void> => {
    try {
      const r = await getJson<{ tles: Tle[] }>('/api/tles');
      recs = r.tles
        .slice(0, MAX_SATS)
        .map((t) => {
          try {
            return { rec: satellite.twoline2satrec(t.line1, t.line2), name: t.name };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    } catch {
      recs = [];
    }
  };

  await load();
  // Elements decay. Reload on the same cadence the worker refreshes them.
  setInterval(() => void load(), 6 * 3600_000);

  /** Shrinks if a pass overruns its budget, recovers slowly if it does not. */
  let budget = recs.length;

  const propagate = (): void => {
    if (!recs.length) return;
    // A hidden tab should not be burning a core on satellites nobody can
    // see. Browsers throttle timers but not the work inside them.
    if (document.hidden) return;

    const t0 = performance.now();
    const now = new Date();
    const gmst = satellite.gstime(now);
    const out: SatPoint[] = [];

    const slice = recs.slice(0, budget);
    for (const { rec, name } of slice) {
      try {
        const pv = satellite.propagate(rec, now);
        const p = pv?.position;
        if (!p || typeof p === 'boolean') continue;
        const geo = satellite.eciToGeodetic(p, gmst);
        const lat = satellite.degreesLat(geo.latitude);
        const lon = satellite.degreesLong(geo.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({ lat, lon, name });
      } catch {
        // A decayed element set throws rather than returning null. Skip it.
      }
    }

    // Adapt. Overrunning the budget costs frames on the globe, which is
    // far more noticeable than a hundred fewer satellites.
    const spent = performance.now() - t0;
    if (spent > FRAME_BUDGET_MS && budget > 100) {
      budget = Math.max(100, Math.floor(budget * 0.7));
      console.warn(
        `[orbits] propagation took ${spent.toFixed(1)}ms, reducing to ${budget} satellites`,
      );
    } else if (spent < FRAME_BUDGET_MS / 3 && budget < recs.length) {
      budget = Math.min(recs.length, Math.floor(budget * 1.15) + 10);
    }

    onUpdate(out);
  };

  propagate();
  setInterval(propagate, 500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) propagate();
  });
}
