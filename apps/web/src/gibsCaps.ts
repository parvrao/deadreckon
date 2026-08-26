/**
 * DEADRECKON :: GIBS capability resolution.
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Every GIBS layer is addressed as
 *
 *   /wmts/epsg3857/best/{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.{ext}
 *
 * and three of those four variables differ per layer:
 *
 *   TileMatrixSet   `GoogleMapsCompatible_Level{N}` where N is that
 *                   layer's own maximum zoom
 *   ext             png for most science products, jpg for imagery
 *   time            the newest date the product actually has
 *
 * gibs.ts carries a hand-written guess for each. Those guesses were wrong
 * for at least three layers, and a wrong value does not fail loudly: the
 * tiles 404, MapLibre draws nothing, and the layer is indistinguishable
 * from a layer that is working and happens to have no data that day. The
 * console filled with several hundred 404s per toggle.
 *
 * Guessing harder is not the fix. GIBS publishes the authoritative answer
 * in its own GetCapabilities document, so this module reads it and lets
 * NASA be the source of truth for NASA's own metadata. If the fetch fails
 * we fall back to the guesses in gibs.ts, so this can only ever improve
 * on the previous behaviour.
 *
 * ---------------------------------------------------------------------
 * COST, AND WHY IT IS PAID OFF THE CRITICAL PATH
 *
 * The EPSG:3857 capabilities document covers over a thousand layers and
 * runs to several megabytes. That is far too much to block first paint on,
 * so:
 *
 *   - the fetch is kicked off from requestIdleCallback after the map has
 *     loaded, never before
 *   - only the eleven layers this app offers are extracted; the parsed
 *     result is a handful of small records
 *   - that result, not the XML, is cached in localStorage for a week
 *
 * So it is one background fetch per user per week, and zero on a warm
 * cache. If it never completes, nothing breaks.
 */

export interface ResolvedLayer {
  /** Verbatim from GIBS, e.g. "GoogleMapsCompatible_Level6". */
  tileMatrixSet: string;
  /** Trailing integer of the above, for MapLibre's `maxzoom`. */
  maxZoom: number;
  ext: 'jpg' | 'png';
  /**
   * GIBS' own notion of the newest usable date for this layer, from the
   * Time dimension's <Default>. Null for non-temporal layers.
   *
   * This is strictly better than subtracting a guessed number of days
   * from today: products have different and occasionally variable
   * latency, and GIBS already knows what it has.
   */
  defaultTime: string | null;
}

const CAPS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml';

const CACHE_KEY = 'deadreckon.gibscaps.v1';
const CACHE_TTL_MS = 7 * 86_400_000;

interface CacheShape {
  fetchedAt: number;
  entries: Record<string, ResolvedLayer>;
}

/* -------------------------------------------------------------- helpers */

/** Direct children of `el` whose local name matches, namespace ignored. */
function kids(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i]!;
    if (c.localName === local) out.push(c);
  }
  return out;
}

function kidText(el: Element, local: string): string | null {
  const k = kids(el, local)[0];
  return k?.textContent?.trim() ?? null;
}

function extFromFormat(mime: string | null): 'jpg' | 'png' {
  // GIBS serves image/jpeg for photographic imagery and image/png for
  // anything with transparency or a colour ramp. Defaulting to png is the
  // safer error: a png request against a jpg-only layer 404s loudly,
  // whereas guessing jpg on a png layer can return an opaque black tile
  // that quietly covers the globe.
  return mime && /jpe?g/i.test(mime) ? 'jpg' : 'png';
}

function levelOf(tms: string): number {
  const m = /(\d+)\s*$/.exec(tms);
  return m ? Number(m[1]) : 8;
}

/**
 * Pull the Time dimension's default value.
 *
 * A Layer may carry several Dimension elements; only the one whose own
 * Identifier is "Time" is the date. Its <Default> is what GIBS resolves
 * an unspecified date to, which is exactly the value we want.
 */
