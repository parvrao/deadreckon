/**
 * DEADRECKON :: correctness tests for everything that can be wrong quietly.
 *
 * These cover the pure logic: geodesy, the dead-reckoning verdict, the wire
 * codec, the provenance chain, and CONFLUENCE clustering. No database, no
 * network -- so they run in CI in under a second and there is no excuse
 * for skipping them.
 *
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  geohashEncode,
  geohashBounds,
  cellsForBounds,
  precisionForBounds,
  haversineM,
  bearingDeg,
  destination,
  angleDelta,
} from '../packages/core/dist/geo.js';
import {
  evaluateReacquisition,
  reachableSet,
  reachableSetPolygon,
  extrapolate,
  profileFor,
  PROFILE,
} from '../packages/core/dist/deadreckon.js';
import {
  encodePositions,
  decodePositions,
  decodePositionColumns,
  encodeStrings,
  decodeStrings,
  encodeRemove,
  decodeRemove,
  frameType,
  wireSavings,
  Msg,
} from '../packages/core/dist/wire.js';
import {
  sha256,
  chainNext,
  canonicalize,
  detectionHash,
  verifyChain,
  GENESIS_SHA,
} from '../packages/core/dist/provenance.js';
import { cluster, scoreCluster } from '../packages/engine/dist/confluence.js';

/* ------------------------------------------------------------- geodesy */

test('geohash encodes into a cell that contains the point', () => {
  for (const [lat, lon] of [
    [26.5, 56.4],
    [-33.9, 151.2],
    [64.1, -21.9],
    [0, 0],
    [89.9, 179.9],
  ]) {
    for (const p of [1, 3, 5, 7]) {
      const b = geohashBounds(geohashEncode(lat, lon, p));
      assert.ok(lat >= b.minLat && lat <= b.maxLat, `lat ${lat} p${p}`);
      assert.ok(lon >= b.minLon && lon <= b.maxLon, `lon ${lon} p${p}`);
    }
  }
});

test('cell enumeration is bounded no matter how greedy the viewport', () => {
  const world = { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 };
  assert.ok(cellsForBounds(world, 6, 512).length <= 512);
  // A whole-world request must not resolve to 5 km cells.
  assert.ok(precisionForBounds(world) <= 2);
});

test('destination and haversine are mutual inverses', () => {
  for (const brg of [0, 47, 120, 235, 359]) {
    for (const dist of [500, 50_000, 900_000]) {
      const [la, lo] = destination(26.5, 56.4, brg, dist);
      assert.ok(Math.abs(haversineM(26.5, 56.4, la, lo) - dist) < 0.5);
      assert.ok(Math.abs(angleDelta(bearingDeg(26.5, 56.4, la, lo), brg)) < 0.01);
    }
  }
});

/* -------------------------------------------------- dead reckoning */

const HORMUZ_FIX = { ts: 0, lat: 26.5, lon: 56.4, sogKt: 11, cogDeg: 120 };

test('a tanker inside its envelope is not flagged', () => {
  const p = destination(26.5, 56.4, 126, 44 * 1852);
  const r = evaluateReacquisition(
    HORMUZ_FIX,
    { ts: 4 * 3600e3, lat: p[0], lon: p[1], sogKt: 11, cogDeg: 120 },
    PROFILE.vessel_tanker,
  );
  assert.equal(r.verdict, 'CONSISTENT');
  assert.equal(r.anomalyScore, 0);
});

test('an impossible transit is caught and scored high', () => {
  const p = destination(26.5, 56.4, 120, 300 * 1852);
  const r = evaluateReacquisition(
    HORMUZ_FIX,
    { ts: 4 * 3600e3, lat: p[0], lon: p[1], sogKt: 11, cogDeg: 120 },
    PROFILE.vessel_tanker,
  );
  assert.equal(r.verdict, 'IMPOSSIBLE_TRANSIT');
  assert.ok(r.anomalyScore > 80, `score ${r.anomalyScore}`);
  assert.ok(r.impliedSpeedKt > 70);
  assert.ok(r.rangeExcessM > 0);
});

