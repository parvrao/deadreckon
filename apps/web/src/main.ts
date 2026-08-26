/**
 * DEADRECKON :: console bootstrap.
 *
 * Three surfaces, and no more:
 *
 *   THE WALL      what is out there now, or at any past moment
 *   THE TICKER    what the engine noticed without being asked
 *   THE CASE FILE why it thinks so, and how to prove it wrong
 *
 * There is no settings page, no dashboard builder, and no second nav.
 * Every feature that is not one of those three is a feature that dilutes
 * the one thing this is for.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Net, getJson, apiUrl, type Contact, type EventMsg } from './net.js';
import { Wall, sevColor, type DetectionPin, type WatchBox } from './wall.js';
import { renderCaseFile, renderIncident } from './casefile.js';
import { Scrubber } from './scrubber.js';
import { startOrbits } from './orbits.js';
import { architectureSheet, sourcesSheet } from './sheets.js';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T =>
  document.querySelector(s) as T;

/* ---------------------------------------------------------------- boot */

const bootLog = $('#boot-log');
const line = (html: string): void => {
  const d = document.createElement('div');
  d.innerHTML = html;
  bootLog.append(d);
  bootLog.scrollTop = bootLog.scrollHeight;
};

const state = {
  detections: [] as DetectionPin[],
  filters: new Set<string>(),
  selected: null as number | null,
  liveContacts: 0,
  connected: false,
  bytesIn: 0,
  hoverContact: null as Contact | null,
  archiveFrom: 0,
  replayAt: null as number | null,
};

let wall: Wall;
let net: Net;
let scrubber: Scrubber;

async function boot(): Promise<void> {
  line('link <b>opening</b> ...');

  try {
    const health = await getJson<Record<string, unknown>>('/api/health');
    line(`api <b>${health.status}</b> &middot; db ${health.db} (${health.dbLatencyMs}ms)`);
  } catch (err) {
    line(`api <i>unreachable</i> &mdash; ${(err as Error).message}`);
    line(`expecting <b>${apiUrl('/api')}</b>`);
    line('set VITE_API_URL and VITE_WS_URL, then redeploy the static site.');
    return;
  }

  const stats = await getJson<{ archive: Record<string, unknown> | null }>(
    '/api/stats',
  ).catch(() => ({ archive: null }));
  if (stats.archive) {
    const a = stats.archive;
    state.archiveFrom = Number(a.archive_from) || Date.now() - 3600_000;
    line(
      `archive <b>${Number(a.observations).toLocaleString()}</b> observations &middot; ` +
        `${Number(a.detections).toLocaleString()} detections &middot; ` +
        `${(Number(a.db_bytes) / 1e6).toFixed(1)} MB`,
    );
  } else {
    state.archiveFrom = Date.now() - 3600_000;
    line('archive <i>empty</i> &mdash; the worker has not written yet');
  }

  const wb = await getJson<{ watchboxes: WatchBox[] }>('/api/watchboxes').catch(() => ({
    watchboxes: [] as WatchBox[],
  }));
  line(`watchboxes <b>${wb.watchboxes.length}</b> armed`);
  line('nobody has to press record.');

  await sleep(420);
  $('#boot').remove();
  $('#app').hidden = false;

  mount(wb.watchboxes);
}

/* --------------------------------------------------------------- mount */

