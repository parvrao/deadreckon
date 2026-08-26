/**
 * DEADRECKON :: THE CASE FILE.
 *
 * The panel that decides whether this is a toy.
 *
 * Anyone can put a red dot on a map. The question a reader should be able
 * to answer in thirty seconds is: what exactly was observed, what model
 * was it tested against, which HTTP responses is that resting on, and
 * what would have to be true for this to be wrong.
 *
 * So the caveats are not buried in a footer. They are a section.
 */

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const LIMITS: Record<string, string[]> = {
  DARK_VESSEL: [
    'AIS coverage is receiver-dependent. A gap can be a coverage hole rather than a decision.',
    'The kinematic ceiling comes from AIS-reported ship type, which can itself be wrong.',
    'This establishes an inconsistency, not an intent.',
  ],
  SPOOF_DISCONTINUITY: [
    'A duplicated or hijacked MMSI produces the same signature as a spoofed position.',
    'One corrupt AIS message can produce this. Corroboration matters.',
    'This does not identify which of the two positions is the false one.',
  ],
  AIRSPACE_VOID: [
    'A receiver outage looks identical to an emptied sky. Check ingest health for the same window.',
    'Baselines need roughly a week of samples before they mean anything.',
    'Weather reroutes create genuine voids with no security significance.',
  ],
  GNSS_BLOOM: [
    'Some airframes chronically report low NIC for avionics reasons.',
    'Interference is inferred from degradation, never measured directly.',
    'Neither the source nor the type of interference is determined.',
  ],
  RENDEZVOUS: [
    'Anchorages, pilot boarding areas and fishing grounds produce the same signature.',
    'Proximity is computed from reported positions, which may themselves be false.',
  ],
  LOITER: [
    'Holding patterns near congested airports look the same.',
    'Search and rescue, survey and training flights also orbit.',
  ],
  SEISMIC_SHALLOW: [
    'Preliminary USGS depths are frequently revised, often substantially.',
    'Mining, quarrying and induced seismicity share this profile.',
  ],
  THERMAL_ANOMALY: [
    'Wildfire, agricultural burning, gas flaring and industrial heat all qualify.',
    'Overpass timing means detection can lag the event by hours.',
  ],
  SQUAWK_EMERGENCY: [
    'Codes are frequently set in error and cleared within a minute.',
    '7600 in particular is often an avionics fault rather than an event.',
  ],
};

interface Detection {
  id: number;
  rule: string;
  severity: number;
  ts_start: number;
  ts_end: number | null;
  lat: number;
  lon: number;
  geohash5: string;
  entity_ids: string[];
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  hash: string;
  state: string;
  incident_id: number | null;
}