test('reachable by range but not by heading is a course discontinuity', () => {
  const p = destination(26.5, 56.4, 290, 30 * 1852);
  const r = evaluateReacquisition(
    HORMUZ_FIX,
    { ts: 4 * 3600e3, lat: p[0], lon: p[1], sogKt: 11, cogDeg: 290 },
    PROFILE.vessel_tanker,
  );
  assert.equal(r.verdict, 'COURSE_DISCONTINUITY');
  assert.equal(r.rangeExcessM, 0);
  assert.ok(r.bearingExcessDeg > 0);
});

test('a jet cannot hover: too little progress is itself an anomaly', () => {
  const p = destination(35, 51, 270, 20 * 1852);
  const r = evaluateReacquisition(
    { ts: 0, lat: 35, lon: 51, sogKt: 450, cogDeg: 270 },
    { ts: 1800e3, lat: p[0], lon: p[1], sogKt: 450, cogDeg: 270 },
    PROFILE.aircraft_jet,
  );
  assert.equal(r.verdict, 'IMPLAUSIBLE_LOITER');
});

test('the envelope opens with time and eventually becomes a full disc', () => {
  const short = reachableSet(HORMUZ_FIX, 600e3, PROFILE.vessel_tanker);
  const long = reachableSet(HORMUZ_FIX, 12 * 3600e3, PROFILE.vessel_tanker);
  assert.ok(long.rMaxM > short.rMaxM);
  assert.ok(long.halfAngleDeg > short.halfAngleDeg);
  assert.equal(long.omnidirectional, true);
  assert.equal(short.omnidirectional, false);
});

test('an unknown course produces an omnidirectional envelope, not a guess', () => {
  const s = reachableSet(
    { ...HORMUZ_FIX, cogDeg: null },
    3600e3,
    PROFILE.vessel_default,
  );
  assert.equal(s.omnidirectional, true);
});

test('the drawn polygon is closed and matches the computed radii', () => {
  const s = reachableSet(HORMUZ_FIX, 3 * 3600e3, PROFILE.vessel_tanker);
  const poly = reachableSetPolygon(s, 24);
  assert.deepEqual(poly[0], poly[poly.length - 1], 'ring must close');
  for (const [lon, lat] of poly) {
    const d = haversineM(s.centerLat, s.centerLon, lat, lon);
    assert.ok(d <= s.rMaxM + 1, `vertex ${d} beyond rMax ${s.rMaxM}`);
  }
});

test('extrapolation walks the last course at the last speed', () => {
  const [la, lo] = extrapolate(HORMUZ_FIX, 3600e3);
  assert.ok(Math.abs(haversineM(26.5, 56.4, la, lo) - 11 * 1852) < 2);
});

test('ship type selects the right speed ceiling', () => {
  assert.equal(profileFor(2, 'Crude Oil Tanker').maxSpeedKt, 18);
  assert.equal(profileFor(2, 'high speed craft').maxSpeedKt, 45);
  assert.equal(profileFor(1, 'jet').maxSpeedKt, 620);
  // Unknown type must fall back, never throw.
  assert.ok(profileFor(2, null).maxSpeedKt > 0);
  assert.ok(profileFor(99, 'nonsense').maxSpeedKt > 0);
});

/* ------------------------------------------------------------- the wire */