function mount(watchboxes: WatchBox[]): void {
  wall = new Wall(
    'map',
    (c) => {
      state.hoverContact = c;
      paintViewInfo();
    },
    (d) => void openCase(d.id),
    (bounds, zoom) => {
      net.subscribe(
        {
          minLat: bounds.getSouth(),
          minLon: bounds.getWest(),
          maxLat: bounds.getNorth(),
          maxLon: bounds.getEast(),
        },
        ['air', 'sea', 'geo', 'thermal'],
      );
      paintViewInfo(zoom);
    },
  );
  wall.setWatchboxes(watchboxes);

  net = new Net({
    onContacts: (contacts) => {
      state.liveContacts = contacts.size;
      wall.setContacts(contacts);
      paintReadout();
    },
    onEvent: (e) => onEvent(e),
    onStatus: (s) => {
      state.connected = s.connected;
      state.bytesIn = s.bytesIn;
      paintReadout(s.note);
    },
  });
  net.connect();

  // Subscribe to whatever is on screen at first paint.
  const b = wall.map.getBounds();
  net.subscribe(
    {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast(),
    },
    ['air', 'sea', 'geo', 'thermal'],
  );

  scrubber = new Scrubber({
    canvas: $('#sc-canvas') as HTMLCanvasElement,
    track: $('#sc-track'),
    cursor: $('#sc-cursor'),
    clock: $('#sc-clock'),
    onSeek: (at) => {
      state.replayAt = at;
      net.seek(at);
      $('#sc-live').classList.toggle('off', at !== null);
      wall.setCone(null);
    },
  });
  scrubber.setWindow(state.archiveFrom, Date.now());

  $('#sc-live').addEventListener('click', () => scrubber.goLive());
  $('#sc-play').addEventListener('click', () => scrubber.togglePlay());
  $('#sc-rate').addEventListener('click', () => scrubber.cycleRate());
  document.querySelectorAll('[data-seek]').forEach((el) =>
    el.addEventListener('click', () =>
      scrubber.seekRelative(Number((el as HTMLElement).dataset.seek)),
    ),
  );
  document.querySelectorAll('[data-panel]').forEach((el) =>
    el.addEventListener('click', () => {
      const which = (el as HTMLElement).dataset.panel;
      openSheet(which === 'arch' ? architectureSheet() : sourcesSheet());
    }),
  );

  buildFilters();
  paintLegend();
  paintReadout();
  paintViewInfo();
  void refreshDetections();
  setInterval(() => void refreshDetections(), 20_000);
  setInterval(() => {
    if (state.replayAt === null) scrubber.setWindow(state.archiveFrom, Date.now());
  }, 10_000);

  startOrbits((sats) => wall.setSatellites(sats));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCase();
      closeSheet();
    }
    if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      scrubber.togglePlay();
    }
  });
}

/* ---------------------------------------------------------- detections */

async function refreshDetections(): Promise<void> {
  try {
    const r = await getJson<{ detections: RawDet[] }>(
      '/api/detections?since=' + (Date.now() - 24 * 3600_000) + '&limit=200',
    );
    state.detections = r.detections.map(toPin);
    paintTicker();
    wall.setDetections(visibleDetections());
    paintReadout();
  } catch {
    /* the ticker keeps whatever it had; the readout will show the link state */
  }
}

interface RawDet {
  id: number;
  rule: string;
  severity: number;
  ts_start: number;
  lat: number;
  lon: number;
  title: string;
  summary: string;
  incident_id: number | null;
}

const summaries = new Map<number, string>();
const incidentOf = new Map<number, number | null>();

function toPin(d: RawDet): DetectionPin {
  summaries.set(d.id, d.summary);
  incidentOf.set(d.id, d.incident_id);
  return {
    id: d.id,
    rule: d.rule,
    severity: d.severity,
    lat: d.lat,
    lon: d.lon,
    title: d.title,
    ts: d.ts_start,
  };
}

function onEvent(e: EventMsg): void {
  if (state.detections.some((d) => d.id === e.id)) return;
  const pin: DetectionPin = {
    id: e.id,
    rule: e.rule ?? 'CONFLUENCE',
    severity: e.severity,
    lat: e.lat,
    lon: e.lon,
    title: e.title,
    ts: e.ts,
  };
  state.detections.unshift(pin);
  state.detections = state.detections.slice(0, 300);
  paintTicker();
  wall.setDetections(visibleDetections());

  if (e.severity >= 80) flashBar();
}

function visibleDetections(): DetectionPin[] {
  if (!state.filters.size) return state.detections;
  return state.detections.filter((d) => state.filters.has(d.rule));
}

