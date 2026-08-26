/**
 * DEADRECKON :: source registry.
 *
 * Single source of truth for what we ingest, under what licence, and
 * whether it needs a key. The API serves this verbatim at /api/sources and
 * the console renders it in the footer -- if we cannot state the licence
 * for a feed, we should not be ingesting the feed.
 *
 * IDs are persisted in Postgres. Never renumber, only append.
 */

import { Domain, type SourceDef } from './types.js';

export const SOURCES: SourceDef[] = [
  {
    id: 1,
    key: 'adsb_lol',
    domain: Domain.AIR,
    label: 'adsb.lol community ADS-B',
    license: 'ODbL 1.0 -- community-fed, no key required',
    homepage: 'https://api.adsb.lol/docs',
    requiresKey: false,
  },
  {
    id: 2,
    key: 'opensky',
    domain: Domain.AIR,
    label: 'OpenSky Network state vectors',
    license: 'CC BY-SA 4.0 -- non-commercial without agreement',
    homepage: 'https://openskynetwork.github.io/opensky-api/',
    requiresKey: false,
  },
  {
    id: 3,
    key: 'aisstream',
    domain: Domain.SEA,
    label: 'aisstream.io global AIS',
    license: 'Free tier, attribution required',
    homepage: 'https://aisstream.io/documentation',
    requiresKey: true,
  },
  {
    id: 4,
    key: 'celestrak',
    domain: Domain.ORBIT,
    label: 'CelesTrak GP element sets',
    license: 'Public domain (USSF catalogue), CelesTrak terms apply',
    homepage: 'https://celestrak.org/NORAD/elements/',
    requiresKey: false,
  },
  {
    id: 5,
    key: 'usgs_quake',
    domain: Domain.GEO,
    label: 'USGS earthquake feed',
    license: 'US Government work -- public domain',
    homepage: 'https://earthquake.usgs.gov/earthquakes/feed/',
    requiresKey: false,
  },
  {
    id: 6,
    key: 'nasa_firms',
    domain: Domain.THERMAL,
    label: 'NASA FIRMS active fire (VIIRS/MODIS)',
    license: 'NASA open data -- free key, attribution required',
    homepage: 'https://firms.modaps.eosdis.nasa.gov/api/',
    requiresKey: true,
  },
  {
    id: 7,
    key: 'gdelt',
    domain: Domain.MEDIA,
    label: 'GDELT 2.0 document corpus',
    license: 'Free for research and commercial use with attribution',
    homepage: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
    requiresKey: false,
  },
];

export const SOURCE_BY_KEY = new Map(SOURCES.map((s) => [s.key, s]));
export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
