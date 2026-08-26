/**
 * DEADRECKON :: THE WALL.
 *
 * An interactive globe with real satellite imagery, MapLibre 6 in
 * `vertical-perspective` projection, with deck.gl drawing the contacts and
 * evidence geometry over the top.
 *
 * This file used to open with three arguments against building a globe:
 * that photoreal tiles are the biggest cost line in a project like this,
 * that a globe hides half the planet, and that flat runs at 60 fps on weak
 * hardware. The first turned out to be false -- NASA GIBS is public domain
 * and free, so the imagery costs nothing. The second is real but is a
 * navigation problem, solved by the watchbox strip and the FLAT toggle,
 * not a reason to refuse the projection. The third still holds, which is
 * why flat Mercator is one click away and shares every layer.
 *
 * The honest cost of being wrong about this: a console that opened onto an
 * unlabelled dark rectangle for its entire first day.
 *
 * Rendering is driven from typed arrays rebuilt each frame, so a contact
 * costs eight floats rather than a JavaScript object graph.
 *
 * Text is deliberately NOT drawn with deck.gl here. TextLayer on a globe
 * has open bugs in deck.gl 9.3 (renders at the origin, or upside down),
 * and the fix was pulled from that milestone and left in draft. All labels
 * are MapLibre symbol layers instead, which also buys free collision
 * against the basemap's own place names. See basemap.ts.
 */

// MapLibre 6 removed the default export; everything is named now.
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type LngLatBounds,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer, PolygonLayer } from '@deck.gl/layers';
import { ObsFlag } from '@deadreckon/core';
import type { Contact } from './net.js';
import { buildStyle, watchboxGeoJSON, type Projection, type WatchBox } from './basemap.js';
import { GIBS_ATTRIBUTION, tileUrls, type GibsLayer } from './gibs.js';
import { frameUrl, type Camera } from './cameras.js';

export type { WatchBox };

export interface DetectionPin {
  id: number;
  rule: string;
  severity: number;
  lat: number;
  lon: number;
  title: string;
  ts: number;
}

type RGBA = [number, number, number, number];

const DOMAIN_COLOR: Record<number, RGBA> = {
  1: [255, 162, 0, 215], // air    -- amber
  2: [0, 217, 255, 215], // sea    -- cyan
  3: [167, 139, 250, 210], // orbit  -- violet
  4: [255, 122, 69, 235], // geo    -- ember
  5: [255, 77, 77, 235], // thermal-- red
};
const ALERT: RGBA = [255, 45, 85, 255];
const DEGRADED: RGBA = [255, 214, 102, 230];
const DARK: RGBA = [120, 140, 158, 170];

export class Wall {
  readonly map: MapLibreMap;
  private overlay: MapboxOverlay;

  private contacts: Contact[] = [];
  private positions = new Float32Array(0);
  private colors = new Uint8Array(0);
  private radii = new Float32Array(0);
  private vectors: { path: [number, number][]; color: RGBA }[] = [];

  private detections: DetectionPin[] = [];
  private watchboxes: WatchBox[] = [];
  private cone: [number, number][] | null = null;
  private track: [number, number][] = [];
  private satellites: { lon: number; lat: number; name: string }[] = [];
  private orbitVisible = true;
  private pulse = 0;
  private projection: Projection = 'globe';
  private styleReady = false;
  private activeBase = 'bluemarble';
  private activeOverlays = new Set<string>();
  private pendingBase: { l: GibsLayer; date?: string } | null = null;
  /** Layer ids whose tiles are 404ing or erroring. */
  private tileErrors = new Set<string>();
  private cameras: Camera[] = [];
  private camerasVisible = false;

  constructor(
    container: string,
    private readonly onPick: (c: Contact | null) => void,
    private readonly onDetectionPick: (d: DetectionPin) => void,
    private readonly onMove: (b: LngLatBounds, zoom: number) => void,
    private readonly onLayerError?: (id: string) => void,
    private readonly onCameraPick?: (c: Camera) => void,
  ) {
    this.map = new MapLibreMap({
      container,
      style: buildStyle(this.projection),
      center: [56.3, 26.5], // Strait of Hormuz
      zoom: 2.6,
      minZoom: 0.6,
      maxZoom: 14,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
    });

    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    this.map.addControl(
      new ScaleControl({ unit: 'nautical' as never }),
      'bottom-right',
    );

    // interleaved: false, deliberately.
    //
    // deck.gl 9.3 has an open bug (#10206) where, in interleaved mode on a
    // globe, ScatterplotLayer circles are not draped onto the sphere and
    // z-fight while panning. Overlaid mode renders deck to its own canvas
    // above MapLibre and sidesteps the whole class of problem. The cost is
    // that deck geometry always sits above the basemap labels, which for a
    // contact display is the correct stacking anyway.
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay as never);

