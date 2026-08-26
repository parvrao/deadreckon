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
 * A CAVEAT WORTH READING BEFORE TRUSTING THE `matrix` FIELD
 *
 * GIBS addresses Web Mercator tiles as
 *   /wmts/epsg3857/best/{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.{ext}
 * where TileMatrixSet is `GoogleMapsCompatible_Level{N}` and N is that
 * layer's maximum zoom. N differs per layer and is only authoritative in
 * GIBS' own GetCapabilities document.
 *
 * The values below follow GIBS' documented conventions but I have NOT
 * verified every one against GetCapabilities. A wrong N means the tiles
 * 404, which MapLibre renders as nothing rather than as an error. So the
 * panel tracks tile failures per layer and marks anything that is not
 * answering, instead of leaving you staring at a layer that silently
 * shows an empty globe. If one is marked unavailable, that is the likely
 * reason and the fix is one number.
 * ---------------------------------------------------------------------
 */

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

/** Tile URL templates for a layer, one per GIBS host. */
export function tileUrls(l: GibsLayer, dateOverride?: string): string[] {
  const time = l.temporal ? (dateOverride ?? isoDay(l.lagDays ?? 0)) : 'default';
  return HOSTS.map(
    (h) =>
      `https://${h}.earthdata.nasa.gov/wmts/epsg3857/best/${l.layer}` +
      `/default/${time}/GoogleMapsCompatible_Level${l.matrix}/{z}/{y}/{x}.${l.ext}`,
  );
}

export const GIBS_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>';
