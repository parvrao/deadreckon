/**
 * DEADRECKON :: basemap.
 *
 * A photorealistic globe assembled entirely from sources that are free,
 * keyless, and licence-clean for an AGPL project. That last constraint
 * eliminated most of the obvious candidates:
 *
 *   EOX s2cloudless   CC BY-NC-SA, and explicitly forbids sub-licensing.
 *                     The NC clause alone is incompatible with AGPL
 *                     redistribution. MapLibre's own globe demo uses it,
 *                     which is fine for a demo and not for a deploy.
 *   Esri World Imagery  answers anonymously, but the terms of use require
 *                     an ArcGIS subscription and forbid redistributing
 *                     basemap tiles. Baking that URL into a public repo
 *                     grants downstream users a right we do not hold.
 *   CARTO             now requires an API key, and its terms forbid
 *                     derivative styles.
 *   Google            terms forbid use alongside a non-Google map.
 *
 * What survived:
 *
 *   NASA GIBS         US federal work, effectively public domain. No key.
 *                     Attribution requested rather than required, and we
 *                     give it anyway.
 *   OpenFreeMap       MIT, no key, no registration, commercial use
 *                     explicitly permitted, unmodified OpenMapTiles schema.
 *
 * The honest limitation: GIBS Blue Marble tops out at zoom 8. Past that
 * MapLibre overzooms the z8 tiles, so imagery softens while the vector
 * boundaries and labels stay crisp. For sharp imagery at street level you
 * need a commercial provider, which is offered below as a bring-your-own
 * token rather than shipped as a default.
 */

import type { StyleSpecification } from 'maplibre-gl';

/** GIBS does not support HTTP/2, so sharding is a real throughput win. */
const GIBS = ['https://gibs-a', 'https://gibs-b', 'https://gibs-c'].map(
  (h) =>
    `${h}.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry` +
    `/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg`,
);

const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

const ATTRIB_IMAGERY =
  'Imagery <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>';
const ATTRIB_VECTOR =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap</a>';

export type Projection = 'globe' | 'flat';

/**
 * `globe`, not `vertical-perspective`.
 *
 * I originally chose `vertical-perspective` because MapLibre's `globe` is
 * a preset that interpolates to flat Mercator between z10 and z12, and
 * unwrapping the planet as you zoom into a chokepoint felt wrong.
 *
 * deck.gl disagrees, loudly. Its MapLibre integration recognises `globe`
 * and throws `Unsupported projection` on `vertical-perspective`, which
 * means EVERY deck layer fails: no contacts, no reachable-set cone, no
 * track, and the Case File dies while rendering. The data was arriving
 * the whole time -- 1,805 entities in the shared snapshot -- and nothing
 * could be drawn.
 *
 * A globe that flattens above z12 is a cosmetic compromise. A globe that
 * cannot render a single contact is not a globe, it is wallpaper. So:
 * `globe`, and the flattening is the price.
 */
export function buildStyle(projection: Projection): StyleSpecification {
  return {
    version: 8,
    projection: {
      type: projection === 'globe' ? 'globe' : 'mercator',
    },
    glyphs: GLYPHS,
    sources: {
      satellite: {
        type: 'raster',
        tiles: GIBS,
        tileSize: 256,
        // Blue Marble stops here. MapLibre overzooms beyond it rather
        // than showing holes, which is the right failure mode.
        maxzoom: 8,
        attribution: ATTRIB_IMAGERY,
      },
      omt: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: ATTRIB_VECTOR,
      },
      // Populated at runtime from /api/watchboxes. Declared empty so the
      // style validates before the API has answered.
      watchboxes: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      },
    },
    // Space behind the globe.
    sky: {
      'sky-color': '#04070B',
      'horizon-color': '#0B2136',
      'fog-color': '#04070B',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.1,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 6, 0.35, 9, 0],
    },
    light: { anchor: 'map', position: [1.5, 90, 80] },
    layers: [
      {
        id: 'space',
        type: 'background',
        paint: { 'background-color': '#04070B' },
      },
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        paint: {
          // Knocked back so amber and cyan contacts stay the brightest
          // thing on screen. Legible Earth, not a wallpaper.
          'raster-opacity': 0.82,
          'raster-saturation': -0.25,
          'raster-contrast': 0.08,
          'raster-brightness-max': 0.9,
        },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: [
          'all',
          ['==', ['get', 'admin_level'], 2],
          ['!=', ['get', 'maritime'], 1],
          ['!=', ['get', 'disputed'], 1],
        ],
        paint: {
          'line-color': '#8FD3E8',
          'line-opacity': 0.5,
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.1],
        },
      },
      {
        id: 'boundary-disputed',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['==', ['get', 'disputed'], 1],
        paint: {
          'line-color': '#8FD3E8',
          'line-opacity': 0.4,
          'line-width': 0.9,
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'label-country',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 12, 8, 15],
          'text-letter-spacing': 0.14,
          'text-transform': 'uppercase',
          'text-max-width': 7,
        },
        paint: {
          'text-color': '#DCE9F2',
          'text-halo-color': 'rgba(2,5,10,0.9)',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'label-marine',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'water_name',
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 8, 13],
          'text-letter-spacing': 0.1,
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#7FC6DE',
          'text-halo-color': 'rgba(2,5,10,0.85)',
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'label-place',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 4,
        filter: ['in', ['get', 'class'], ['literal', ['state', 'city', 'town']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14],
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#9FB8CC',
          'text-halo-color': 'rgba(2,5,10,0.9)',
          'text-halo-width': 1.3,
        },
      },

      /* ---- watchboxes, as MapLibre layers rather than deck.gl ----------
       *
       * deck.gl's TextLayer has open, unfixed bugs on the globe: it can
       * render at the origin, or upside down, and the fix was pulled from
       * the 9.3 milestone and left in draft. MapLibre symbol layers have
       * none of those problems and additionally give free label collision
       * against the basemap's own place names.
       *
       * The geometry is fed in at runtime from /api/watchboxes.
       */
      {
        id: 'wb-fill',
        type: 'fill',
        source: 'watchboxes',
        paint: { 'fill-color': '#00D9FF', 'fill-opacity': 0.06 },
      },
      {
        id: 'wb-line',
        type: 'line',
        source: 'watchboxes',
        paint: {
          'line-color': '#00D9FF',
          'line-opacity': 0.55,
          'line-width': 1.2,
          'line-dasharray': [4, 3],
        },
      },
      {
        id: 'wb-label',
        type: 'symbol',
        source: 'watchboxes',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-letter-spacing': 0.16,
          'text-transform': 'uppercase',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#00D9FF',
          'text-halo-color': 'rgba(2,5,10,0.9)',
          'text-halo-width': 1.4,
        },
      },
    ],
  } as unknown as StyleSpecification;
}

export interface WatchBox {
  key: string;
  label: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}

/** Watchboxes as GeoJSON, for the MapLibre source declared above. */
export function watchboxGeoJSON(boxes: readonly WatchBox[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: boxes.map((b) => ({
      type: 'Feature',
      properties: { key: b.key, label: b.label },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [b.min_lon, b.min_lat],
            [b.max_lon, b.min_lat],
            [b.max_lon, b.max_lat],
            [b.min_lon, b.max_lat],
            [b.min_lon, b.min_lat],
          ],
        ],
      },
    })),
  };
}
