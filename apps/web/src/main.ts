/**
 * DEADRECKON :: console bootstrap.
 *
 * Three surfaces, and no more:
 *
 *   THE WALL      what is out there now, or at any past moment
 *   THE PANEL     one rail, five tabs, every control
 *   THE CASE FILE why the engine thinks so, and how to prove it wrong
 *
 * The controls used to be spread across four places -- a chip strip over
 * the map, a legend box, a permanent detection column, and three header
 * buttons -- with no obvious order to look in. Now the globe owns the
 * screen and the panel owns the controls, and the panel collapses to a
 * 46px rail when you want the globe back.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Net, getJson, apiUrl, type Contact, type EventMsg } from './net.js';
import { Wall, sevColor, type DetectionPin, type WatchBox } from './wall.js';
import { renderCaseFile, renderIncident } from './casefile.js';
import { Scrubber } from './scrubber.js';
import { startOrbits } from './orbits.js';
import { architectureSheet, sourcesSheet, helpSheet } from './sheets.js';
import { Panel, type TabId } from './panel.js';
import { BASE_LAYERS } from './gibs.js';
import { loadCameras, frameUrl, CAMERA_SOURCES, type Camera } from './cameras.js';

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
  domains: new Set(['air', 'sea', 'geo', 'thermal', 'orbit']),
  cameras: [] as Camera[],
};

let wall: Wall;
let net: Net;
let scrubber: Scrubber;
let panel: Panel;

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
        [...state.domains].filter((d) => d !== 'orbit'),
      );
      paintViewInfo(zoom);
    },
    (id) => panel?.markFailing(id),
    (c) => openCamera(c),
    (c) => void openContact(c.id),
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
  resubscribe();

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

  panel = new Panel($('#panel'), {
    onBaseLayer: (l) => wall.setBaseLayer(l),
    onOverlay: (l, on) => wall.setOverlay(l, on),
    onOverlayOpacity: (id, v) => wall.setOverlayOpacity(id, v),
    onDomain: (d, on) => {
      if (d === 'camera') {
        // Cameras are fetched by the browser and never stored, so they are
        // not a subscription domain. Load on first enable.
        if (on && !state.cameras.length) void loadCameraLayer();
        else wall.setCameras(state.cameras, on);
        return;
      }
      if (on) state.domains.add(d);
      else state.domains.delete(d);
      resubscribe();
    },
    onWatchbox: (w) => wall.fitBox(w),
    onTab: (t) => {
      if (t === 'feed') paintTicker();
      if (t === 'time') paintTimeTab();
    },
  });
  panel.setWatchboxes(watchboxes);
  // Blue Marble is the default and is already in the style; this makes the
  // panel's radio state and the map agree from the first frame.
  wall.setBaseLayer(BASE_LAYERS[0]!);

  $('#proj-toggle').addEventListener('click', () => {
    const next = wall.currentProjection === 'globe' ? 'flat' : 'globe';
    wall.setProjection(next);
    const b = $('#proj-toggle');
    b.textContent = next === 'globe' ? '◍ GLOBE' : '▦ FLAT';
    b.classList.toggle('on', next === 'globe');
  });

  $('#sc-live').addEventListener('click', () => scrubber.goLive());
  $('#sc-play').addEventListener('click', () => scrubber.togglePlay());
  $('#sc-rate').addEventListener('click', () => scrubber.cycleRate());
  document.querySelectorAll('[data-seek]').forEach((el) =>
    el.addEventListener('click', () =>
      scrubber.seekRelative(Number((el as HTMLElement).dataset.seek)),
    ),
  );
  // The INFO tab is re-rendered on every tab switch, so these are bound
  // by delegation rather than per-element.
  $('#panel').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-sheet]');
    if (!t) return;
    const which = (t as HTMLElement).dataset.sheet;
    openSheet(
      which === 'arch'
        ? architectureSheet()
        : which === 'sources'
          ? sourcesSheet()
          : helpSheet(),
    );
  });

  // First visit gets the explainer unprompted. A console that assumes you
  // already know what it is will be closed before you find out.
  try {
    if (!localStorage.getItem('dr.seen')) {
      localStorage.setItem('dr.seen', '1');
      setTimeout(() => openSheet(helpSheet()), 600);
    }
  } catch {
    /* private browsing; not worth failing over */
  }

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
    if (e.target !== document.body) return;
    if (e.key === ' ') {
      e.preventDefault();
      scrubber.togglePlay();
    }
    const tabs: TabId[] = ['layers', 'watch', 'feed', 'time', 'info'];
    const n = Number(e.key);
    if (n >= 1 && n <= 5) panel.open(tabs[n - 1]!);
    if (e.key === 'g' || e.key === 'G') $('#proj-toggle').click();
  });
}

