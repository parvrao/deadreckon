/**
 * DEADRECKON :: air domain.
 *
 * Two providers, one shape. adsb.lol needs no key and is the default;
 * OpenSky is used when credentials exist because it gives global coverage
 * in one call. Either way the rest of the system never finds out which
 * one answered.
 *
 * Polling strategy matters more than provider choice. We do NOT scrape
 * the whole planet every ten seconds -- that is both antisocial and
 * pointless. We poll:
 *
 *   1. the watchboxes, at high cadence (where absence is meaningful)
 *   2. /v2/mil globally (military ADS-B, low volume, high signal)
 *   3. the three emergency squawks globally (7500/7600/7700)
 *
 * Targeted polling is why this fits in a free tier and still catches the
 * things a global scrape would drown.
 */

import { Domain, ObsFlag, type Observation } from '@deadreckon/core';
import { fetchText, safeJson, TokenBucket, type FetchResult } from '../http.js';

export const AIR_PARSER_VERSION = 'air/3';

/** adsb.lol asks for restraint; one request per second is well inside it. */
export const adsbBucket = new TokenBucket(6, 1);
export const openskyBucket = new TokenBucket(2, 0.25);

const FT_TO_M = 0.3048;

/* ------------------------------------------------------------- adsb.lol */

interface AdsbAircraft {
  hex?: string;
  type?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  nic?: number;
  nac_p?: number;
  seen_pos?: number;
  dbFlags?: number;
}

interface AdsbResponse {
  ac?: AdsbAircraft[];
  aircraft?: AdsbAircraft[];
  now?: number;
  total?: number;
}

export interface AirFetch {
  observations: Observation[];
  raw: FetchResult;
}

/** Circle query. adsb.lol caps radius at 250 nm. */
export async function fetchAdsbCircle(
  lat: number,
  lon: number,
  distNm: number,
  signal?: AbortSignal,
): Promise<AirFetch> {
  const r = Math.min(250, Math.max(1, Math.round(distNm)));
  const url = `https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${r}`;
  return runAdsb(url, signal);
}

/** Military-registered ADS-B, globally. Small payload, high signal density. */
export async function fetchAdsbMil(signal?: AbortSignal): Promise<AirFetch> {
  return runAdsb('https://api.adsb.lol/v2/mil', signal, ObsFlag.MILITARY);
}

/** 7500 hijack, 7600 radio failure, 7700 general emergency. */
export async function fetchAdsbSquawk(
  code: '7500' | '7600' | '7700',
  signal?: AbortSignal,
): Promise<AirFetch> {
  return runAdsb(
    `https://api.adsb.lol/v2/squawk/${code}`,
    signal,
    ObsFlag.EMERGENCY,
  );
}

async function runAdsb(
  url: string,
  signal?: AbortSignal,
  extraFlags = 0,
): Promise<AirFetch> {
  const raw = await fetchText(url, { bucket: adsbBucket, signal, timeoutMs: 15_000 });
  if (!raw.ok) return { observations: [], raw };

  const json = safeJson<AdsbResponse>(raw.body, url);
  const list = json?.ac ?? json?.aircraft ?? [];
  const nowMs = json?.now ? json.now * (json.now > 1e12 ? 1 : 1000) : Date.now();

  const out: Observation[] = [];
  for (const a of list) {
    if (a.hex == null || a.lat == null || a.lon == null) continue;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;

    const onGround = a.alt_baro === 'ground';
    const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom;

    let flags = extraFlags;
    if (onGround) flags |= ObsFlag.ON_GROUND;
    if (a.dbFlags && a.dbFlags & 1) flags |= ObsFlag.MILITARY;
    if (a.squawk === '7500' || a.squawk === '7600' || a.squawk === '7700')
      flags |= ObsFlag.EMERGENCY;
    if (a.emergency && a.emergency !== 'none') flags |= ObsFlag.EMERGENCY;

    // The GPS-jamming inference. An aircraft reporting low navigation
    // integrity is not broken -- it is a sensor telling us its GNSS
    // solution is being degraded. Thousands of them draw the jamming map.
    const nic = a.nic ?? null;
    const nacP = a.nac_p ?? null;
    if ((nic !== null && nic <= 4) || (nacP !== null && nacP <= 5)) {
      flags |= ObsFlag.GNSS_DEGRADED;
    }

    const seenPos = a.seen_pos ?? 0;

    out.push({
      ts: nowMs - seenPos * 1000,
      domain: Domain.AIR,
      entityId: `air:${a.hex.trim().toLowerCase()}`,
      lat: a.lat,
      lon: a.lon,
      altM: altFt != null ? altFt * FT_TO_M : null,
      sogKt: a.gs ?? null,
      cogDeg: a.track ?? null,
      flags,
      conf: seenPos < 15 ? 240 : seenPos < 60 ? 180 : 110,
      props: {
        label: (a.flight ?? a.r ?? a.hex).trim(),
        kind: a.t ?? a.category ?? null,
        reg: a.r ?? null,
        squawk: a.squawk ?? null,
        nic,
        nacP,
        emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
      },
    });
  }
  return { observations: out, raw };
}

/* -------------------------------------------------------------- OpenSky */

let openskyToken: { value: string; expiresAt: number } | null = null;

async function openskyAuth(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (openskyToken && Date.now() < openskyToken.expiresAt - 30_000) {
    return openskyToken.value;
  }

  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret,
      }),
    },
  ).catch(() => null);

  if (!res?.ok) {
    console.error('[air] OpenSky auth failed:', res?.status);
    return null;
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  openskyToken = {
    value: j.access_token,
    expiresAt: Date.now() + j.expires_in * 1000,
  };
  return openskyToken.value;
}

export async function fetchOpenSky(
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null,
  signal?: AbortSignal,
): Promise<AirFetch> {
  const token = await openskyAuth();
  const q = bbox
    ? `?lamin=${bbox.minLat}&lomin=${bbox.minLon}&lamax=${bbox.maxLat}&lomax=${bbox.maxLon}`
    : '';
  const url = `https://opensky-network.org/api/states/all${q}`;

  const raw = await fetchText(url, {
    bucket: openskyBucket,
    signal,
    timeoutMs: 25_000,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!raw.ok) return { observations: [], raw };

  const json = safeJson<{ time: number; states: unknown[][] | null }>(raw.body, url);
  const states = json?.states ?? [];
  const out: Observation[] = [];

  for (const s of states) {
    const icao = s[0] as string | null;
    const lon = s[5] as number | null;
    const lat = s[6] as number | null;
    if (!icao || lat == null || lon == null) continue;

    const lastContact = (s[4] as number | null) ?? json?.time ?? 0;
    const onGround = Boolean(s[8]);
    const squawk = (s[14] as string | null) ?? null;
    let flags = onGround ? ObsFlag.ON_GROUND : 0;
    if (squawk === '7500' || squawk === '7600' || squawk === '7700')
      flags |= ObsFlag.EMERGENCY;

    out.push({
      ts: lastContact * 1000,
      domain: Domain.AIR,
      entityId: `air:${icao.trim().toLowerCase()}`,
      lat,
      lon,
      altM: (s[13] as number | null) ?? (s[7] as number | null) ?? null,
      // OpenSky reports velocity in m/s; the rest of the system is knots.
      sogKt: s[9] != null ? (s[9] as number) / 0.514444 : null,
      cogDeg: (s[10] as number | null) ?? null,
      flags,
      conf: 200,
      props: {
        label: ((s[1] as string) ?? icao).trim(),
        country: (s[2] as string) ?? null,
        squawk,
      },
    });
  }
  return { observations: out, raw };
}
