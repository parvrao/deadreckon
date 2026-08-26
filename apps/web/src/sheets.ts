/**
 * DEADRECKON :: the two things worth a full-width panel.
 *
 * ARCHITECTURE, because the scaling claim should be checkable rather than
 * asserted, and SOURCES, because a map that will not tell you what it is
 * made of is asking for trust it has not earned.
 */

import { getJson } from './net.js';

export function architectureSheet(): string {
  void hydrateStats();
  return `
  <div class="cf-head">
    <div>
      <div class="k">ARCHITECTURE</div>
      <h2>One writer. N readers. Constant upstream cost.</h2>
    </div>
    <button class="x" id="sh-x">&times;</button>
  </div>
  <div class="cf-body">

    <div class="sec">
      <h3>THE SHAPE</h3>
      <pre class="blk">  upstream OSINT feeds
        |
        |  ONE poll loop. One replica. Never scaled horizontally.
        v
  [ ingest worker ] --- provenance: sha256 chain per source
        |
        v
  [ postgres ] --- append-only observations + detections
        |            BRIN on the time axis, tiered retention
        v
  [ api + hub ] --- stateless, read-only, scale to N replicas
        |            ONE query per tick shared by every socket
        |            geohash-addressed fan-out, binary deltas
        v
  [ browsers ] --- 28 bytes per contact per frame</pre>
    </div>

    <div class="sec">
      <h3>WHY THIS IS THE INTERESTING PART</h3>
      <p class="prose">
        The obvious way to build a live OSINT map is to let the browser call
        the feeds, or to proxy per request. Cost is then
        <b>O(viewers &times; sources)</b> and the upstream rate limit is a
        function of your popularity. The moment such a project goes viral is
        the moment it gets banned from its own data.
      </p>
      <p class="prose" style="margin-top:11px">
        Here the write path and the read path never touch. The worker's
        request volume is set by the watch list. Ten thousand concurrent
        viewers generate exactly as many upstream requests as zero viewers:
        <b>none</b>. Adding a viewer adds one WebSocket and one entry in a
        per-socket delta table.
      </p>
    </div>

    <div class="sec">
      <h3>THE WIRE</h3>
      <p class="prose" style="margin-bottom:11px">
        Positions travel as fixed 28-byte records with entity identifiers
        interned to a u32 on first sight. Control messages stay JSON, because
        optimizing a handshake is a waste of an afternoon.
      </p>
      <dl class="kv">
        <dt>record size</dt><dd>28 bytes fixed</dd>
        <dt>equivalent JSON</dt><dd>~118 bytes measured</dd>
        <dt>ratio</dt><dd>4.2&times; before compression</dd>
        <dt>delta gate</dt><dd>unchanged fixes are not resent for 20s</dd>
        <dt>backpressure</dt><dd>frames dropped above 4 MB buffered, never queued</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>LIVE COUNTERS</h3>
      <div id="arch-live"><p class="caveat">reading /api/stats ...</p></div>
    </div>

    <div class="sec">
      <h3>WHAT THIS DESIGN GIVES UP</h3>
      <ul class="caveat">
        <li>No photorealistic 3D globe. Tile cost is per session and a globe hides half the planet at all times.</li>
        <li>The single ingest worker is a single point of failure. It is also the only way to keep upstream cost constant; the mitigation is fast restart, not replication.</li>
        <li>Observations are thinned after the raw retention window, so sub-5-minute resolution is not available for old events.</li>
        <li>Baselines need about a week of samples, so a fresh deployment cannot detect an absence yet.</li>
      </ul>
    </div>
  </div>`;
}