test('positions round-trip through the binary codec', () => {
  const recs = Array.from({ length: 3000 }, (_, i) => ({
    ref: i + 1,
    domain: (i % 5) + 1,
    kind: i % 7,
    flags: i % 13,
    lat: -80 + (i % 160),
    lon: -179 + (i % 358),
    altM: (i % 12000) * 1.0,
    cogDeg: i % 2 ? (i * 7) % 360 : null,
    sogKt: i % 3 ? (i % 600) / 2 : null,
    ageS: i % 90,
    conf: i % 256,
  }));

  const buf = encodePositions(77, 1.7e12, recs, 1);
  assert.equal(frameType(buf), Msg.POSITIONS);
  assert.equal(buf.byteLength, 20 + recs.length * 28);

  const f = decodePositions(buf);
  assert.equal(f.seq, 77);
  assert.equal(f.records.length, recs.length);

  for (let i = 0; i < recs.length; i += 137) {
    const a = recs[i];
    const b = f.records[i];
    assert.equal(b.ref, a.ref);
    assert.equal(b.domain, a.domain);
    assert.equal(b.flags, a.flags);
    assert.ok(Math.abs(b.lat - a.lat) < 1e-4);
    assert.ok(Math.abs(b.lon - a.lon) < 1e-4);
    assert.equal(b.cogDeg === null, a.cogDeg === null);
    assert.equal(b.sogKt === null, a.sogKt === null);
    if (a.cogDeg !== null) assert.ok(Math.abs(b.cogDeg - a.cogDeg) < 0.06);
    if (a.sogKt !== null) assert.ok(Math.abs(b.sogKt - a.sogKt) < 0.06);
  }
});

test('the columnar decoder produces deck.gl-ordered [lon,lat] pairs', () => {
  const recs = [
    { ref: 9, domain: 2, kind: 1, flags: 0, lat: 26.5, lon: 56.4, altM: 0, cogDeg: 120, sogKt: 11, ageS: 3, conf: 200 },
  ];
  const c = decodePositionColumns(encodePositions(1, Date.now(), recs));
  assert.equal(c.count, 1);
  assert.ok(Math.abs(c.positions[0] - 56.4) < 1e-4, 'index 0 is longitude');
  assert.ok(Math.abs(c.positions[1] - 26.5) < 1e-4, 'index 1 is latitude');
});

test('string interning survives unicode and empty labels', () => {
  const entries = [
    { ref: 1, id: 'sea:636092841', label: 'FRONT ALTAIR 🚢' },
    { ref: 2, id: 'air:a8b3c1', label: '' },
    { ref: 3, id: 'geo:us7000abcd', label: '112 km SSE of Bandar-e Lengeh, Iran' },
  ];
  assert.deepEqual(decodeStrings(encodeStrings(1, entries)), entries);
});

test('removals round-trip', () => {
  const refs = [1, 999, 4294967290];
  assert.deepEqual(decodeRemove(encodeRemove(1, refs)), refs);
});

test('a corrupt frame is rejected rather than misread', () => {
  const buf = encodePositions(1, Date.now(), []);
  buf[0] = 0x00;
  assert.equal(frameType(buf), 0);
  assert.throws(() => decodePositions(buf), /bad magic/);

  const wrongVersion = encodePositions(1, Date.now(), []);
  wrongVersion[1] = 0x09;
  assert.throws(() => decodePositions(wrongVersion), /unsupported version/);
});

test('the binary wire is meaningfully smaller than JSON', () => {
  const s = wireSavings(12_000);
  assert.ok(s.ratio > 4, `ratio ${s.ratio}`);
  assert.equal(s.binaryBytes, 20 + 12_000 * 28);
});

/* -------------------------------------------------------- provenance */

test('the hash chain detects a retroactive edit', () => {
  const payloads = ['{"a":1}', '{"a":2}', '{"a":3}', '{"a":4}'];
  let prev = GENESIS_SHA;
  const records = payloads.map((p) => {
    const payloadSha = sha256(p);
    const chainSha = chainNext(prev, payloadSha);
    const rec = { payloadSha, prevChainSha: prev, chainSha };
    prev = chainSha;
    return rec;
  });

  assert.deepEqual(verifyChain(records), { ok: true });

  // Someone quietly rewrites the third payload.
  records[2].payloadSha = sha256('{"a":999}');
  const bad = verifyChain(records);
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 2);
});