export function renderCaseFile(data: Record<string, unknown>): string {
  const d = data.detection as Detection;
  const prov = (data.provenance ?? []) as Record<string, unknown>[];
  const ev = d.evidence ?? {};
  const incident = data.incident as Record<string, unknown> | null;

  const sevClass = d.severity >= 80 ? 'bad' : d.severity >= 55 ? 'warn' : 'ok';

  return `
  <div class="cf-head">
    <div>
      <div class="k">CASE FILE &middot; ${esc(d.rule)} &middot; SEVERITY ${d.severity}</div>
      <h2>${esc(d.title)}</h2>
    </div>
    <button class="x" id="cf-x" title="close (esc)">&times;</button>
  </div>

  <div class="cf-body">
    <div class="sec">
      <div class="verdict ${sevClass}">${esc(d.summary)}</div>
    </div>

    ${incident ? incidentBanner(incident) : ''}

    ${ev.verdict ? deadReckonBlock(ev) : ''}
    ${ev.zScore !== undefined ? baselineBlock(ev) : ''}
    ${ev.rate !== undefined ? gnssBlock(ev) : ''}
    ${ev.separationM !== undefined ? rendezvousBlock(ev) : ''}
    ${ev.straightness !== undefined ? loiterBlock(ev) : ''}

    <div class="sec">
      <h3>FACTS</h3>
      <dl class="kv">
        <dt>detection id</dt><dd>#${d.id}</dd>
        <dt>rule</dt><dd>${esc(d.rule)}</dd>
        <dt>opened</dt><dd>${iso(d.ts_start)}</dd>
        ${d.ts_end ? `<dt>closed</dt><dd>${iso(d.ts_end)}</dd>` : ''}
        <dt>position</dt><dd>${d.lat.toFixed(5)}, ${d.lon.toFixed(5)} &middot; cell ${esc(d.geohash5)}</dd>
        <dt>entities</dt><dd>${d.entity_ids.length ? d.entity_ids.map(esc).join('<br>') : '&mdash;'}</dd>
        <dt>content hash</dt><dd class="sha">${esc(d.hash)}</dd>
      </dl>
    </div>

    <div class="sec">
      <h3>PROVENANCE CHAIN &mdash; ${prov.length} RECORD${prov.length === 1 ? '' : 'S'}</h3>
      ${
        prov.length
          ? `<div class="chain">${prov.map(chainLink).join('')}</div>
             <p class="caveat" style="margin-top:10px">
               chain[n] = sha256(chain[n&minus;1] &#8214; sha256(payload[n])).
               Any retroactive edit to a stored payload breaks every link after
               it. Verify the whole archive at
               <a href="/api/provenance/verify" style="color:var(--sea)">/api/provenance/verify</a>.
             </p>`
          : '<p class="caveat">No provenance records attached to this detection.</p>'
      }
    </div>

    <div class="sec">
      <h3>WHAT WOULD MAKE THIS WRONG</h3>
      <ul class="caveat">
        ${(LIMITS[d.rule] ?? ['Method not documented for this rule.'])
          .map((l) => `<li>${esc(l)}</li>`)
          .join('')}
      </ul>
    </div>

    <div class="sec">
      <h3>RAW EVIDENCE</h3>
      <pre class="blk">${esc(JSON.stringify(stripHeavy(ev), null, 2))}</pre>
    </div>

    <div class="sec">
      <a class="btn" style="display:inline-block;text-decoration:none;padding:8px 12px"
         href="/api/detections/${d.id}/evidence" download>
        DOWNLOAD EVIDENCE BUNDLE
      </a>
      <p class="caveat" style="margin-top:9px">
        Self-contained JSON: the finding, every provenance record with its
        payload hash, the method, the stated limitations, the target tracks,
        and a canonical hash of the bundle itself.
      </p>
    </div>
  </div>`;
}

/* ------------------------------------------------------- rule blocks */

function deadReckonBlock(ev: Record<string, unknown>): string {
  const set = (ev.reachableSet ?? {}) as Record<string, number | boolean>;
  const impossible = ev.verdict === 'IMPOSSIBLE_TRANSIT';
  return `
  <div class="sec">
    <h3>DEAD-RECKONING VERDICT &mdash; ${esc(ev.verdict)}</h3>
    <p class="prose" style="margin-bottom:11px">
      The target stopped reporting for <b>${fmtDur(Number(ev.gapSeconds))}</b>.
      The shaded envelope on the map is every position it could physically have
      occupied by the time it spoke again. ${
        impossible
          ? 'It reappeared outside that envelope.'
          : 'It reappeared outside the heading sector of that envelope.'
      }
    </p>
    <dl class="kv">
      <dt>went dark</dt><dd>${iso(Number(ev.wentDarkAt))}</dd>
      <dt>reacquired</dt><dd>${iso(Number(ev.reacquiredAt))}</dd>
      <dt>gap</dt><dd>${fmtDur(Number(ev.gapSeconds))}</dd>
      <dt>distance travelled</dt><dd>${ev.observedDistanceNm} nm on bearing ${ev.observedBearingDeg}&deg;</dd>
      <dt>implied speed</dt>
      <dd style="color:${impossible ? 'var(--alert)' : 'var(--txt-hot)'}">
        ${ev.impliedSpeedKt} kt &nbsp;vs class ceiling ${ev.classCeilingKt} kt
        &nbsp;(&times;${ev.speedRatio})
      </dd>
      <dt>reachable range</dt><dd>${set.rMinNm} &ndash; ${set.rMaxNm} nm</dd>
      <dt>reachable bearing</dt>
      <dd>${set.omnidirectional ? 'omnidirectional (course unknown or gap too long)' : `${set.bearingCenterDeg}&deg; &plusmn;${set.halfAngleDeg}&deg;`}</dd>
      ${Number(ev.rangeExcessNm) > 0 ? `<dt>range exceeded by</dt><dd style="color:var(--alert)">${ev.rangeExcessNm} nm</dd>` : ''}
      ${Number(ev.bearingExcessDeg) > 0 ? `<dt>bearing outside by</dt><dd style="color:var(--air)">${ev.bearingExcessDeg}&deg;</dd>` : ''}
      ${ev.watchbox ? `<dt>watchbox</dt><dd>${esc(ev.watchbox)}</dd>` : ''}
    </dl>
  </div>`;
}

function baselineBlock(ev: Record<string, unknown>): string {
  const drop = Number(ev.dropFraction) * 100;
  return `
  <div class="sec">
    <h3>BASELINE COMPARISON</h3>
    <p class="prose" style="margin-bottom:11px">
      Measured against this cell's own rolling normal for this hour of the
      week &mdash; not against a global average, which would flag every quiet
      night as an evacuation.
    </p>
    <dl class="kv">
      <dt>cell</dt><dd>${esc(ev.cell)}</dd>
      <dt>observed now</dt><dd style="color:var(--alert)">${ev.observed} aircraft</dd>
      <dt>rolling mean</dt><dd>${ev.baselineMean} (sd ${ev.baselineStddev}, n=${ev.baselineSamples})</dd>
      <dt>z-score</dt><dd style="color:var(--alert)">${ev.zScore}</dd>
      <dt>drop</dt><dd>${drop.toFixed(0)}%</dd>
      <dt>hour of week (UTC)</dt><dd>${ev.hourOfWeekUtc}</dd>
    </dl>
  </div>`;
}

function gnssBlock(ev: Record<string, unknown>): string {
  return `
  <div class="sec">
    <h3>INTERFERENCE INFERENCE</h3>
    <p class="prose" style="margin-bottom:11px">
      No jamming sensor is involved. Every ADS-B aircraft broadcasts its own
      navigation integrity; when a cluster of them degrades at once, the
      commercial fleet has acted as a distributed sensor network.
    </p>
    <dl class="kv">
      <dt>cell</dt><dd>${esc(ev.cell)}</dd>
      <dt>degraded / total</dt><dd style="color:var(--air)">${ev.degraded} / ${ev.total}</dd>
      <dt>rate</dt><dd>${(Number(ev.rate) * 100).toFixed(0)}%</dd>
      <dt>method</dt><dd>${esc(ev.method)}</dd>
    </dl>
  </div>`;
}

function rendezvousBlock(ev: Record<string, unknown>): string {
  const vs = (ev.vessels ?? []) as Record<string, unknown>[];
  return `
  <div class="sec">
    <h3>PROXIMITY</h3>
    <dl class="kv">
      <dt>separation</dt><dd>${ev.separationM} m</dd>
      <dt>both tankers</dt><dd>${ev.bothTankers ? 'yes' : 'no'}</dd>
      ${vs
        .map(
          (v) =>
            `<dt>${esc(v.label)}</dt><dd>${esc(v.kind)} &middot; MMSI ${esc(v.mmsi)} &middot; ${esc(v.sogKt)} kt</dd>`,
        )
        .join('')}
    </dl>
  </div>`;
}

function loiterBlock(ev: Record<string, unknown>): string {
  return `
  <div class="sec">
    <h3>TRACK GEOMETRY</h3>
    <dl class="kv">
      <dt>path flown</dt><dd>${ev.pathNm} nm</dd>
      <dt>net progress</dt><dd>${ev.netNm} nm</dd>
      <dt>straightness</dt><dd style="color:var(--air)">${ev.straightness}</dd>
      <dt>cumulative turn</dt><dd>${ev.cumulativeTurnDeg}&deg;</dd>
      <dt>duration</dt><dd>${ev.durationMin} min over ${ev.samples} fixes</dd>
      <dt>military registration</dt><dd>${ev.military ? 'yes' : 'no'}</dd>
    </dl>
  </div>`;
}

function incidentBanner(inc: Record<string, unknown>): string {
  return `
  <div class="sec">
    <div class="verdict bad" style="cursor:pointer" id="cf-incident">
      <div style="font-size:9px;letter-spacing:.16em;opacity:.75;margin-bottom:5px">
        ABSORBED INTO INCIDENT #${esc(inc.id)} &middot; SEVERITY ${esc(inc.severity)}
      </div>
      ${esc(inc.title)}
      <div style="margin-top:7px;font-size:10px;opacity:.75">open incident &rarr;</div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ incident */

export function renderIncident(data: Record<string, unknown>): string {
  const inc = data.incident as Record<string, unknown>;
  const members = (data.detections ?? []) as Detection[];

  return `
  <div class="cf-head">
    <div>
      <div class="k">CONFLUENCE INCIDENT #${esc(inc.id)} &middot; SEVERITY ${esc(inc.severity)}</div>
      <h2>${esc(inc.title)}</h2>
    </div>
    <button class="x" id="sh-x">&times;</button>
  </div>
  <div class="cf-body">
    <div class="sec">
      <h3>NARRATIVE</h3>
      <pre class="blk">${esc(inc.narrative)}</pre>
      <p class="caveat" style="margin-top:10px">
        Written by a deterministic template from the constituent detections.
        No language model is in this path. Nothing above appears that is not
        already on the record below.
      </p>
    </div>

    <div class="sec">
      <h3>CONSTITUENT DETECTIONS</h3>
      <div class="chain">
        ${members
          .map(
            (m) => `
          <div class="lnk">
            <span class="n">${m.severity}</span>
            <span>
              <b style="color:var(--txt-hot)">${esc(m.rule)}</b> &mdash; ${esc(m.title)}<br>
              <span class="dim">${iso(m.ts_start)} &middot; ${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}</span><br>
              <span class="sha">${esc(m.hash)}</span>
            </span>
          </div>`,
          )
          .join('')}
      </div>
    </div>

    <div class="sec">
      <h3>WHAT THIS IS NOT</h3>
      <ul class="caveat">
        <li>Correlation in space and time. No causal claim is made.</li>
        <li>A single misbehaving feed can contribute to a cluster &mdash; open each member separately.</li>
        <li>Escalation requires at least two independent sensing modalities, which reduces but does not eliminate this.</li>
      </ul>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- bits */

function chainLink(p: Record<string, unknown>, i: number): string {
  return `
  <div class="lnk">
    <span class="n">${i}</span>
    <span>
      <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a><br>
      <span class="dim">
        ${esc(p.source_label ?? p.source_key)} &middot; HTTP ${esc(p.http_status)} &middot;
        ${iso(Number(p.fetched_at))} &middot; ${esc(p.record_count)} records &middot;
        ${Math.round(Number(p.bytes) / 1024)} KB
      </span><br>
      <span class="dim">licence:</span> <span class="dim">${esc(p.license)}</span><br>
      <span class="dim">payload</span> <span class="sha">${esc(p.payload_sha)}</span><br>
      <span class="dim">chain&nbsp;&nbsp;</span> <span class="sha">${esc(p.chain_sha)}</span>
    </span>
  </div>`;
}

/** Keep the raw-evidence dump readable by dropping the big geometry arrays. */
function stripHeavy(ev: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'reachableSetPolygon' || k === 'trackSample') {
      out[k] = `[${(v as unknown[]).length} points -- drawn on the map]`;
    } else out[k] = v;
  }
  return out;
}

function iso(ms: number): string {
  if (!Number.isFinite(ms)) return '&mdash;';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function fmtDur(s: number): string {
  if (!Number.isFinite(s)) return '&mdash;';
  if (s < 5400) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