/* ------------------------------------------------------------- contacts */

/**
 * Everything the feeds know about one target.
 *
 * The wire carries 28 bytes per contact, which is the right trade for a
 * stream but means identity never reaches the browser. So this fetches it
 * on click: MMSI, IMO, call sign, destination, registration, ship type,
 * flag state, plus how long we have been watching and every detection that
 * has named it.
 */
async function openContact(entityId: string): Promise<void> {
  const el = $('#casefile');
  el.hidden = false;
  el.innerHTML =
    '<div class="cf-head"><div><div class="k">CONTACT</div>' +
    '<h2>reading...</h2></div></div>';

  try {
    const d = await getJson<{
      entity: Record<string, unknown>;
      track: { ts: number; lat: number; lon: number; sog: number | null; cog: number | null }[];
      detections: { id: number; rule: string; severity: number; ts_start: number; title: string }[];
    }>(`/api/entity/${encodeURIComponent(entityId)}`);

    const e = d.entity;
    const props = (e.props ?? {}) as Record<string, unknown>;
    const kt = (v: unknown): string => (v == null ? '—' : `${Number(v).toFixed(1)} kt`);
    const deg = (v: unknown): string => (v == null ? '—' : `${Number(v).toFixed(0)}°`);
    const ft = (v: unknown): string =>
      v == null ? '—' : `${Math.round(Number(v) * 3.28084).toLocaleString()} ft`;

    // Show every property the feed gave us, not a curated subset. If the
    // upstream knows it, the reader should be able to see it.
    const known = new Set(['label', 'kind', 'flag']);
    const extra = Object.entries(props)
      .filter(([k, v]) => !known.has(k) && v !== null && v !== undefined && v !== '')
      .map(
        ([k, v]) =>
          `<dt>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</dt><dd>${esc(
            typeof v === 'object' ? JSON.stringify(v) : String(v),
          )}</dd>`,
      )
      .join('');

    const watchedH = (Date.now() - Number(e.first_seen)) / 3600_000;

    el.innerHTML = `
      <div class="cf-head">
        <div>
          <div class="k">CONTACT &middot; ${esc(String(e.domainName ?? '').toUpperCase())}${
            e.kind ? ` &middot; ${esc(String(e.kind))}` : ''
          }</div>
          <h2>${esc(String(e.label ?? entityId))}</h2>
        </div>
        <button class="x" id="cf-x" title="close (esc)">&times;</button>
      </div>
      <div class="cf-body">

        <div class="sec">
          <h3>NOW</h3>
          <dl class="kv">
            <dt>position</dt><dd>${Number(e.last_lat).toFixed(5)}, ${Number(e.last_lon).toFixed(5)}</dd>
            <dt>speed over ground</dt><dd>${kt(e.last_sog_kt)}</dd>
            <dt>course over ground</dt><dd>${deg(e.last_cog_deg)}</dd>
            ${e.last_alt_m != null ? `<dt>altitude</dt><dd>${ft(e.last_alt_m)}</dd>` : ''}
            <dt>last report</dt><dd>${ago(Number(e.last_seen))} ago</dd>
            <dt>cell</dt><dd>${esc(String(e.geohash5 ?? ''))}</dd>
          </dl>
        </div>

        <div class="sec">
          <h3>IDENTITY</h3>
          <dl class="kv">
            <dt>id</dt><dd>${esc(String(e.entity_id))}</dd>
            ${e.kind ? `<dt>type</dt><dd>${esc(String(e.kind))}</dd>` : ''}
            ${e.flag ? `<dt>flag</dt><dd>${esc(String(e.flag))}</dd>` : ''}
            ${extra || '<dt>—</dt><dd>the feed gave us nothing beyond position</dd>'}
          </dl>
        </div>

        <div class="sec">
          <h3>HISTORY</h3>
          <dl class="kv">
            <dt>first seen</dt><dd>${new Date(Number(e.first_seen)).toISOString().slice(0, 16)}Z</dd>
            <dt>tracked for</dt><dd>${
              watchedH < 48 ? `${watchedH.toFixed(1)} hours` : `${(watchedH / 24).toFixed(1)} days`
            }</dd>
            <dt>observations</dt><dd>${Number(e.observation_count ?? 0).toLocaleString()}</dd>
            <dt>track points (12h)</dt><dd>${d.track.length.toLocaleString()}</dd>
          </dl>
        </div>

        <div class="sec">
          <h3>SOURCES</h3>
          ${
            ((e.sources ?? []) as { key: string; label: string; license: string }[]).length
              ? `<div class="chain">${((e.sources ?? []) as { key: string; label: string; license: string }[])
                  .map(
                    (s) =>
                      `<div class="lnk"><span class="n">·</span><span>
                         <b style="color:var(--txt-hot)">${esc(s.label)}</b><br>
                         <span class="dim">${esc(s.license)}</span></span></div>`,
                  )
                  .join('')}</div>`
              : '<p class="caveat">No source recorded.</p>'
          }
        </div>

        <div class="sec">
          <h3>DETECTIONS NAMING THIS TARGET &mdash; ${d.detections.length}</h3>
          ${
            d.detections.length
              ? d.detections
                  .map(
                    (x) => `
                <div class="ev" data-det="${x.id}">
                  <div class="ev-top">
                    <span class="sev" style="background:rgb(${sevColor(x.severity, 255)
                      .slice(0, 3)
                      .join(',')})">${x.severity}</span>
                    <span class="ev-rule">${esc(x.rule.replace(/_/g, ' '))}</span>
                    <span class="ev-t">${ago(x.ts_start)}</span>
                  </div>
                  <div class="ev-title">${esc(x.title)}</div>
                </div>`,
                  )
                  .join('')
              : '<p class="caveat">Nothing has been flagged about this target. Most targets never are.</p>'
          }
        </div>
      </div>`;

    el.querySelector('#cf-x')?.addEventListener('click', closeCase);
    el.querySelectorAll('[data-det]').forEach((n) =>
      n.addEventListener('click', () =>
        void openCase(Number((n as HTMLElement).dataset.det)),
      ),
    );

    // Draw its recent track so the panel and the map agree.
    wall.setTrack(d.track.map((p) => [p.lon, p.lat] as [number, number]));
    wall.setCone(null);
  } catch (err) {
    el.innerHTML =
      `<div class="cf-head"><div><div class="k">CONTACT</div>` +
      `<h2>could not read</h2></div><button class="x" id="cf-x">&times;</button></div>` +
      `<div class="cf-body"><pre class="blk">${esc((err as Error).message)}</pre></div>`;
    el.querySelector('#cf-x')?.addEventListener('click', closeCase);
  }
}