test('canonical JSON is key-order independent', () => {
  assert.equal(
    canonicalize({ b: 1, a: { d: 4, c: 3 } }),
    canonicalize({ a: { c: 3, d: 4 }, b: 1 }),
  );
  assert.equal(canonicalize({ a: 1, u: undefined }), canonicalize({ a: 1 }));
});

test('detection hashes are stable and content-addressed', () => {
  const base = {
    rule: 'DARK_VESSEL',
    tsStart: 1700000000000,
    entityIds: ['sea:2', 'sea:1'],
    lat: 26.5,
    lon: 56.4,
    evidence: { gapSeconds: 4200 },
  };
  // Entity order must not change the identity of the finding.
  assert.equal(
    detectionHash(base),
    detectionHash({ ...base, entityIds: ['sea:1', 'sea:2'] }),
  );
  // A different fact must.
  assert.notEqual(
    detectionHash(base),
    detectionHash({ ...base, evidence: { gapSeconds: 4201 } }),
  );
});

/* -------------------------------------------------------- confluence */

const det = (id, rule, sev, tMin, lat, lon) => ({
  id,
  rule,
  severity: sev,
  ts_start: Date.parse('2026-03-01T00:00:00Z') + tMin * 60_000,
  ts_end: null,
  lat,
  lon,
  geohash5: 'xxxxx',
  entity_ids: [],
  title: rule,
  summary: '',
  evidence: {},
  provenance_ids: [],
  state: 'open',
  hash: `h${id}`,
  incident_id: null,
});

test('co-located, co-temporal detections form one cluster', () => {
  const rows = [
    det(1, 'GNSS_BLOOM', 70, 0, 27.0, 56.0),
    det(2, 'AIRSPACE_VOID', 82, 12, 27.2, 56.3),
    det(3, 'SEISMIC_SHALLOW', 61, 35, 27.1, 56.1),
  ];
  const c = cluster(rows, 150_000, 90 * 60_000);
  assert.equal(c.length, 1);
  assert.equal(c[0].length, 3);
});

test('detections far apart in space or time do not cluster', () => {
  const far = [det(1, 'GNSS_BLOOM', 70, 0, 27, 56), det(2, 'AIRSPACE_VOID', 70, 0, 27, 62)];
  assert.equal(cluster(far, 150_000, 90 * 60_000).length, 2);

  const late = [det(1, 'GNSS_BLOOM', 70, 0, 27, 56), det(2, 'AIRSPACE_VOID', 70, 400, 27, 56)];
  assert.equal(cluster(late, 150_000, 90 * 60_000).length, 2);
});

test('single-linkage chains transitively, as intended', () => {
  // A-B are close, B-C are close, A-C are not. All three are one event.
  const rows = [
    det(1, 'GNSS_BLOOM', 70, 0, 27.0, 56.0),
    det(2, 'AIRSPACE_VOID', 70, 20, 28.0, 56.0),
    det(3, 'THERMAL_ANOMALY', 70, 40, 29.0, 56.0),
  ];
  assert.equal(cluster(rows, 130_000, 90 * 60_000).length, 1);
});

test('corroboration raises severity; piling on the same modality does not', () => {
  const oneDomain = [det(1, 'DARK_VESSEL', 70, 0, 27, 56), det(2, 'RENDEZVOUS', 70, 5, 27, 56)];
  const twoDomains = [det(1, 'DARK_VESSEL', 70, 0, 27, 56), det(2, 'GNSS_BLOOM', 70, 5, 27, 56)];
  assert.ok(scoreCluster(twoDomains, 2) > scoreCluster(oneDomain, 1));
});

test('adding a weak third witness never lowers the score', () => {
  const two = [det(1, 'GNSS_BLOOM', 88, 0, 27, 56), det(2, 'AIRSPACE_VOID', 80, 5, 27, 56)];
  const three = [...two, det(3, 'SQUAWK_EMERGENCY', 30, 9, 27, 56)];
  assert.ok(scoreCluster(three, 2) >= scoreCluster(two, 2));
});