function timeDefault(layer: Element): string | null {
  for (const d of kids(layer, 'Dimension')) {
    if (kidText(d, 'Identifier') === 'Time') {
      const def = kidText(d, 'Default');
      if (def) return def.slice(0, 10);
      // Some layers omit Default and give only Value ranges of the form
      // "start/end/period". The end of the last range is the newest date.
      const vals = kids(d, 'Value');
      const last = vals[vals.length - 1]?.textContent?.trim();
      if (last) {
        const parts = last.split('/');
        if (parts.length >= 2) return parts[1]!.slice(0, 10);
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------- parsing */

export function parseCapabilities(
  xml: string,
  wanted: ReadonlySet<string>,
): Record<string, ResolvedLayer> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  // A malformed document parses into a <parsererror> root rather than
  // throwing, so this has to be checked explicitly.
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('capabilities document did not parse as XML');
  }

  const out: Record<string, ResolvedLayer> = {};
  const layers = doc.getElementsByTagName('Layer');

  for (let i = 0; i < layers.length; i++) {
    const el = layers[i]!;

    // The layer's own Identifier is a DIRECT child. Style and Dimension
    // both also contain an Identifier, so a descendant search here would
    // happily return "default" for every layer in the document.
    const id = kidText(el, 'Identifier');
    if (!id || !wanted.has(id)) continue;

    const tms = kids(el, 'TileMatrixSetLink')
      .map((k) => kidText(k, 'TileMatrixSet'))
      .find((v): v is string => !!v);
    if (!tms) continue;

    out[id] = {
      tileMatrixSet: tms,
      maxZoom: levelOf(tms),
      ext: extFromFormat(kidText(el, 'Format')),
      defaultTime: timeDefault(el),
    };
  }

  return out;
}

/* --------------------------------------------------------------- caching */

function readCache(): Record<string, ResolvedLayer> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CacheShape;
    if (!c.fetchedAt || Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
    return c.entries ?? null;
  } catch {
    // Private browsing, a full quota, or a corrupt entry. All of these
    // mean "no cache", none of them mean "fail".
    return null;
  }
}

function writeCache(entries: Record<string, ResolvedLayer>): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), entries } satisfies CacheShape),
    );
  } catch {
    /* cache is an optimisation, never a requirement */
  }
}

/* ---------------------------------------------------------------- public */

let inFlight: Promise<Record<string, ResolvedLayer>> | null = null;

/**
 * Resolve the given GIBS layer identifiers, from cache if possible.
 *
 * Never rejects. On any failure it resolves to an empty object, which
 * callers treat as "keep using the fallbacks in gibs.ts".
 */
export function resolveGibsLayers(
  ids: readonly string[],
): Promise<Record<string, ResolvedLayer>> {
  const cached = readCache();
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  const wanted = new Set(ids);

  inFlight = (async () => {
    try {
      // 20s is generous for a multi-megabyte document on a slow line, and
      // this is background work, but it must not hang forever.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);

      const res = await fetch(CAPS_URL, {
        signal: ctl.signal,
        // Let the browser and NASA's CDN share the cost across sessions.
        cache: 'force-cache',
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`capabilities HTTP ${res.status}`);

      const entries = parseCapabilities(await res.text(), wanted);

      const found = Object.keys(entries).length;
      if (!found) throw new Error('no requested layers present in capabilities');

      writeCache(entries);
      console.info(
        `[gibs] resolved ${found}/${wanted.size} layers from GetCapabilities`,
      );
      return entries;
    } catch (err) {
      console.warn(
        `[gibs] could not resolve layers from GetCapabilities ` +
          `(${(err as Error).message}). Falling back to the hardcoded ` +
          `values in gibs.ts, which are known to be wrong for some layers.`,
      );
      return {};
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Which layers GIBS says do not exist under the ids we asked for. */
export function missingFrom(
  ids: readonly string[],
  resolved: Record<string, ResolvedLayer>,
): string[] {
  if (!Object.keys(resolved).length) return [];
  return ids.filter((i) => !(i in resolved));
}
