/**
 * DEADRECKON :: the panel.
 *
 * One left rail, five tabs, one panel. Everything that used to be
 * scattered across the screen now lives in exactly one place.
 *
 * What this replaced, and why:
 *
 *   watchbox chip strip   ten chips wrapping across the top of the map,
 *                         covering the thing they were meant to help you
 *                         navigate
 *   legend box            bottom left, five colours and a word each
 *   detection ticker      a permanent 372px column, usually empty
 *   three header buttons  ARCHITECTURE / SOURCES / HELP, competing with
 *                         the status readout for the same strip
 *
 * That was four separate places to look and no obvious order to look in.
 * The rule now: the globe owns the screen, the panel owns the controls,
 * and the panel collapses to a 46px rail when you want the globe back.
 *
 * Tabs are ordered by how often you need them, not by how proud I am of
 * them: LAYERS, WATCH, FEED, TIME, INFO.
 */

import {
  BASE_LAYERS,
  OVERLAY_LAYERS,
  OVERLAY_GROUPS,
  type GibsLayer,
} from './gibs.js';
import type { WatchBox } from './basemap.js';

export type TabId = 'layers' | 'watch' | 'feed' | 'time' | 'info';

export interface PanelHooks {
  onBaseLayer: (l: GibsLayer) => void;
  onOverlay: (l: GibsLayer, on: boolean) => void;
  onOverlayOpacity: (id: string, v: number) => void;
  onDomain: (domain: string, on: boolean) => void;
  onWatchbox: (w: WatchBox) => void;
  onTab: (t: TabId) => void;
}

const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'layers', icon: '▤', label: 'LAYERS' },
  { id: 'watch', icon: '◎', label: 'WATCH' },
  { id: 'feed', icon: '⚑', label: 'FEED' },
  { id: 'time', icon: '◷', label: 'TIME' },
  { id: 'info', icon: 'ⓘ', label: 'INFO' },
];

export const DOMAIN_ROWS = [
  { key: 'air', color: '#FFA200', label: 'aircraft' },
  { key: 'sea', color: '#00D9FF', label: 'vessels' },
  { key: 'orbit', color: '#A78BFA', label: 'satellites' },
  { key: 'geo', color: '#FF7A45', label: 'seismic' },
  { key: 'thermal', color: '#FF4D4D', label: 'thermal' },
];

export class Panel {
  private tab: TabId = 'layers';
  private collapsed = false;
  private base = 'bluemarble';
  private overlays = new Set<string>();
  private domains = new Set(['air', 'sea', 'orbit', 'geo', 'thermal']);
  private failing = new Set<string>();
  private watchboxes: WatchBox[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: PanelHooks,
  ) {
    this.render();
  }

  get activeTab(): TabId {
    return this.tab;
  }
  get activeDomains(): Set<string> {
    return this.domains;
  }

  setWatchboxes(w: WatchBox[]): void {
    this.watchboxes = w;
    if (this.tab === 'watch') this.render();
  }

  markFailing(id: string): void {
    this.failing.add(id);
    if (this.tab === 'layers') this.render();
  }

  open(t: TabId): void {
    this.tab = t;
    this.collapsed = false;
    this.render();
    this.hooks.onTab(t);
  }

  /** The FEED tab hands its body over to main.ts, which owns detections. */
  get feedBody(): HTMLElement | null {
    return this.root.querySelector('#pn-feed');
  }
  /** Same for TIME, which main.ts fills with archive status. */
  get timeBody(): HTMLElement | null {
    return this.root.querySelector('#pn-time');
  }

  /* ------------------------------------------------------------ render */

  private render(): void {
    this.root.innerHTML =
      `<nav id="rail">${TABS.map(
        (t) =>
          `<button class="rail-b ${!this.collapsed && this.tab === t.id ? 'on' : ''}"
                   data-tab="${t.id}" title="${t.label}">
             <span class="ri">${t.icon}</span><span class="rl">${t.label}</span>
           </button>`,
      ).join('')}</nav>` +
      (this.collapsed ? '' : `<div id="pn-body">${this.body()}</div>`);

    this.root.classList.toggle('collapsed', this.collapsed);

    this.root.querySelectorAll('[data-tab]').forEach((n) =>
      n.addEventListener('click', () => {
        const id = (n as HTMLElement).dataset.tab as TabId;
        // Clicking the active tab collapses, so the globe can have the screen.
        if (id === this.tab && !this.collapsed) this.collapsed = true;
        else {
          this.tab = id;
          this.collapsed = false;
        }
        this.render();
        this.hooks.onTab(this.tab);
      }),
    );

    this.wire();
  }

  private body(): string {
    switch (this.tab) {
      case 'layers':
        return this.layersTab();
      case 'watch':
        return this.watchTab();
      case 'feed':
        return `<div class="pn-h">DETECTION FEED</div><div id="pn-feed"></div>`;
      case 'time':
        return `<div class="pn-h">TIME</div><div id="pn-time"></div>`;
      case 'info':
        return this.infoTab();
    }
  }

