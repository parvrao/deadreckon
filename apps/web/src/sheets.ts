/**
 * DEADRECKON :: the two things worth a full-width panel.
 *
 * ARCHITECTURE, because the scaling claim should be checkable rather than
 * asserted, and SOURCES, because a map that will not tell you what it is
 * made of is asking for trust it has not earned.
 */

import { getJson } from './net.js';

/**
 * The panel that should have existed from the first commit.
 *
 * The console opened onto a dark map with two buttons and no indication
 * that it had a timeline, a detection engine, clickable evidence, or any
 * capability at all. A tool that assumes you already know what it is gets
 * closed before you find out.
 */
export function helpSheet(): string {
  return `
  <div class="cf-head">
    <div>
      <div class="k">WHAT THIS IS</div>
      <h2>A tripwire for public data, not a live map.</h2>
    </div>
    <button class="x" id="sh-x">&times;</button>
  </div>
  <div class="cf-body">

    <div class="sec">
      <p class="prose">
        Live OSINT maps show you what is out there right now. This one runs a
        detection engine over the same public feeds and tells you when
        something <b>changed</b> &mdash; a ship going dark and reappearing where
        physics says it could not be, an air corridor emptying, a cluster of
        aircraft losing GPS at once &mdash; and hands you the evidence chain
        behind every claim.
      </p>
      <p class="prose" style="margin-top:11px">
        Nothing here requires you to have been watching. The archive fills
        continuously, so you can drag back to a moment nobody thought to record.
      </p>
    </div>

    <div class="sec">
      <h3>THE THREE SURFACES</h3>
      <dl class="kv">
        <dt>THE WALL</dt>
        <dd>The map. Every contact currently reporting, coloured by domain.
            Hover any dot for its identity, speed and heading.</dd>
        <dt>THE TICKER</dt>
        <dd>Right-hand column. What the engine noticed without being asked.
            Click any row to open its Case File.</dd>
        <dt>THE CASE FILE</dt>
        <dd>Why the engine thinks so: the method, the exact HTTP responses it
            rests on with their hashes, the target's track, and an explicit
            list of what would have to be true for the finding to be wrong.</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>THINGS YOU CAN DO</h3>
      <dl class="kv">
        <dt>Jump to a watchbox</dt>
        <dd>The strip at the top left of the map. Ten chokepoints are actively
            polled: Hormuz, Malacca, Bab-el-Mandeb, Suez, Bosphorus, Panama,
            Taiwan Strait, Kerch, Gulf of Guinea, Danish Straits. Click a name
            to fly there, or click the cyan box on the map itself.</dd>
        <dt>Toggle layers</dt>
        <dd>The legend at bottom left is a control, not a caption. Click any
            row to add or remove that domain from the live feed.</dd>
        <dt>Scrub time</dt>
        <dd>The timeline along the bottom. Drag it, scroll on it, or use the
            <b>-1h</b> and <b>-15m</b> buttons. <b>▶</b> replays forward at the
            rate shown next to it. <b>● LIVE</b> returns to now.
            There is deliberately no record button.</dd>
        <dt>Filter detections</dt>
        <dd>The rule chips above the ticker. Click to show only that rule.</dd>
        <dt>Export evidence</dt>
        <dd>Every Case File has a download that produces a self-contained JSON
            bundle: the finding, every source record with its payload hash, the
            method, the limitations, and a canonical hash of the bundle itself.</dd>
        <dt>Audit the archive</dt>
        <dd>SOURCES lists every feed and its licence.
            <a href="/api/provenance/verify" style="color:var(--sea)">/api/provenance/verify</a>
            recomputes the tamper-evident hash chain over everything ingested.</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>WHAT THE ENGINE LOOKS FOR</h3>
      <dl class="kv">
        <dt>DARK_VESSEL</dt><dd>AIS goes quiet, then returns outside the envelope physics allows</dd>
        <dt>SPOOF_DISCONTINUITY</dt><dd>Reappearance implies a speed above the hull class ceiling</dd>
        <dt>AIRSPACE_VOID</dt><dd>Aircraft count collapses against this cell's own hour-of-week baseline</dd>
        <dt>GNSS_BLOOM</dt><dd>A cluster of aircraft reporting degraded navigation integrity</dd>
        <dt>RENDEZVOUS</dt><dd>Two merchant hulls alongside, sustained, away from any anchorage</dd>
        <dt>LOITER</dt><dd>Long path, no progress. The ISR racetrack signature</dd>
        <dt>SQUAWK_EMERGENCY</dt><dd>7500 hijack, 7600 radio failure, 7700 general emergency</dd>
        <dt>THERMAL_ANOMALY</dt><dd>VIIRS hotspot above 40 MW radiative power</dd>
        <dt>SEISMIC_SHALLOW</dt><dd>Magnitude 3.2+ at 6 km depth or less</dd>
        <dt style="color:var(--alert)">CONFLUENCE</dt>
        <dd style="color:var(--alert)">Two or more of the above agreeing in space and
            time, from <i>different</i> sensing modalities. The one that matters.</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>KEYS</h3>
      <dl class="kv">
        <dt>Space</dt><dd>play / pause replay</dd>
        <dt>Esc</dt><dd>close any panel</dd>
        <dt>Scroll on timeline</dt><dd>seek</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>IF THE BOARD IS EMPTY</h3>
      <ul class="caveat">
        <li>That is often the correct answer. The engine only speaks when observations diverge from an explicit model, and most hours nothing does.</li>
        <li>Only ten chokepoints are polled, not the whole planet. Scraping the entire sky would get us rate-limited off our own free data sources within the hour. Use the watchbox strip.</li>
        <li>AIRSPACE_VOID needs roughly a week of samples before it has a baseline to compare against. A young deployment gets quieter, not louder.</li>
        <li>Check SOURCES. A dead feed looks exactly like a quiet world, and that mistake turns a missing signal into a false detection.</li>
      </ul>
    </div>
  </div>`;
}

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
