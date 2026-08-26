/**
 * DEADRECKON :: geo, thermal, orbit and media adapters.
 *
 * These three are low-volume and high-corroboration. On their own each is
 * near-useless; their job is to be the second and third independent
 * witness that turns a single suspicious detection into an incident.
 */

import { Domain, type Observation } from '@deadreckon/core';
import { fetchText, safeJson, TokenBucket, type FetchResult } from '../http.js';

export const MISC_PARSER_VERSION = 'misc/2';

export const usgsBucket = new TokenBucket(4, 0.5);
export const firmsBucket = new TokenBucket(2, 0.05); // FIRMS is strict
export const celestrakBucket = new TokenBucket(2, 0.02);
export const gdeltBucket = new TokenBucket(2, 0.1);

export interface Fetched {
  observations: Observation[];
  raw: FetchResult;
}

/* ------------------------------------------------------------------ geo */

/**
 * USGS all-hour feed. Shallow events matter to us far more than large
 * ones: a magnitude 7 at 300 km depth is tectonics, a magnitude 4 at 0 km
 * next to a facility is something else.
 */
export async function fetchQuakes(signal?: AbortSignal): Promise<Fetched> {
  const url =
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
  const raw = await fetchText(url, { bucket: usgsBucket, signal });
  if (!raw.ok) return { observations: [], raw };

  const j = safeJson<{
    features?: {
      id: string;
      properties: { mag?: number; place?: string; time?: number; type?: string };
      geometry: { coordinates: [number, number, number] };
    }[];
  }>(raw.body, url);

  const out: Observation[] = [];
  for (const f of j?.features ?? []) {
    const [lon, lat, depthKm] = f.geometry?.coordinates ?? [];
    if (lat == null || lon == null) continue;
    out.push({
      ts: f.properties?.time ?? Date.now(),
      domain: Domain.GEO,
      entityId: `geo:${f.id}`,
      lat,
      lon,
      altM: depthKm != null ? -depthKm * 1000 : null,
      sogKt: null,
      cogDeg: null,
      flags: 0,
      conf: 250,
      props: {
        label: f.properties?.place ?? f.id,
        kind: f.properties?.type ?? 'earthquake',
        mag: f.properties?.mag ?? null,
        depthKm: depthKm ?? null,
      },
    });
  }
  return { observations: out, raw };
}

/* -------------------------------------------------------------- thermal */

/**
 * NASA FIRMS active fire. VIIRS resolves to 375 m, which is enough to see
 * a burning facility, a struck vessel, or a flare stack going out. FRP
 * (fire radiative power) is the discriminator between a cooking fire and
 * an event.
 */
export async function fetchFirms(
  mapKey: string,
  areaWSEN: string,
  signal?: AbortSignal,
): Promise<Fetched> {
  const url =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}` +
    `/VIIRS_NOAA20_NRT/${areaWSEN}/1`;
  const raw = await fetchText(url, { bucket: firmsBucket, signal, timeoutMs: 30_000 });
  if (!raw.ok) return { observations: [], raw };

  // FIRMS answers 200 with an HTML error body when the key is bad.
  if (raw.body.startsWith('<') || !raw.body.includes('latitude')) {
    return {
      observations: [],
      raw: { ...raw, ok: false, error: 'FIRMS returned a non-CSV body (bad key?)' },
    };
  }

  const lines = raw.body.trim().split('\n');
  const header = lines[0]!.split(',').map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  const iFrp = col('frp');
  const iConf = col('confidence');
  const iBright = col('bright_ti4');
  const iDn = col('daynight');
  if (iLat < 0 || iLon < 0) return { observations: [], raw };

  const out: Observation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(',');
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // acq_time is HHMM, zero-padding stripped.
    const hhmm = (c[iTime] ?? '0').padStart(4, '0');
    const ts = Date.parse(
      `${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
    );
    const frp = Number(c[iFrp]) || 0;
    const confStr = (c[iConf] ?? '').trim();

    out.push({
      ts: Number.isFinite(ts) ? ts : Date.now(),
      domain: Domain.THERMAL,
      entityId: `thermal:${lat.toFixed(4)},${lon.toFixed(4)},${c[iDate]}${hhmm}`,
      lat,
      lon,
      altM: null,
      sogKt: null,
      cogDeg: null,
      flags: 0,
      conf: confStr === 'h' ? 240 : confStr === 'n' ? 170 : 110,
      props: {
        label: `FRP ${frp.toFixed(1)} MW`,
        kind: 'thermal_anomaly',
        frp,
        brightnessK: Number(c[iBright]) || null,
        dayNight: c[iDn] ?? null,
        sensor: 'VIIRS_NOAA20',
      },
    });
  }
  return { observations: out, raw };
}

/* ---------------------------------------------------------------- orbit */

export interface TleRecord {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  group: string;
}

/**
 * Orbital elements are fetched, stored and shipped to the client, which
 * propagates them locally with SGP4.
 *
 * That is a deliberate architectural choice, not laziness. A satellite's
 * position is a deterministic function of (elements, time) -- so
 * propagating it server-side and streaming the result would mean paying
 * per client, every tick, for a number the client can compute for free.
 * The orbital layer therefore costs the server one 6-hourly fetch and
 * nothing else, no matter how many people are watching.
 */
export async function fetchTles(
  group: string,
  signal?: AbortSignal,
): Promise<{ tles: TleRecord[]; raw: FetchResult }> {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(
    group,
  )}&FORMAT=tle`;
  const raw = await fetchText(url, {
    bucket: celestrakBucket,
    signal,
    timeoutMs: 30_000,
  });
  if (!raw.ok) return { tles: [], raw };

  const lines = raw.body.split('\n').map((l) => l.trimEnd());
  const tles: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] ?? '').trim();
    const l1 = lines[i + 1] ?? '';
    const l2 = lines[i + 2] ?? '';
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const norad = Number(l1.slice(2, 7).trim());
    if (!Number.isFinite(norad)) continue;
    tles.push({ noradId: norad, name, line1: l1, line2: l2, group });
  }
  return { tles, raw };
}

/** Groups worth watching. `active` is 11k+ objects and mostly debris. */
export const TLE_GROUPS = [
  'stations',
  'visual',
  'resource', // earth observation
  'sarsat',
  'planet',
  'spire',
  'starlink',
  'military', // not an official group on all mirrors; failure is tolerated
] as const;

/* ---------------------------------------------------------------- media */

/**
 * GDELT is the corroboration layer. A detection with no reporting around
 * it is still a detection -- but one with reporting is an incident with a
 * name, and the Case File should carry the citations.
 */
export async function fetchGdelt(
  query: string,
  signal?: AbortSignal,
): Promise<{ articles: { url: string; title: string; ts: number; domain: string }[]; raw: FetchResult }> {
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?' +
    new URLSearchParams({
      query,
      mode: 'ArtList',
      maxrecords: '20',
      format: 'json',
      timespan: '3h',
    });
  const raw = await fetchText(url, { bucket: gdeltBucket, signal });
  if (!raw.ok) return { articles: [], raw };

  const j = safeJson<{
    articles?: { url: string; title: string; seendate: string; domain: string }[];
  }>(raw.body, url);

  const articles = (j?.articles ?? []).map((a) => ({
    url: a.url,
    title: a.title,
    domain: a.domain,
    // GDELT seendate is YYYYMMDDTHHMMSSZ
    ts:
      Date.parse(
        a.seendate?.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z',
        ) ?? '',
      ) || Date.now(),
  }));
  return { articles, raw };
}
