/**
 * DEADRECKON :: NASA GIBS layer catalog.
 *
 * GIBS publishes 1,175 layers. Almost all of them are irrelevant here, and
 * a layer picker with 1,175 entries is worse than one with none. What
 * follows is a deliberate shortlist: layers where the imagery answers a
 * question this system is actually asking.
 *
 * Every one is US federal work, effectively public domain, no API key.
 *
 * ---------------------------------------------------------------------
 * THE `matrix`, `ext` AND `lagDays` FIELDS ARE FALLBACKS, NOT TRUTH
 *
 * GIBS addresses Web Mercator tiles as
 *   /wmts/epsg3857/best/{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.{ext}
 * where TileMatrixSet is `GoogleMapsCompatible_Level{N}` and N is that
 * layer's maximum zoom. N differs per layer, as do the image format and
 * the newest date the product actually holds.
 *
 * The values below are hand-written guesses following GIBS' documented
 * conventions, and they were WRONG for at least MODIS_Terra_Aerosol,
 * OMI_Nitrogen_Dioxide_Tropo_Column and IMERG_Precipitation_Rate: each
 * fired several hundred 404s per toggle and drew nothing. A wrong value
 * does not announce itself, because a 404 tile and an empty tile look
 * identical on the globe.
 *
 * So these are no longer the source of truth. gibsCaps.ts reads GIBS'
 * own GetCapabilities document in the background and overrides all three
 * fields with NASA's answer. These remain only as the offline fallback
 * for when that fetch fails, and any one of them may still be wrong.
 * ---------------------------------------------------------------------
 */

import type { ResolvedLayer } from './gibsCaps.js';

export type LayerKind = 'base' | 'overlay';

export interface GibsLayer {
  id: string;
  /** GIBS layer identifier. */
  layer: string;
  title: string;
  kind: LayerKind;
  group: string;
  /** GoogleMapsCompatible_Level{N}. */
  matrix: number;
  ext: 'jpg' | 'png';
  /** Daily layers need a date in the path; static ones use "default". */
  temporal: boolean;
  /** Why this is here, in one line. Shown in the panel. */
  why: string;
  /** Sensible default opacity for overlays. */
  opacity?: number;
  /** Days to subtract from today. Some products lag by a day or two. */
  lagDays?: number;
}

export const GIBS_LAYERS: GibsLayer[] = [
  /* ------------------------------------------------------------ base */
  {
    id: 'bluemarble',
    layer: 'BlueMarble_ShadedRelief_Bathymetry',
    title: 'Blue Marble',
    kind: 'base',
    group: 'Imagery',
    matrix: 8,
    ext: 'jpg',
    temporal: false,
    why: 'Cloud-free natural colour with terrain relief and ocean bathymetry. Static, so it never has gaps.',
  },
  {
    id: 'truecolor',
    layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    title: 'Today, true colour',
    kind: 'base',
    group: 'Imagery',
    matrix: 9,
    ext: 'jpg',
    temporal: true,
    lagDays: 1,
    why: 'What the planet actually looked like yesterday, clouds and all. Where the weather is is often why traffic moved.',
  },
  {
    id: 'nightlights',
    layer: 'VIIRS_SNPP_DayNightBand_ENCC',
    title: 'Night lights',
    kind: 'base',
    group: 'Imagery',
    matrix: 8,
    ext: 'png',
    temporal: true,
    lagDays: 1,
    why: 'VIIRS day/night band. Cities, gas flares, fishing fleets and, when a region goes dark, the absence of all of them.',
  },
  {
    id: 'falsecolor',
    layer: 'MODIS_Terra_CorrectedReflectance_Bands721',
    title: 'False colour 7-2-1',
    kind: 'base',
    group: 'Imagery',
    matrix: 9,
    ext: 'jpg',
    temporal: true,
    lagDays: 1,
    why: 'Burn scars read deep red, active fire orange, ice cyan. Sees through haze that hides detail in true colour.',
  },

  /* --------------------------------------------------------- overlays */
  {
    id: 'thermal',
    layer: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All',
    title: 'Thermal anomalies',
    kind: 'overlay',
    group: 'Energy',
    matrix: 7,
    ext: 'png',
    temporal: true,
    opacity: 0.9,
    why: 'The same VIIRS fire detections the THERMAL_ANOMALY rule fires on, as imagery. Fires, flare stacks, and things that just started burning.',
  },
  {
    id: 'no2',
    layer: 'OMI_Nitrogen_Dioxide_Tropo_Column',
    title: 'Nitrogen dioxide',
    kind: 'overlay',
    group: 'Energy',
    matrix: 6,
    ext: 'png',
    temporal: true,
    lagDays: 2,
    opacity: 0.6,
    why: 'Tropospheric NO2 tracks combustion: heavy industry, power generation and shipping lanes. A plant coming on or going off shows up here.',
  },
  {
    id: 'aerosol',
    layer: 'MODIS_Terra_Aerosol',
    title: 'Aerosol depth',
    kind: 'overlay',
    group: 'Energy',
    matrix: 6,
    ext: 'png',
    temporal: true,
    lagDays: 1,
    opacity: 0.55,
    why: 'Smoke, dust and industrial haze. A plume has a source, and the source is usually the interesting part.',
  },
  {
    id: 'sst',
    layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    title: 'Sea surface temp',
    kind: 'overlay',
    group: 'Ocean',
    matrix: 7,
    ext: 'png',
    temporal: true,
    lagDays: 2,
    opacity: 0.55,
    why: 'Fronts and eddies steer both fishing fleets and anyone trying to move quietly.',
  },
  {
    id: 'seaice',
    layer: 'AMSR2_Sea_Ice_Concentration_12km',
    title: 'Sea ice',
    kind: 'overlay',
    group: 'Ocean',
    matrix: 6,
    ext: 'png',
    temporal: true,
    lagDays: 1,
    opacity: 0.7,
    why: 'Which Arctic routes are open. The Northern Sea Route opening is a shipping event with a date.',
  },
  {
    id: 'precip',
    layer: 'IMERG_Precipitation_Rate',
    title: 'Precipitation',
    kind: 'overlay',
    group: 'Weather',
    matrix: 6,
    ext: 'png',
    temporal: true,
    opacity: 0.5,
    why: 'Weather reroutes aircraft, and a weather reroute is the most common innocent explanation for an airspace void.',
  },
  {
    id: 'snow',
    layer: 'MODIS_Terra_Snow_Cover',
    title: 'Snow cover',
    kind: 'overlay',
    group: 'Weather',
    matrix: 8,
    ext: 'png',
    temporal: true,
    lagDays: 1,
    opacity: 0.6,
    why: 'Seasonal ground truth. Also what makes a false-colour scene readable in winter.',
  },
];

