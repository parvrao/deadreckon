/**
 * DEADRECKON :: canonical data model.
 *
 * One shape for every domain. Every source adapter normalizes into
 * `Observation`, and nothing downstream ever learns which API it came from.
 * That is what makes adding a source a 60-line job instead of a refactor.
 */

/** Numeric domain codes. Stable on the wire -- never renumber these. */
export const Domain = {
  AIR: 1,
  SEA: 2,
  ORBIT: 3,
  GEO: 4,
  THERMAL: 5,
  MEDIA: 6,
} as const;
export type DomainCode = (typeof Domain)[keyof typeof Domain];

export const DOMAIN_NAME: Record<DomainCode, string> = {
  1: 'air',
  2: 'sea',
  3: 'orbit',
  4: 'geo',
  5: 'thermal',
  6: 'media',
};

export const DOMAIN_BY_NAME: Record<string, DomainCode> = {
  air: Domain.AIR,
  sea: Domain.SEA,
  orbit: Domain.ORBIT,
  geo: Domain.GEO,
  thermal: Domain.THERMAL,
  media: Domain.MEDIA,
};

/** Per-observation state bits. Packed into the binary wire frame. */
export const ObsFlag = {
  NONE: 0,
  EMERGENCY: 1 << 0, // squawk 7500/7600/7700
  GNSS_DEGRADED: 1 << 1, // low NIC/NAC -- unwitting jamming sensor
  DARK: 1 << 2, // transponder gap exceeded threshold
  LOITER: 1 << 3, // racetrack / orbit pattern
  STALE: 1 << 4, // extrapolated, not observed
  MILITARY: 1 << 5, // known military registration block
  ON_GROUND: 1 << 6,
  SPOOF_SUSPECT: 1 << 7, // reacquired outside its dead-reckon cone
} as const;

/**
 * The atomic unit. Append-only. Never updated, never deleted before
 * its retention tier expires. This is the substrate that makes
 * "scrub back to any moment" possible without anyone pressing record.
 */
export interface Observation {
  ts: number; // ms epoch, from the SOURCE not from us
  domain: DomainCode;
  entityId: string; // icao24 | mmsi | norad | usgs id | firms id
  lat: number;
  lon: number;
  altM?: number | null;
  sogKt?: number | null; // speed over ground
  cogDeg?: number | null; // course over ground
  flags: number;
  conf: number; // 0..255 source confidence
  props?: Record<string, unknown>;
  /** Set by the ingest pipeline, not by adapters. */
  provenanceId?: number;
  sourceId?: number;
}

/** Denormalized "where is it now" row. Upserted, unlike observations. */
export interface Entity {
  entityId: string;
  domain: DomainCode;
  label: string | null;
  kind: string | null;
  flag: string | null; // country of registration
  firstSeen: number;
  lastSeen: number;
  lastLat: number;
  lastLon: number;
  lastSogKt: number | null;
  lastCogDeg: number | null;
  flags: number;
  props: Record<string, unknown>;
}

/**
 * Provenance record. One per upstream HTTP fetch or WS batch.
 *
 * `chainSha` = sha256(prevChainSha || payloadSha). An append-only hash
 * chain per source, so any later edit to the archive is detectable.
 * This is the thing that turns "a cool map" into "admissible in a newsroom".
 */
export interface Provenance {
  id?: number;
  sourceId: number;
  url: string;
  fetchedAt: number;
  httpStatus: number;
  payloadSha: string;
  prevChainSha: string;
  chainSha: string;
  parserVersion: string;
  recordCount: number;
  bytes: number;
}

export type DetectionRule =
  | 'DARK_VESSEL'
  | 'SPOOF_DISCONTINUITY'
  | 'AIRSPACE_VOID'
  | 'GNSS_BLOOM'
  | 'SQUAWK_EMERGENCY'
  | 'RENDEZVOUS'
  | 'LOITER'
  | 'THERMAL_ANOMALY'
  | 'SEISMIC_SHALLOW'
  | 'CONFLUENCE';

export type DetectionState = 'open' | 'resolved' | 'dismissed';

export interface Detection {
  id?: number;
  rule: DetectionRule;
  severity: number; // 0..100
  tsStart: number;
  tsEnd: number | null;
  lat: number;
  lon: number;
  geohash5: string;
  entityIds: string[];
  title: string;
  summary: string;
  /** Rule-specific payload. Rendered verbatim in the Case File. */
  evidence: Record<string, unknown>;
  provenanceIds: number[];
  state: DetectionState;
  /** sha256 of the canonical detection body. The citable identifier. */
  hash: string;
  /** Set when CONFLUENCE absorbs this detection into an incident. */
  incidentId?: number | null;
}

/**
 * CONFLUENCE output. Bilawal fused six layers by hand over a weekend.
 * This is that, as a rule, in under a minute.
 */
export interface Incident {
  id?: number;
  tsStart: number;
  tsEnd: number;
  lat: number;
  lon: number;
  radiusKm: number;
  severity: number;
  title: string;
  narrative: string;
  detectionIds: number[];
  domains: DomainCode[];
  hash: string;
  state: DetectionState;
}

export interface SourceDef {
  id: number;
  key: string;
  domain: DomainCode;
  label: string;
  license: string;
  homepage: string;
  requiresKey: boolean;
}