/* ------------------------------------------------------------- cameras */

/**
 * Public infrastructure cameras. Fetched in the browser, never stored.
 *
 * The rest of the system records everything so nobody has to press record.
 * Cameras are the one input where that instinct is wrong: an archive of
 * street imagery is a different kind of object from an archive of AIS
 * positions. So no camera frame touches the database.
 */
async function loadCameraLayer(): Promise<void> {
  const { cameras, errors } = await loadCameras();
  state.cameras = cameras;
  wall.setCameras(cameras, true);
  for (const e of errors) console.warn(`[cameras] ${e.source}: ${e.message}`);
  if (!cameras.length) {
    console.warn('[cameras] no source answered');
  }
}

/** Live still, refreshed on the operator's own cadence. Nothing retained. */
function openCamera(c: Camera): void {
  const src = CAMERA_SOURCES.find((s) => s.id === c.source);
  const el = $('#casefile');
  el.hidden = false;
  el.innerHTML = `
    <div class="cf-head">
      <div>
        <div class="k">CAMERA &middot; ${esc(src?.authority ?? c.source)}</div>
        <h2>${esc(c.label)}</h2>
      </div>
      <button class="x" id="cf-x">&times;</button>
    </div>
    <div class="cf-body">
      <img id="cam-frame" src="${esc(frameUrl(c))}" alt="${esc(c.label)}"
           style="width:100%;border:1px solid var(--hair);background:var(--void)">
      <div class="sec">
        <dl class="kv">
          <dt>position</dt><dd>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>
          <dt>operator</dt><dd>${esc(src?.authority ?? '?')}</dd>
          <dt>refresh</dt><dd>every ${src?.refreshS ?? 60}s, per the operator</dd>
          <dt>retained</dt><dd style="color:var(--ok)">nothing. This frame is not stored.</dd>
        </dl>
      </div>
      <div class="sec">
        <h3>LICENCE</h3>
        <p class="caveat">${esc(src?.licence ?? '')}</p>
      </div>
      <div class="sec">
        <h3>WHY THIS IS HERE</h3>
        <ul class="caveat">
          <li>Corroboration. A detection with a camera looking at it is a
              detection you can check with your eyes.</li>
          <li>Roads, ports, canals and waterways only. Infrastructure, where
              the subject is a junction or a lock gate.</li>
          <li>No frame is written to the archive, so there is nothing here to
              search later. That is deliberate.</li>
        </ul>
      </div>
    </div>`;
  el.querySelector('#cf-x')?.addEventListener('click', closeCase);

  const img = el.querySelector('#cam-frame') as HTMLImageElement | null;
  const iv = window.setInterval(() => {
    if (!document.body.contains(img)) {
      window.clearInterval(iv);
      return;
    }
    if (img) img.src = frameUrl(c);
  }, (src?.refreshS ?? 60) * 1000);
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

function paintTicker(): void {
  const list = visibleDetections();
  const el = panel?.feedBody;
  if (!el) return; // FEED tab is not open; nothing to paint into

  if (!list.length) {
    const filtered = state.filters.size > 0 && state.detections.length > 0;
    const noData = state.liveContacts === 0 && !state.connected;
    el.innerHTML =
      '<div style="padding:22px 16px;color:var(--txt-dim);line-height:1.7;font-size:11px">' +
      (filtered
        ? 'Nothing matches the active filters.<br><br>' +
          `${state.detections.length} detections are hidden. Clear a filter above.`
        : noData
          ? '<span style="color:var(--alert)">Link is down.</span><br><br>' +
            'The console cannot reach the API. Nothing here is trustworthy ' +
            'until that reconnects.'
          : 'No detections in the last 24 hours.<br><br>' +
            'That is a valid result, not a failure. The engine only speaks when ' +
            'observations diverge from an explicit model, and most hours nothing ' +
            'does.<br><br>' +
            'Two things stay quiet on a young deployment:<br>' +
            '&middot; AIRSPACE_VOID needs about a week of samples before it has a ' +
            'baseline to compare against.<br>' +
            '&middot; DARK_VESSEL needs a hull to actually go dark and come back, ' +
            'which takes hours.<br><br>' +
            'The system watches ten chokepoints, not the whole planet. Use the ' +
            'strip at the top left of the map to jump to one.') +
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
}

/** The TIME tab: what the archive actually holds, and what that costs. */
function paintTimeTab(): void {
  const el = panel?.timeBody;
  if (!el) return;
  const span = Date.now() - state.archiveFrom;
  el.innerHTML =
    `<p class="pn-note" style="margin-top:0">
       There is no record button. The archive fills continuously, so drag
       the timeline at the bottom to any past moment.
     </p>
     <div class="pn-sec">
       <div class="pn-k">ARCHIVE</div>
       <div class="kv-min">
         <span>from</span><span>${new Date(state.archiveFrom).toISOString().slice(0, 16)}Z</span>
         <span>span</span><span>${(span / 3600_000).toFixed(1)} hours</span>
         <span>mode</span><span>${state.replayAt ? 'REPLAY' : 'LIVE'}</span>
       </div>
     </div>
     <div class="pn-sec">
       <div class="pn-k">RETENTION</div>
       <p class="pn-note" style="padding:0">
         Full fidelity for 12 hours, then thinned to one fix per target per
         30 minutes out to 7 days. A dark-vessel verdict only needs the fix
         either side of a gap, so the thinning costs nothing analytically.
       </p>
     </div>`;
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
    // Drawing the evidence on the map is separate from loading it. A
    // renderer failure previously replaced the whole Case File with
    // "could not load", hiding evidence that had arrived perfectly well.
    try {
      wireCaseFile(el, data);
    } catch (err) {
      console.error('[case] overlay draw failed:', (err as Error).message);
      el.querySelector('#cf-x')?.addEventListener('click', closeCase);
    }
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
    rd('mode', state.replayAt ? 'REPLAY' : 'LIVE', state.replayAt ? 'warn' : 'good');
}

/**
 * Jump-to-watchbox strip.
 *
 * The ingest worker polls ten chokepoints, not the whole planet, because
 * scraping the entire sky every ten seconds would get us rate-limited off
 * our own data sources within the hour. That is a defensible engineering
 * decision and a terrible first impression: zoomed out, the map looks
 * broken rather than deliberate.
 *
 * So the console now says where it is looking, and lets you go there in
 * one click. If a system does not tell you where its attention is, the
 * reader assumes it has none.
 */
function resubscribe(): void {
  const b = wall.map.getBounds();
  net.subscribe(
    {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast(),
    },
    [...state.domains].filter((d) => d !== 'orbit'),
  );
  wall.setOrbitVisible(state.domains.has('orbit'));
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