async function hydrateStats(): Promise<void> {
  try {
    const s = await getJson<Record<string, Record<string, unknown>>>('/api/stats');
    const el = document.getElementById('arch-live');
    if (!el) return;
    const a = s.archive ?? {};
    const h = s.hub ?? {};
    const w = (h.wire ?? {}) as Record<string, number>;
    el.innerHTML = `
      <dl class="kv">
        <dt>observations archived</dt><dd>${Number(a.observations ?? 0).toLocaleString()}</dd>
        <dt>entities tracked</dt><dd>${Number(a.entities ?? 0).toLocaleString()}</dd>
        <dt>detections</dt><dd>${Number(a.detections ?? 0).toLocaleString()}</dd>
        <dt>incidents</dt><dd>${Number(a.incidents ?? 0).toLocaleString()}</dd>
        <dt>provenance records</dt><dd>${Number(a.provenance_records ?? 0).toLocaleString()}</dd>
        <dt>database size</dt><dd>${(Number(a.db_bytes ?? 0) / 1e6).toFixed(1)} MB</dd>
        <dt>connected sockets</dt><dd>${h.clients ?? 0}</dd>
        <dt>hub tick</dt><dd>${h.tickMs ?? '?'} ms of a ${h.tickBudgetMs ?? '?'} ms budget</dd>
        <dt>shared snapshot</dt><dd>${Number(h.entitiesInSharedSnapshot ?? 0).toLocaleString()} entities, ${h.cellsIndexed ?? 0} cells</dd>
        <dt>wire ratio</dt><dd>${w.compressionRatio ?? '?'}&times; vs JSON</dd>
        <dt style="color:var(--ok)">upstream fetches caused by viewers</dt>
        <dd style="color:var(--ok)">${h.upstreamFetchesCausedByClients ?? 0}</dd>
      </dl>`;
  } catch {
    const el = document.getElementById('arch-live');
    if (el) el.innerHTML = '<p class="caveat">stats unavailable</p>';
  }
}

/* ------------------------------------------------------------ sources */

export function sourcesSheet(): string {
  void hydrateSources();
  return `
  <div class="cf-head">
    <div>
      <div class="k">SOURCES</div>
      <h2>Everything this rests on, and its licence.</h2>
    </div>
    <button class="x" id="sh-x">&times;</button>
  </div>
  <div class="cf-body">
    <div class="sec">
      <p class="prose">
        None of this data is classified. None of it is obtained by any means
        other than a public HTTP request. Each feed is listed with its
        licence, its live health, and the last time it answered. If a feed is
        down, its absence is a data outage and not a quiet world &mdash; which
        is precisely the failure mode that turns a missing signal into a false
        detection, so it is shown here rather than hidden.
      </p>
    </div>
    <div class="sec">
      <h3>FEEDS</h3>
      <div id="src-list"><p class="caveat">reading /api/sources ...</p></div>
    </div>
    <div class="sec">
      <h3>INTEGRITY</h3>
      <p class="prose">
        Every fetch is hashed and chained:
        <code>chain[n] = sha256(chain[n&minus;1] &#8214; sha256(payload[n]))</code>.
        Recompute it yourself at
        <a href="/api/provenance/verify" style="color:var(--sea)">/api/provenance/verify</a>.
      </p>
    </div>
  </div>`;
}

async function hydrateSources(): Promise<void> {
  try {
    const s = await getJson<{
      sources: Record<string, unknown>[];
      health: Record<string, unknown>[];
    }>('/api/sources');
    const byId = new Map(s.health.map((h) => [Number(h.source_id), h]));
    const el = document.getElementById('src-list');
    if (!el) return;

    el.innerHTML = `<div class="chain">${s.sources
      .map((src) => {
        const h = byId.get(Number(src.id));
        const errs = Number(h?.consec_errors ?? 0);
        const ok = h?.last_success && errs === 0;
        const dot = !h ? '#4D6076' : ok ? '#2FD68A' : '#FF2D55';
        return `
        <div class="lnk">
          <span class="n" style="color:${dot}">●</span>
          <span>
            <b style="color:var(--txt-hot)">${esc(src.label)}</b>
            <span class="dim"> &middot; ${esc(src.domainName)}</span><br>
            <span class="dim">${esc(src.license)}</span><br>
            <a href="${esc(src.homepage)}" target="_blank" rel="noopener noreferrer">${esc(src.homepage)}</a><br>
            <span class="dim">
              ${
                h
                  ? `${Number(h.records_total ?? 0).toLocaleString()} records over
                     ${Number(h.fetches_total ?? 0).toLocaleString()} fetches &middot;
                     last success ${h.last_success ? new Date(Number(h.last_success)).toISOString().slice(11, 19) + 'Z' : 'never'}
                     ${errs ? ` &middot; <span style="color:var(--alert)">${errs} consecutive errors</span>` : ''}
                     ${h.last_error ? `<br><span style="color:var(--alert)">${esc(h.last_error)}</span>` : ''}`
                  : `not yet polled${src.requiresKey ? ' &middot; requires an API key' : ''}`
              }
            </span>
          </span>
        </div>`;
      })
      .join('')}</div>`;
  } catch {
    const el = document.getElementById('src-list');
    if (el) el.innerHTML = '<p class="caveat">source catalogue unavailable</p>';
  }
}

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
