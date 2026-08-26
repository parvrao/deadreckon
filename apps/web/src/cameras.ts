/**
 * DEADRECKON :: public infrastructure cameras.
 *
 * Live camera feeds from open-data transport authorities, fetched straight
 * from the browser and never stored. There is no camera table, no retention
 * policy and no image ever written to the archive: a frame is requested,
 * displayed, and replaced by the next one.
 *
 * That is a deliberate line, not a shortcut. The rest of this system exists
 * to record everything so that nobody has to press record. Cameras are the
 * one input where that instinct is wrong, because a searchable archive of
 * street imagery is a different kind of object from a searchable archive of
 * AIS positions, and it is not the kind of object I want this to be.
 *
 * Scope: roads, ports, canals and waterways. Infrastructure, where the
 * subject is a lock gate or a motorway junction. Not cameras pointed at
 * people, not anything indoors, and no face-legible framing by design --
 * these feeds are wide traffic views by nature.
 *
 * All three sources below are official open-data endpoints published by the
 * operating authority for exactly this purpose.
 */

export interface CameraSource {
  id: string;
  title: string;
  authority: string;
  licence: string;
  /** Refresh cadence the operator publishes. Most are stills, not video. */
  refreshS: number;
  attribution: string;
  homepage: string;
}

export interface Camera {
  id: string;
  source: string;
  label: string;
  lat: number;
  lon: number;
  /** Still-image URL. Cache-busted on each refresh. */
  image: string;
}

export const CAMERA_SOURCES: CameraSource[] = [
  {
    id: 'tfl',
    title: 'London JamCams',
    authority: 'Transport for London',
    licence: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights',
    refreshS: 60,
    attribution: 'Powered by TfL Open Data',
    homepage: 'https://api.tfl.gov.uk/',
  },
  {
    id: 'ndw',
    title: 'Netherlands motorways',
    authority: 'Rijkswaterstaat / NDW',
    licence: 'CC0 / public open data',
    refreshS: 60,
    attribution: 'Rijkswaterstaat open data',
    homepage: 'https://www.ndw.nu/',
  },
  {
    id: 'wsdot',
    title: 'Washington State',
    authority: 'WSDOT',
    licence: 'Public domain, attribution requested',
    refreshS: 120,
    attribution: 'WSDOT traveler information',
    homepage: 'https://wsdot.wa.gov/traffic/api/',
  },
];

/* --------------------------------------------------------------- TfL */

interface TflPlace {
  id: string;
  commonName: string;
  lat: number;
  lon: number;
  additionalProperties?: { key: string; value: string }[];
}

/**
 * TfL's JamCams. No key needed for this endpoint, and the still image URL
 * arrives in the record's additionalProperties as `imageUrl`.
 */
export async function fetchTfl(): Promise<Camera[]> {
  const res = await fetch(
    'https://api.tfl.gov.uk/Place/Type/JamCam?' +
      new URLSearchParams({ app_key: '' }).toString().replace('app_key=', ''),
  );
  if (!res.ok) throw new Error(`TfL HTTP ${res.status}`);
  const places = (await res.json()) as TflPlace[];

  return places
    .map((p) => {
      const img = p.additionalProperties?.find(
        (a) => a.key === 'imageUrl' || a.key === 'videoUrl',
      );
      if (!img?.value || !Number.isFinite(p.lat)) return null;
      // Prefer the still; a .mp4 will not render in an <img>.
      const url = img.value.replace(/\.mp4$/, '.jpg');
      return {
        id: `tfl:${p.id}`,
        source: 'tfl',
        label: p.commonName.replace(/^JamCam\s*/i, ''),
        lat: p.lat,
        lon: p.lon,
        image: url,
      } satisfies Camera;
    })
    .filter((c): c is Camera => c !== null);
}

/* ------------------------------------------------------------- loader */

export interface CameraLoadResult {
  cameras: Camera[];
  errors: { source: string; message: string }[];
}

/**
 * Load whatever answers. One source failing must not take the layer down;
 * a partial camera layer is useful and a missing one is not.
 */
export async function loadCameras(): Promise<CameraLoadResult> {
  const errors: { source: string; message: string }[] = [];
  const cameras: Camera[] = [];

  const results = await Promise.allSettled([fetchTfl()]);
  const ids = ['tfl'];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') cameras.push(...r.value);
    else errors.push({ source: ids[i]!, message: String(r.reason?.message ?? r.reason) });
  });

  return { cameras, errors };
}

/** Cache-busted image URL, so a still actually refreshes. */
export function frameUrl(c: Camera): string {
  const sep = c.image.includes('?') ? '&' : '?';
  return `${c.image}${sep}t=${Math.floor(Date.now() / 30_000)}`;
}

export const CAMERA_ATTRIBUTION = CAMERA_SOURCES.map((s) => s.attribution).join(' · ');
