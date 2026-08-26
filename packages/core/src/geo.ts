/**
 * DEADRECKON :: geodesy + geohash.
 *
 * Geohash is not decoration here -- it IS the fan-out addressing scheme.
 * A client subscribes to a set of cells; ingest publishes into cells;
 * the hub never has to test a point against a viewport rectangle.
 * That is the difference between O(clients x entities) and O(entities).
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BASE32_IDX: Record<string, number> = {};
for (let i = 0; i < BASE32.length; i++) BASE32_IDX[BASE32[i]!] = i;

export const EARTH_RADIUS_M = 6371008.8;
export const KT_TO_MS = 0.514444;
export const M_TO_NM = 1 / 1852;

/** Approximate cell size at the equator, in km, indexed by precision. */
export const GEOHASH_KM: Record<number, number> = {
  1: 5000,
  2: 1250,
  3: 156,
  4: 39.1,
  5: 4.89,
  6: 1.22,
  7: 0.153,
  8: 0.0382,
};

export function geohashEncode(lat: number, lon: number, precision = 5): string {
  let latMin = -90,
    latMax = 90,
    lonMin = -180,
    lonMax = 180;
  let hash = '';
  let bit = 0;
  let idx = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        idx = (idx << 1) | 1;
        lonMin = mid;
      } else {
        idx = idx << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = (idx << 1) | 1;
        latMin = mid;
      } else {
        idx = idx << 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function geohashBounds(hash: string): Bounds {
  let latMin = -90,
    latMax = 90,
    lonMin = -180,
    lonMax = 180;
  let even = true;

  for (const ch of hash) {
    const idx = BASE32_IDX[ch];
    if (idx === undefined) throw new Error(`bad geohash char: ${ch}`);
    for (let b = 4; b >= 0; b--) {
      const bit = (idx >> b) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { minLat: latMin, minLon: lonMin, maxLat: latMax, maxLon: lonMax };
}

/**
 * Pick the geohash precision that yields a sane number of cells for a
 * viewport. Without this, a zoomed-out client would try to subscribe to
 * the entire planet at 5km resolution and take the hub down with it.
 */
export function precisionForBounds(b: Bounds, targetCells = 256): number {
  const spanKm = Math.max(
    haversineM(b.minLat, b.minLon, b.maxLat, b.minLon) / 1000,
    haversineM(b.minLat, b.minLon, b.minLat, b.maxLon) / 1000,
  );
  for (let p = 1; p <= 6; p++) {
    const cell = GEOHASH_KM[p]!;
    const approx = Math.pow(Math.max(1, spanKm / cell), 2);
    if (approx >= targetCells / 4) return p;
  }
  return 6;
}

/**
 * Enumerate the geohash cells covering a bounding box.
 * Hard-capped: a client can never make us allocate an unbounded set.
 */
export function cellsForBounds(b: Bounds, precision: number, cap = 512): string[] {
  const cellDeg = cellSizeDeg(precision);
  const out = new Set<string>();

  const minLat = clamp(b.minLat, -90, 90);
  const maxLat = clamp(b.maxLat, -90, 90);
  const minLon = clamp(b.minLon, -180, 180);
  const maxLon = clamp(b.maxLon, -180, 180);

  for (let lat = minLat; lat <= maxLat + cellDeg.lat; lat += cellDeg.lat) {
    for (let lon = minLon; lon <= maxLon + cellDeg.lon; lon += cellDeg.lon) {
      out.add(geohashEncode(Math.min(lat, 90), Math.min(lon, 180), precision));
      if (out.size >= cap) return [...out];
    }
  }
  return [...out];
}

function cellSizeDeg(precision: number): { lat: number; lon: number } {
  // geohash alternates lon/lat bits starting with lon
  let latBits = 0,
    lonBits = 0;
  for (let i = 0; i < precision * 5; i++) {
    if (i % 2 === 0) lonBits++;
    else latBits++;
  }
  return { lat: 180 / Math.pow(2, latBits), lon: 360 / Math.pow(2, lonBits) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees 0..360. */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Project a point along a bearing for a distance. The inverse of the above. */
export function destination(
  lat: number,
  lon: number,
  bearing: number,
  distanceM: number,
): [number, number] {
  const d = distanceM / EARTH_RADIUS_M;
  const b = bearing * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return [p2 * R2D, (((l2 * R2D + 540) % 360) - 180)];
}

/** Smallest signed angle from a to b, in [-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}