test('severity is capped at 100 however much agrees', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    det(i, 'GNSS_BLOOM', 100, i, 27, 56),
  );
  assert.ok(scoreCluster(many, 5) <= 100);
});

test('clustering an empty or single-item set is safe', () => {
  assert.deepEqual(cluster([], 1000, 1000), []);
  assert.equal(cluster([det(1, 'LOITER', 40, 0, 1, 1)], 1000, 1000).length, 1);
});

/* --------------------------------------------- rendezvous class filter */

/**
 * Regression test for the worst bug this project has shipped.
 *
 * RENDEZVOUS went live claiming "sustained proximity ... away from a
 * berth" while checking neither duration nor berth. It emitted 47
 * detections in a single tick, all of them Swedish rescue launches,
 * Norwegian pilot boats and Stockholm archipelago ferries at their jetties.
 *
 * The name filter is the crudest of the four gates and the easiest to
 * break: tighten it slightly and it swallows real tankers, loosen it and
 * the pilot boats come back. Both failure directions are tested, using
 * the regex extracted from the BUILD rather than retyped here, so the
 * test cannot silently drift away from the code it is guarding.
 */
test('rendezvous name filter excludes service craft without eating merchant hulls', () => {
  const src = readFileSync(
    new URL('../packages/engine/dist/rules.js', import.meta.url),
    'utf8',
  );
  const m = src.match(/RZ_EXCLUDED_NAME\s*=\s*(\/.*\/[a-z]*);/);
  assert.ok(m, 'RZ_EXCLUDED_NAME not found in build -- did the rule get renamed?');
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i');

  // Every one of these appeared in the live false-positive flood.
  const mustExclude = [
    'PILOT 221 SE', 'PILOT 742SE', 'PILOT BOAT', 'PILOT TRAVEMUENDE',
    'RESCUE CECILIA BRATT', 'RESCUER', 'RESCUE HORN STAYER',
    'KBV 304', 'KBV 050', 'F/V TALLONA', 'F/V KUNGSVIK', 'R/V SENSOR',
    'VG 11 RANSKAR', 'VG55 INGAROE', 'VG350 ALTHEA',
    'FN204 DANZIG', 'FN 484 SPIRHOLM', 'HV99 ANNI DORTHE', 'GG1206 DANO',
    'KA09 KLINTS', 'R223 BUSTER', 'R177 DUEODDE', 'H77 FRIDA',
    'O10 HYACINT', 'S10 CHRISTINA',
    'SVITZER EMBLA', 'SVITZER GAIA', 'FAIRPLAY-20', 'FAIRPLAY-97',
    'MULTRASALVOR 6',
  ];
  for (const n of mustExclude) {
    assert.ok(re.test(n), `should have been excluded as service craft: ${n}`);
  }

  // Over-matching is the more dangerous failure: it makes the rule silent.
  const mustKeep = [
    'FRONT ALTAIR', 'EVER GIVEN', 'MAERSK DENVER', 'INTERASIA AMPLIFY',
    'KOTA SURIA', 'BBC OPAL', 'NORDIC PEARL', 'SEYCHELLES PRELUDE',
    'ALKA BULLSEYE', 'SOUND CASTOR', 'SOUND PROSPECTOR', 'NAVIGATOR AURORA',
    'TERN FORS', 'OLAV TRYGGVASON', 'BALTIC TAUCHER II', 'DONG YANG NO.12',
    'YU LIN NO.6', 'CMO SIM', 'ATALANTI', 'GROSHERZOGINELISABET',
    'HARRY STONE', 'SC FALCON', 'ESTEMAR', 'TORLAND', '416005717',
  ];
  for (const n of mustKeep) {
    assert.ok(!re.test(n), `merchant hull wrongly excluded: ${n}`);
  }
});
