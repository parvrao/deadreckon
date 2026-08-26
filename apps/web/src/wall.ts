/**
 * DEADRECKON :: THE WALL.
 *
 * A 2D deck.gl console on a flat dark basemap. Not a photorealistic globe,
 * and that is a decision rather than a limitation:
 *
 *   - photoreal 3D tiles are the single largest cost line in a project
 *     like this, and they are billed per session
 *   - a globe hides half the planet at all times, which is exactly wrong
 *     for a system whose job is to notice things you were not looking at
 *   - this runs at 60 fps on a phone and on a locked-down work laptop
 *
 * Rendering is driven from typed arrays rebuilt each frame, so a contact
 * costs eight floats rather than a JavaScript object graph.
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import { ObsFlag } from '@deadreckon/core';
import type { Contact } from './net.js';

export interface WatchBox {
  key: string;
  label: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}

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
  readonly map: maplibregl.Map;
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

  constructor(
    container: string,
    private readonly onPick: (c: Contact | null) => void,
    private readonly onDetectionPick: (d: DetectionPin) => void,
    private readonly onMove: (b: maplibregl.LngLatBounds, zoom: number) => void,
  ) {
    this.map = new maplibregl.Map({
      container,
      // CARTO dark-matter, WITH labels.
      //
      // The first version used the no-labels variant, on the theory that
      // the data should be the brightest thing on screen. That theory was
      // wrong. An unlabelled dark map is not restrained, it is illegible:
      // you cannot tell Iran from Oman, you cannot find the Strait of
      // Malacca, and you have no anchor for anything the console tells you.
      // Orientation is not decoration.
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [56.3, 26.5], // Strait of Hormuz
      zoom: 5.4,
      minZoom: 1.4,
      maxZoom: 14,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: true,
    });

    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    this.map.addControl(
      new maplibregl.ScaleControl({ unit: 'nautical' as never }),
      'bottom-right',
    );

    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay as never);

    this.map.on('load', () => this.tintBasemap());

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

    // 8 fps is enough for a pulse and costs almost nothing.
    setInterval(() => {
      this.pulse = (this.pulse + 1) % 32;
      if (this.detections.length) this.render();
    }, 125);
  }

  /**
   * Retint the basemap for a dark console without destroying legibility.
   *
   * The previous version flattened every fill to one near-black and every
   * line to one barely-visible grey, which erased coastlines, borders and
   * the land/water distinction all at once. The map has to stay readable
   * or nothing plotted on it means anything.
   *
   * Layers are treated by role rather than by type:
   *   water        darkest, so contacts at sea read hottest
   *   land         a visible plate, clearly not water
   *   borders      brightest basemap element, for orientation
   *   roads        suppressed, they are noise at this scale
   *   place names  dim but readable, with a halo so they survive over data
   */
  private tintBasemap(): void {
    const style = this.map.getStyle();

    const set = (id: string, prop: string, val: unknown): void => {
      try {
        this.map.setPaintProperty(id, prop, val as never);
      } catch {
        /* not every layer accepts every property */
      }
    };

    for (const layer of style.layers ?? []) {
      const id = layer.id;
      const isWater = /water|ocean|sea|river|lake|bathym/i.test(id);
      const isBoundary = /boundary|border|admin/i.test(id);
      const isRoad = /road|transport|bridge|tunnel|rail|aeroway|runway/i.test(id);
      const isBuilding = /building/i.test(id);

      switch (layer.type) {
        case 'background':
          set(id, 'background-color', '#050912');
          break;

        case 'fill':
          if (isWater) {
            set(id, 'fill-color', '#050A12');
            set(id, 'fill-opacity', 1);
          } else if (isBuilding) {
            set(id, 'fill-opacity', 0);
          } else {
            // Land. Visibly lighter than water, which is the single most
            // important contrast on a maritime console.
            set(id, 'fill-color', '#111A24');
            set(id, 'fill-opacity', 0.92);
          }
          break;

        case 'line':
          if (isBoundary) {
            set(id, 'line-color', '#33506B');
            set(id, 'line-opacity', 0.9);
            set(id, 'line-width', 0.8);
          } else if (isRoad) {
            set(id, 'line-opacity', 0);
          } else {
            // Coastlines and waterways.
            set(id, 'line-color', '#24384B');
            set(id, 'line-opacity', 0.75);
          }
          break;

        case 'symbol': {
          // Place names. Dim enough not to compete with contacts, haloed
          // enough to survive being drawn over. Countries and seas read
          // brightest because those are the labels you navigate by.
          const major = /country|continent|marine|ocean|sea|state/i.test(id);
          set(id, 'text-color', major ? '#93AEC6' : '#5D748B');
          set(id, 'text-halo-color', '#050912');
          set(id, 'text-halo-width', 1.4);
          set(id, 'text-halo-blur', 0.4);
          set(id, 'icon-opacity', 0);
          break;
        }

        default:
          break;
      }
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
    const n = this.contacts.length;
    const phase = Math.sin((this.pulse / 32) * Math.PI * 2) * 0.5 + 0.5;

    this.overlay.setProps({
      layers: [
        // Watchboxes. These used to be a barely-visible hairline, which
        // meant a zoomed-out map looked like an empty void rather than a
        // system watching ten specific places on purpose. If the console
        // does not say where it is looking, the reader assumes it is broken.
        new PolygonLayer<WatchBox>({
          id: 'watchboxes',
          data: this.watchboxes,
          getPolygon: (d) => [
            [
              [d.min_lon, d.min_lat],
              [d.max_lon, d.min_lat],
              [d.max_lon, d.max_lat],
              [d.min_lon, d.max_lat],
              [d.min_lon, d.min_lat],
            ],
          ],
          stroked: true,
          filled: true,
          getFillColor: [0, 217, 255, 14],
          getLineColor: [0, 217, 255, 120],
          getLineWidth: 1.4,
          lineWidthUnits: 'pixels',
          pickable: true,
          onClick: (info) => {
            const w = info.object as WatchBox | undefined;
            if (!w) return false;
            this.fitBox(w);
            return true;
          },
        }),

        this.watchboxes.length > 0 &&
          new TextLayer<WatchBox>({
            id: 'watchbox-label',
            data: this.watchboxes,
            getPosition: (d) => [
              (d.min_lon + d.max_lon) / 2,
              (d.min_lat + d.max_lat) / 2,
            ],
            getText: (d) => d.label.toUpperCase(),
            getSize: 9.5,
            getColor: [0, 217, 255, 150],
            fontFamily: "'JetBrains Mono', monospace",
            characterSet: 'auto',
            getPixelOffset: [0, -4],
            pickable: false,
          }),

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

        this.detections.length > 0 &&
          this.detections.length < 40 &&
          new TextLayer<DetectionPin>({
            id: 'det-label',
            data: this.detections,
            getPosition: (d) => [d.lon, d.lat],
            getText: (d) => d.rule.replace(/_/g, ' '),
            getSize: 9,
            getColor: (d) => sevColor(d.severity, 210),
            getPixelOffset: [0, -16],
            fontFamily: "'JetBrains Mono', monospace",
            characterSet: 'auto',
            pickable: false,
          }),
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