    this.map.on('load', () => {
      this.styleReady = true;
      this.pushWatchboxes();
      if (this.pendingBase) {
        const { l, date } = this.pendingBase;
        this.pendingBase = null;
        this.setBaseLayer(l, date);
      }
      // A slow arc onto the watchbox, so the first thing you see is a
      // recognisable planet rather than a rectangle you have to decode.
      this.map.easeTo({ center: [56.3, 26.5], zoom: 4.6, duration: 2600 });
    });

    // Clicking a watchbox rectangle frames it.
    this.map.on('click', 'wb-fill', (e: MapLayerMouseEvent) => {
      const key = e.features?.[0]?.properties?.key;
      const b = this.watchboxes.find((w) => w.key === key);
      if (b) this.fitBox(b);
    });
    for (const id of ['wb-fill', 'wb-label']) {
      this.map.on('mouseenter', id, () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', id, () => {
        this.map.getCanvas().style.cursor = '';
      });
    }

    let t: number | undefined;
    const emit = (): void => {
      window.clearTimeout(t);
      t = window.setTimeout(
        () => this.onMove(this.map.getBounds(), this.map.getZoom()),
        220,
      );
    };
    this.map.on('moveend', emit);
    this.map.on('zoomend', emit);

    // Tile failures, attributed back to the layer that caused them.
    this.map.on('error', (e: unknown) => {
      const src = (e as { sourceId?: string }).sourceId;
      if (!src) return;
      const id = src === 'satellite' ? this.activeBase : src.replace(/^ov-/, '');
      if (!this.tileErrors.has(id)) {
        this.tileErrors.add(id);
        console.warn(
          `[wall] layer "${id}" is not serving tiles. Most likely its ` +
            `GoogleMapsCompatible_Level is wrong in gibs.ts.`,
        );
        this.onLayerError?.(id);
      }
    });

    // The panel collapsing changes this container's width, and MapLibre
    // only re-reads its canvas size when told to. Without this the canvas
    // keeps its old dimensions and the globe renders into a rectangle
    // smaller than the space it occupies -- which looks exactly like a
    // broken projection.
    const el = document.getElementById(container);
    if (el && 'ResizeObserver' in window) {
      let rt: number | undefined;
      new ResizeObserver(() => {
        window.clearTimeout(rt);
        rt = window.setTimeout(() => this.map.resize(), 80);
      }).observe(el);
    }

    // 8 fps is enough for a pulse and costs almost nothing.
    setInterval(() => {
      this.pulse = (this.pulse + 1) % 32;
      if (this.detections.length) this.render();
    }, 125);
  }

  /* ---------------------------------------------------------- projection */

  /**
   * Switch between the globe and a flat Mercator map.
   *
   * Both are useful for different work. The globe is how you understand
   * that the Strait of Hormuz and the Strait of Malacca are two ends of
   * the same tanker route. Mercator is how you actually read a chokepoint
   * at 5 nm across without the edges falling away from you.
   */
  setProjection(p: Projection): void {
    if (p === this.projection) return;
    this.projection = p;
    try {
      // `globe`, not `vertical-perspective`. deck.gl throws
      // "Unsupported projection" on the latter. See basemap.ts.
      this.map.setProjection({
        type: p === 'globe' ? 'globe' : 'mercator',
      } as never);
    } catch {
      // Older MapLibre without globe support. Rebuild the style instead of
      // leaving the console in a half-switched state.
      this.map.setStyle(buildStyle(p));
      this.map.once('styledata', () => this.pushWatchboxes());
    }
  }

  get currentProjection(): Projection {
    return this.projection;
  }

  /* ------------------------------------------------------- GIBS layers */

  /**
   * Swap the base imagery.
   *
   * Base layers are mutually exclusive, so this replaces the single
   * `satellite` raster source rather than stacking. MapLibre cannot
   * retarget a source's tile URLs in place, so the source and its layer
   * are removed and rebuilt, keeping the layer at the very bottom of the
   * draw order.
   */
  setBaseLayer(l: GibsLayer, date?: string): void {
    if (!this.styleReady) {
      this.pendingBase = { l, date };
      return;
    }
    this.activeBase = l.id;
    try {
      if (this.map.getLayer('satellite')) this.map.removeLayer('satellite');
      if (this.map.getSource('satellite')) this.map.removeSource('satellite');

      this.map.addSource('satellite', {
        type: 'raster',
        tiles: tileUrls(l, date),
        tileSize: 256,
        maxzoom: l.matrix,
        attribution: GIBS_ATTRIBUTION,
      });
      // Immediately above the background, below everything else.
      this.map.addLayer(
        {
          id: 'satellite',
          type: 'raster',
          source: 'satellite',
          paint: {
            'raster-opacity': 0.85,
            'raster-saturation': l.id === 'nightlights' ? 0.35 : -0.2,
            'raster-contrast': l.id === 'nightlights' ? 0.25 : 0.08,
          },
        },
        'boundary-country',
      );
    } catch (err) {
      console.error('[wall] base layer swap failed:', (err as Error).message);
    }
  }

  /** Toggle an additive overlay on top of the imagery, below the labels. */
  setOverlay(l: GibsLayer, on: boolean, date?: string): void {
    const sid = `ov-${l.id}`;
    try {
      if (!on) {
        if (this.map.getLayer(sid)) this.map.removeLayer(sid);
        if (this.map.getSource(sid)) this.map.removeSource(sid);
        this.activeOverlays.delete(l.id);
        return;
      }
      if (this.map.getSource(sid)) return;

      this.map.addSource(sid, {
        type: 'raster',
        tiles: tileUrls(l, date),
        tileSize: 256,
        maxzoom: l.matrix,
        attribution: GIBS_ATTRIBUTION,
      });
      this.map.addLayer(
        {
          id: sid,
          type: 'raster',
          source: sid,
          paint: { 'raster-opacity': l.opacity ?? 0.7 },
        },
        'label-country',
      );
      this.activeOverlays.add(l.id);
    } catch (err) {
      console.error(`[wall] overlay ${l.id} failed:`, (err as Error).message);
    }
  }

  setOverlayOpacity(id: string, v: number): void {
    const sid = `ov-${id}`;
    if (this.map.getLayer(sid)) {
      this.map.setPaintProperty(sid, 'raster-opacity', v);
    }
  }

  /**
   * Which layers are failing to serve tiles.
   *
   * GIBS addresses each layer under a `GoogleMapsCompatible_Level{N}` set
   * where N is that layer's own maximum zoom. Get N wrong and every
   * request 404s, which MapLibre renders as nothing at all. Without this,
   * a misconfigured layer is indistinguishable from a layer that is
   * working and simply has no data, which is the worst possible ambiguity
   * in a tool whose whole point is telling those two things apart.
   */
  get failingLayers(): Set<string> {
    return this.tileErrors;
  }

  private pushWatchboxes(): void {
    if (!this.styleReady) return;
    const src = this.map.getSource('watchboxes');
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData(
        watchboxGeoJSON(this.watchboxes) as never,
      );
    }
  }

  /* ------------------------------------------------------------ data */

  setContacts(map: Map<number, Contact>): void {
    const now = Date.now();
    const list: Contact[] = [];
    for (const c of map.values()) {
      // Drop contacts we have not heard about in 20 minutes rather than
      // leaving a ghost fleet on the board.
      if (now - c.updatedAt > 1_200_000) continue;
      list.push(c);
    }
    this.contacts = list;

    const n = list.length;
    if (this.positions.length < n * 2) {
      const cap = Math.max(1024, Math.ceil(n * 1.5));
      this.positions = new Float32Array(cap * 2);
      this.colors = new Uint8Array(cap * 4);
      this.radii = new Float32Array(cap);
    }

    const vectors: { path: [number, number][]; color: RGBA }[] = [];

    for (let i = 0; i < n; i++) {
      const c = list[i]!;
      this.positions[i * 2] = c.lon;
      this.positions[i * 2 + 1] = c.lat;

      let col = DOMAIN_COLOR[c.domain] ?? [154, 176, 194, 190];
      if (c.flags & ObsFlag.EMERGENCY) col = ALERT;
      else if (c.flags & ObsFlag.GNSS_DEGRADED) col = DEGRADED;
      else if (c.ageS > 600) col = DARK;

      this.colors[i * 4] = col[0]!;
      this.colors[i * 4 + 1] = col[1]!;
      this.colors[i * 4 + 2] = col[2]!;
      this.colors[i * 4 + 3] = col[3]!;

      const big =
        (c.flags & (ObsFlag.EMERGENCY | ObsFlag.MILITARY)) !== 0 ? 1.9 : 1;
      this.radii[i] = (c.domain === 2 ? 2.4 : 2.0) * big;

      // A short velocity vector reads as motion in a still frame and
      // makes heading legible without drawing an icon per contact.
      if (c.sogKt && c.sogKt > 2 && c.cogDeg != null && n < 3500) {
        const mins = 6;
        const nm = (c.sogKt * mins) / 60;
        const rad = (c.cogDeg * Math.PI) / 180;
        const dLat = (nm / 60) * Math.cos(rad);
        const dLon =
          (nm / 60) * Math.sin(rad) / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
        vectors.push({
          path: [
            [c.lon, c.lat],
            [c.lon + dLon, c.lat + dLat],
          ],
          color: [col[0]!, col[1]!, col[2]!, 110],
        });
      }
    }
    this.vectors = vectors;
    this.render();
  }

  setDetections(d: DetectionPin[]): void {
    this.detections = d;
    this.render();
  }
  setWatchboxes(w: WatchBox[]): void {
    this.watchboxes = w;
    this.pushWatchboxes();
    this.render();
  }
  setCone(poly: [number, number][] | null): void {
    this.cone = poly;
    this.render();
  }
  setTrack(t: [number, number][]): void {
    this.track = t;
    this.render();
  }
  setSatellites(s: { lon: number; lat: number; name: string }[]): void {
    this.satellites = s;
    this.render();
  }

  setOrbitVisible(v: boolean): void {
    this.orbitVisible = v;
    this.render();
  }

  setCameras(list: Camera[], visible: boolean): void {
    this.cameras = list;
    this.camerasVisible = visible;
    this.render();
  }

  flyTo(lon: number, lat: number, zoom?: number): void {
    this.map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(this.map.getZoom(), 6.5), duration: 900 });
  }

  /** Frame a watchbox. The only places this system actually watches. */
  fitBox(w: WatchBox): void {
    this.map.fitBounds(
      [
        [w.min_lon, w.min_lat],
        [w.max_lon, w.max_lat],
      ],
      { padding: 70, duration: 900, maxZoom: 9 },
    );
  }

  get watchboxList(): WatchBox[] {
    return this.watchboxes;
  }

  /* ---------------------------------------------------------- render */

  private render(): void {
    try {
      this.renderLayers();
    } catch (err) {
      // A deck.gl failure used to propagate into openCase() and surface as
      // "could not load / Unsupported projection" in the Case File, which
      // pointed the reader at the evidence loader rather than at the
      // renderer. Contain it and name it where it happened.
      console.error('[wall] layer render failed:', (err as Error).message);
    }
  }

  private renderLayers(): void {
    const n = this.contacts.length;
    const phase = Math.sin((this.pulse / 32) * Math.PI * 2) * 0.5 + 0.5;

    this.overlay.setProps({
      layers: [
        // Watchbox rectangles and their labels are MapLibre layers now,
        // not deck.gl ones. deck.gl's TextLayer has open, unfixed bugs on
        // a globe -- it can render at the origin or upside down, and the
        // fix was pulled from the 9.3 milestone and left in draft. MapLibre
        // symbol layers have none of that, and give free label collision
        // against the basemap's own place names as a bonus.
        // See basemap.ts and pushWatchboxes().

        // The reachable set. The verdict, drawn.
        this.cone &&
          new PolygonLayer({
            id: 'cone',
            data: [{ polygon: this.cone }],
            getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
            filled: true,
            stroked: true,
            getFillColor: [255, 45, 85, 34],
            getLineColor: [255, 45, 85, 200],
            getLineWidth: 1.5,
            lineWidthUnits: 'pixels',
            pickable: false,
          }),

        this.track.length > 1 &&
          new PathLayer({
            id: 'track',
            data: [{ path: this.track }],
            getPath: (d: { path: [number, number][] }) => d.path,
            getColor: [255, 162, 0, 190],
            getWidth: 1.6,
            widthUnits: 'pixels',
            pickable: false,
          }),

        this.vectors.length > 0 &&
          new PathLayer<{ path: [number, number][]; color: RGBA }>({
            id: 'vectors',
            data: this.vectors,
            getPath: (d) => d.path,
            getColor: (d) => d.color,
            getWidth: 1,
            widthUnits: 'pixels',
            pickable: false,
          }),

        // Contacts, from binary attributes.
        n > 0 &&
          new ScatterplotLayer({
            id: 'contacts',
            data: {
              length: n,
              attributes: {
                getPosition: { value: this.positions, size: 2 },
                getFillColor: { value: this.colors, size: 4, normalized: true },
                getRadius: { value: this.radii, size: 1 },
              },
            },
            radiusUnits: 'pixels',
            radiusMinPixels: 1.4,
            radiusMaxPixels: 9,
            pickable: true,
            onHover: (info) => {
              const c = info.index >= 0 ? this.contacts[info.index] : null;
              this.onPick(c ?? null);
            },
            updateTriggers: { all: n },
          }),

        this.orbitVisible &&
          this.satellites.length > 0 &&
          new ScatterplotLayer<{ lon: number; lat: number; name: string }>({
            id: 'satellites',
            data: this.satellites,
            getPosition: (d) => [d.lon, d.lat],
            getFillColor: [167, 139, 250, 120],
            getRadius: 1.6,
            radiusUnits: 'pixels',
            radiusMinPixels: 1.2,
            pickable: false,
          }),

        // Detections. Two rings: a solid core and a severity-scaled pulse.
        this.detections.length > 0 &&
          new ScatterplotLayer<DetectionPin>({
            id: 'det-halo',
            data: this.detections,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: (d) => 9 + (d.severity / 100) * 22 * (0.55 + phase * 0.45),
            radiusUnits: 'pixels',
            stroked: true,
            filled: false,
            getLineColor: (d) => sevColor(d.severity, 120 + phase * 90),
            getLineWidth: 1.2,
            lineWidthUnits: 'pixels',
            pickable: false,
            updateTriggers: { getRadius: phase, getLineColor: phase },
          }),

        this.detections.length > 0 &&
          new ScatterplotLayer<DetectionPin>({
            id: 'det',
            data: this.detections,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 4.2,
            radiusUnits: 'pixels',
            getFillColor: (d) => sevColor(d.severity, 255),
            pickable: true,
            onClick: (info) => {
              if (info.object) this.onDetectionPick(info.object as DetectionPin);
              return true;
            },
          }),

        this.camerasVisible &&
          this.cameras.length > 0 &&
          new ScatterplotLayer<Camera>({
            id: 'cameras',
            data: this.cameras,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 3,
            radiusUnits: 'pixels',
            radiusMinPixels: 2.5,
            radiusMaxPixels: 6,
            stroked: true,
            filled: true,
            getFillColor: [140, 220, 255, 210],
            getLineColor: [8, 13, 20, 200],
            getLineWidth: 1,
            lineWidthUnits: 'pixels',
            pickable: true,
            onClick: (info) => {
              if (info.object) this.onCameraPick?.(info.object as Camera);
              return true;
            },
          }),

        // Detection rule names were a deck.gl TextLayer here. Removed for
        // the same reason as the watchbox labels: TextLayer on a globe is
        // an open bug in deck.gl 9.3. The ticker carries the rule name,
        // the pulsing ring carries the severity, and hovering carries the
        // rest, so nothing was actually lost.
      ].filter(Boolean) as never[],
    });
  }
}

function sevColor(sev: number, alpha: number): RGBA {
  if (sev >= 80) return [255, 45, 85, alpha];
  if (sev >= 60) return [255, 122, 69, alpha];
  if (sev >= 40) return [255, 194, 0, alpha];
  return [0, 217, 255, alpha];
}

export { sevColor };