  private layersTab(): string {
    const fail = (id: string): string =>
      this.failing.has(id)
        ? ` <span class="warn" title="This layer is not serving tiles">no data</span>`
        : '';

    const base = BASE_LAYERS.map(
      (l) => `
      <label class="opt ${this.base === l.id ? 'on' : ''} ${this.failing.has(l.id) ? 'bad' : ''}">
        <input type="radio" name="base" value="${l.id}" ${this.base === l.id ? 'checked' : ''}>
        <span class="ot">${l.title}${fail(l.id)}</span>
        <span class="ow">${l.why}</span>
      </label>`,
    ).join('');

    const overlays = OVERLAY_GROUPS.map(
      (g) => `
      <div class="pn-sub">${g}</div>
      ${OVERLAY_LAYERS.filter((l) => l.group === g)
        .map(
          (l) => `
        <label class="opt ${this.overlays.has(l.id) ? 'on' : ''} ${this.failing.has(l.id) ? 'bad' : ''}">
          <input type="checkbox" name="ov" value="${l.id}" ${this.overlays.has(l.id) ? 'checked' : ''}>
          <span class="ot">${l.title}${fail(l.id)}</span>
          <span class="ow">${l.why}</span>
          ${
            this.overlays.has(l.id)
              ? `<input class="op" type="range" min="0" max="100"
                        value="${Math.round((l.opacity ?? 0.7) * 100)}" data-op="${l.id}">`
              : ''
          }
        </label>`,
        )
        .join('')}`,
    ).join('');

    const domains = DOMAIN_ROWS.map(
      (d) => `
      <label class="dom ${this.domains.has(d.key) ? 'on' : ''}">
        <input type="checkbox" name="dom" value="${d.key}" ${this.domains.has(d.key) ? 'checked' : ''}>
        <i style="background:${d.color}"></i><span>${d.label}</span>
      </label>`,
    ).join('');

    return `
      <div class="pn-h">LAYERS</div>

      <div class="pn-sec">
        <div class="pn-k">LIVE CONTACTS</div>
        <div class="dom-grid">${domains}</div>
      </div>

      <div class="pn-sec">
        <div class="pn-k">BASE IMAGERY</div>
        ${base}
      </div>

      <div class="pn-sec">
        <div class="pn-k">SCIENCE OVERLAYS</div>
        ${overlays}
      </div>

      <p class="pn-note">
        All imagery from NASA GIBS. US federal work, effectively public
        domain, no API key. Daily products lag one to two days; a layer
        marked <span class="warn">no data</span> is not answering, most
        likely a wrong tile matrix level rather than an outage.
      </p>`;
  }

  private watchTab(): string {
    if (!this.watchboxes.length) {
      return `<div class="pn-h">WATCH</div><p class="pn-note">No watchboxes loaded.</p>`;
    }
    return `
      <div class="pn-h">WATCH &middot; ${this.watchboxes.length}</div>
      <p class="pn-note" style="margin-top:0">
        The only places actively polled. Everywhere else on the globe is
        drawn but not watched. Click to fly.
      </p>
      ${this.watchboxes
        .map(
          (w, i) => `
        <button class="wbx" data-wb="${i}">
          <span class="wt">${w.label}</span>
          <span class="wc">${w.min_lat.toFixed(0)}–${w.max_lat.toFixed(0)}&deg;,
                ${w.min_lon.toFixed(0)}–${w.max_lon.toFixed(0)}&deg;</span>
        </button>`,
        )
        .join('')}`;
  }

  private infoTab(): string {
    return `
      <div class="pn-h">INFO</div>
      <p class="pn-note" style="margin-top:0">
        A tripwire for public data, not a live map. The engine runs over
        the same open feeds everyone has and tells you when something
        <b>changed</b>, with the evidence chain behind every claim.
      </p>
      <div class="pn-sec">
        <div class="pn-k">OPEN</div>
        <button class="pn-btn" data-sheet="help">What this is, and everything you can do</button>
        <button class="pn-btn" data-sheet="arch">Architecture &middot; why it scales</button>
        <button class="pn-btn" data-sheet="sources">Sources &middot; every feed and its licence</button>
      </div>
      <div class="pn-sec">
        <div class="pn-k">KEYS</div>
        <div class="kv-min">
          <span>1&ndash;5</span><span>switch tab</span>
          <span>\\</span><span>collapse the panel</span>
          <span>Space</span><span>play / pause replay</span>
          <span>G</span><span>globe / flat</span>
          <span>Esc</span><span>close any panel</span>
        </div>
      </div>`;
  }

  /* -------------------------------------------------------------- wire */

  private wire(): void {
    this.root.querySelectorAll('input[name="base"]').forEach((n) =>
      n.addEventListener('change', () => {
        const id = (n as HTMLInputElement).value;
        const l = BASE_LAYERS.find((x) => x.id === id);
        if (!l) return;
        this.base = id;
        this.hooks.onBaseLayer(l);
        this.render();
      }),
    );

    this.root.querySelectorAll('input[name="ov"]').forEach((n) =>
      n.addEventListener('change', () => {
        const el = n as HTMLInputElement;
        const l = OVERLAY_LAYERS.find((x) => x.id === el.value);
        if (!l) return;
        if (el.checked) this.overlays.add(l.id);
        else this.overlays.delete(l.id);
        this.hooks.onOverlay(l, el.checked);
        this.render();
      }),
    );

    this.root.querySelectorAll('[data-op]').forEach((n) =>
      n.addEventListener('input', (e) => {
        e.stopPropagation();
        const el = n as HTMLInputElement;
        this.hooks.onOverlayOpacity(el.dataset.op!, Number(el.value) / 100);
      }),
    );

    this.root.querySelectorAll('input[name="dom"]').forEach((n) =>
      n.addEventListener('change', () => {
        const el = n as HTMLInputElement;
        // Never let the board go fully blank and read as broken.
        if (!el.checked && this.domains.size <= 1) {
          el.checked = true;
          return;
        }
        if (el.checked) this.domains.add(el.value);
        else this.domains.delete(el.value);
        this.hooks.onDomain(el.value, el.checked);
        this.render();
      }),
    );

    this.root.querySelectorAll('[data-wb]').forEach((n) =>
      n.addEventListener('click', () => {
        const w = this.watchboxes[Number((n as HTMLElement).dataset.wb)];
        if (w) this.hooks.onWatchbox(w);
      }),
    );
  }
}
