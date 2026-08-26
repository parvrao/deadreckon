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

const MAX_SATS = 900;

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

  const propagate = (): void => {
    if (!recs.length) return;
    const now = new Date();
    const gmst = satellite.gstime(now);
    const out: SatPoint[] = [];

    for (const { rec, name } of recs) {
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
    onUpdate(out);
  };

  propagate();
  setInterval(propagate, 500);
}