export const BASE_LAYERS = GIBS_LAYERS.filter((l) => l.kind === 'base');
export const OVERLAY_LAYERS = GIBS_LAYERS.filter((l) => l.kind === 'overlay');

export const OVERLAY_GROUPS = [...new Set(OVERLAY_LAYERS.map((l) => l.group))];

/** GIBS has no HTTP/2, so sharding across its three hosts is a real win. */
const HOSTS = ['gibs-a', 'gibs-b', 'gibs-c'];

function isoDay(lagDays: number): string {
  const d = new Date(Date.now() - lagDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------- resolved overrides */

/**
 * Authoritative per-layer metadata from GIBS, keyed by GIBS layer
 * identifier. Populated once by main.ts after the map has loaded.
 */
const RESOLVED = new Map<string, ResolvedLayer>();

/** Every GIBS layer identifier this app can request. */
export const GIBS_LAYER_IDS: readonly string[] = GIBS_LAYERS.map((l) => l.layer);

/**
 * Adopt GIBS' own metadata. Returns the ids that actually changed, so the
 * caller knows whether existing sources need rebuilding.
 */
export function applyResolved(entries: Record<string, ResolvedLayer>): string[] {
  const changed: string[] = [];
  for (const l of GIBS_LAYERS) {
    const r = entries[l.layer];
    if (!r) continue;
    const differs =
      r.tileMatrixSet !== `GoogleMapsCompatible_Level${l.matrix}` ||
      r.ext !== l.ext;
    RESOLVED.set(l.layer, r);
    if (differs) {
      changed.push(l.id);
      console.info(
        `[gibs] ${l.layer}: guessed ` +
          `GoogleMapsCompatible_Level${l.matrix}/.${l.ext}, GIBS says ` +
          `${r.tileMatrixSet}/.${r.ext}`,
      );
    }
  }
  return changed;
}

export function resolvedFor(l: GibsLayer): ResolvedLayer | undefined {
  return RESOLVED.get(l.layer);
}

/** MapLibre's `maxzoom` for this layer's raster source. */
export function effectiveMaxZoom(l: GibsLayer): number {
  return resolvedFor(l)?.maxZoom ?? l.matrix;
}

/** The date a layer is currently being requested at, or null if static. */
export function effectiveDate(l: GibsLayer): string | null {
  if (!l.temporal) return null;
  return resolvedFor(l)?.defaultTime ?? isoDay(l.lagDays ?? 0);
}

/**
 * The previous day, for one retry after a temporal layer 404s.
 *
 * Daily products land at different times and some slip. Rather than
 * encode a per-product latency I cannot verify, we ask for the newest
 * date and step back exactly once if that is not there yet. One retry
 * covers the common case without turning a dead layer into a crawl
 * backwards through the archive.
 */
export function previousDate(current: string): string {
  const t = Date.parse(`${current}T00:00:00Z`);
  if (Number.isNaN(t)) return current;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** Tile URL templates for a layer, one per GIBS host. */
export function tileUrls(l: GibsLayer, dateOverride?: string): string[] {
  const r = resolvedFor(l);
  const tms = r?.tileMatrixSet ?? `GoogleMapsCompatible_Level${l.matrix}`;
  const ext = r?.ext ?? l.ext;
  const time = !l.temporal
    ? 'default'
    : (dateOverride ?? r?.defaultTime ?? isoDay(l.lagDays ?? 0));

  return HOSTS.map(
    (h) =>
      `https://${h}.earthdata.nasa.gov/wmts/epsg3857/best/${l.layer}` +
      `/default/${time}/${tms}/{z}/{y}/{x}.${ext}`,
  );
}

export const GIBS_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>';