/* -------------------------------------------------------------- ticker */

const RULES = [
  'SPOOF_DISCONTINUITY',
  'DARK_VESSEL',
  'AIRSPACE_VOID',
  'GNSS_BLOOM',
  'RENDEZVOUS',
  'LOITER',
  'SQUAWK_EMERGENCY',
  'THERMAL_ANOMALY',
  'SEISMIC_SHALLOW',
];

function buildFilters(): void {
  const el = $('#tk-filters');
  el.innerHTML = '';
  for (const r of RULES) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = r.replace(/_/g, ' ');
    b.addEventListener('click', () => {
      if (state.filters.has(r)) state.filters.delete(r);
      else state.filters.add(r);
      b.classList.toggle('on');
      paintTicker();
      wall.setDetections(visibleDetections());
    });
    el.append(b);
  }
}

function paintTicker(): void {
  const list = visibleDetections();
  const el = $('#tk-list');
  $('#tk-count').textContent = String(list.length);

  if (!list.length) {
    el.innerHTML =
      '<div style="padding:26px 16px;color:var(--txt-dim);line-height:1.7;font-size:11px">' +
      'No detections in the last 24 hours.<br><br>' +
      'That is a valid result, not a failure. The engine only speaks when ' +
      'observations diverge from an explicit model.<br><br>' +
      'A fresh deployment also needs about a week of samples before the ' +
      'AIRSPACE_VOID baseline can fire at all.' +
      '</div>';
    return;
  }

  el.innerHTML = list
    .map((d) => {
      const c = sevColor(d.severity, 255);
      const isConf = incidentOf.get(d.id) != null;
      return `
      <div class="ev ${state.selected === d.id ? 'sel' : ''} ${isConf ? 'confluence' : ''}"
           data-id="${d.id}">
        <div class="ev-top">
          <span class="sev" style="background:rgb(${c[0]},${c[1]},${c[2]})">${d.severity}</span>
          <span class="ev-rule">${d.rule.replace(/_/g, ' ')}${isConf ? ' &middot; IN INCIDENT' : ''}</span>
          <span class="ev-t">${ago(d.ts)}</span>
        </div>
        <div class="ev-title">${esc(d.title)}</div>
        <div class="ev-sub">${esc(summaries.get(d.id) ?? '')}</div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('.ev').forEach((n) =>
    n.addEventListener('click', () => {
      const id = Number((n as HTMLElement).dataset.id);
      void openCase(id);
    }),
  );

  const worst = list.reduce((a, b) => (b.severity > a.severity ? b : a));
  $('#tk-foot').textContent =
    `peak ${worst.severity} · ${list.filter((d) => d.severity >= 70).length} above 70`;
}

/* ------------------------------------------------------------ casefile */

async function openCase(id: number): Promise<void> {
  state.selected = id;
  paintTicker();

  const pin = state.detections.find((d) => d.id === id);
  if (pin) wall.flyTo(pin.lon, pin.lat);

  const el = $('#casefile');
  el.hidden = false;
  el.innerHTML =
    '<div class="cf-head"><div><div class="k">CASE FILE</div>' +
    '<h2>loading evidence...</h2></div></div>';

  try {
    const data = await getJson<Record<string, unknown>>(`/api/detections/${id}`);
    el.innerHTML = renderCaseFile(data);
    wireCaseFile(el, data);
  } catch (err) {
    el.innerHTML =
      `<div class="cf-head"><div><div class="k">CASE FILE</div>` +
      `<h2>could not load</h2></div><button class="x" id="cf-x">&times;</button></div>` +
      `<div class="cf-body"><pre class="blk">${esc((err as Error).message)}</pre></div>`;
    el.querySelector('#cf-x')?.addEventListener('click', closeCase);
  }
}

function wireCaseFile(el: HTMLElement, data: Record<string, unknown>): void {
  el.querySelector('#cf-x')?.addEventListener('click', closeCase);

  const cone = data.reachableSetPolygon as [number, number][] | null;
  wall.setCone(cone && cone.length ? cone : null);

  const tracks = (data.tracks ?? {}) as Record<
    string,
    { lat: number; lon: number }[]
  >;
  const first = Object.values(tracks)[0];
  wall.setTrack(first?.length ? first.map((p) => [p.lon, p.lat]) : []);

  el.querySelector('#cf-incident')?.addEventListener('click', () => {
    const d = data.detection as { incident_id: number };
    void openIncident(d.incident_id);
  });
}

async function openIncident(id: number): Promise<void> {
  const data = await getJson<Record<string, unknown>>(`/api/incidents/${id}`);
  openSheet(renderIncident(data));
}

function closeCase(): void {
  $('#casefile').hidden = true;
  state.selected = null;
  wall?.setCone(null);
  wall?.setTrack([]);
  paintTicker();
}

function openSheet(html: string): void {
  const el = $('#sheet');
  el.hidden = false;
  el.innerHTML = html;
  el.querySelector('#sh-x')?.addEventListener('click', closeSheet);
}
function closeSheet(): void {
  $('#sheet').hidden = true;
}

/* ------------------------------------------------------------- chrome */

function paintReadout(note = ''): void {
  const rd = (k: string, v: string, cls = ''): string =>
    `<div class="rd"><div class="rd-k">${k}</div><div class="rd-v ${cls}">${v}</div></div>`;

  const high = state.detections.filter((d) => d.severity >= 70).length;
  $('#readout').innerHTML =
    rd('link', state.connected ? 'LIVE' : note || 'DOWN', state.connected ? 'good' : 'bad') +
    rd('contacts', state.liveContacts.toLocaleString()) +
    rd('detections 24h', String(state.detections.length), high ? 'warn' : '') +
    rd('sev 70+', String(high), high ? 'bad' : 'good') +
    rd('rx', fmtBytes(state.bytesIn)) +
    rd('mode', state.replayAt ? 'REPLAY' : 'LIVE', state.replayAt ? 'warn' : 'good');
}

function paintLegend(): void {
  const rows: [string, string][] = [
    ['#FFA200', 'air'],
    ['#00D9FF', 'sea'],
    ['#A78BFA', 'orbit'],
    ['#FF7A45', 'seismic'],
    ['#FF4D4D', 'thermal'],
    ['#FFD666', 'GNSS degraded'],
    ['#788C9E', 'stale / dark'],
  ];
  $('#legend').innerHTML = rows
    .map(([c, l]) => `<div class="lg"><i style="background:${c}"></i><span>${l}</span></div>`)
    .join('');
}

function paintViewInfo(zoom?: number): void {
  const z = zoom ?? wall?.map.getZoom() ?? 0;
  const c = state.hoverContact;
  $('#viewinfo').innerHTML = c
    ? `<b>${esc(c.label)}</b><br>` +
      `${c.lat.toFixed(4)} ${c.lon.toFixed(4)}<br>` +
      `${c.sogKt != null ? `${c.sogKt.toFixed(1)} kt` : '--'} / ` +
      `${c.cogDeg != null ? `${c.cogDeg.toFixed(0)}°` : '--'}<br>` +
      `${c.altM > 1 ? `${Math.round(c.altM * 3.28084).toLocaleString()} ft<br>` : ''}` +
      `age ${c.ageS.toFixed(0)}s`
    : `z${z.toFixed(1)}<br><b>${state.liveContacts.toLocaleString()}</b> contacts in view`;
}

function flashBar(): void {
  const bar = $('#bar');
  bar.animate(
    [
      { background: '#080D14' },
      { background: 'rgba(255,45,85,0.22)' },
      { background: '#080D14' },
    ],
    { duration: 900, iterations: 2 },
  );
}

/* -------------------------------------------------------------- utils */

function esc(s: string): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)}K`;
  return `${(b / 1048576).toFixed(1)}M`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { esc, ago };

void boot();
