/**
 * DEADRECKON :: evidence bundle.
 *
 * The export a newsroom, a risk desk, or an opposing analyst can actually
 * work with. It contains the finding, the inputs, the method, the chain,
 * and -- importantly -- an explicit statement of what the finding does
 * NOT establish.
 *
 * A bundle that only argues for its own conclusion is advocacy. This one
 * ships the counter-argument in the box.
 */

import { SOURCE_BY_ID } from '@deadreckon/core';
import { canonicalize, sha256, verifyChain } from '@deadreckon/core/provenance';
import { detectionById, getPool, trackFor } from '@deadreckon/store';

export interface EvidenceBundle {
  bundleVersion: string;
  generatedAt: string;
  detection: Record<string, unknown>;
  method: { rule: string; description: string; limitations: string[] };
  provenance: {
    records: Record<string, unknown>[];
    chainVerification: unknown;
  };
  tracks: Record<string, unknown>;
  incident: Record<string, unknown> | null;
  siblingDetections: Record<string, unknown>[];
  manifest: { canonicalSha256: string; recordCounts: Record<string, number> };
  disclaimer: string;
}

const METHOD: Record<string, { description: string; limitations: string[] }> = {
  DARK_VESSEL: {
    description:
      'The target stopped transmitting, then resumed. A reachable set was ' +
      'computed from the last known fix using a per-class kinematic envelope ' +
      '(maximum speed, course drift rate, minimum plausible transit). The ' +
      'reacquisition position was tested against that envelope.',
    limitations: [
      'AIS coverage is receiver-dependent. A gap may be a coverage hole rather than a decision.',
      'Kinematic ceilings are per ship-type class and are deliberately generous.',
      'A vessel type reported incorrectly in AIS static data yields the wrong envelope.',
      'The finding establishes an inconsistency, not an intent.',
    ],
  },
  SPOOF_DISCONTINUITY: {
    description:
      'The reacquisition position implies a transit speed above the physical ' +
      'ceiling for the target class. Either the position, the identity, or the ' +
      'earlier fix is false.',
    limitations: [
      'A duplicated or hijacked MMSI produces the same signature as a spoofed position.',
      'A single corrupt AIS message can produce a false positive; corroboration matters.',
      'The finding does not identify which of the two positions is the false one.',
    ],
  },
  AIRSPACE_VOID: {
    description:
      'Live aircraft count in the cell was compared against a Welford rolling ' +
      'mean and standard deviation for the same cell at the same hour of the ' +
      'week. Escalation requires z < -3 and a drop of at least 60%.',
    limitations: [
      'A receiver outage in the feed is indistinguishable from an emptied sky. Check ingest health for the same window.',
      'Baselines need roughly a week of samples before they are meaningful.',
      'Weather reroutes produce genuine voids with no security significance.',
    ],
  },
  GNSS_BLOOM: {
    description:
      'Aggregated ADS-B navigation integrity (NIC) and accuracy (NACp) ' +
      'categories across aircraft in the cell. A degradation rate above 35% ' +
      'with at least five degraded aircraft is treated as an interference bloom.',
    limitations: [
      'Some airframes chronically report low NIC for avionics reasons.',
      'Interference is inferred from degradation, never measured directly.',
      'Source and type of interference are not determined.',
    ],
  },
  RENDEZVOUS: {
    description:
      'Two vessels within 500 m, both below 1.2 kt. Consistent with a ' +
      'ship-to-ship transfer.',
    limitations: [
      'Anchorages, pilot boarding areas and fishing grounds produce the same signature.',
      'Proximity is computed from reported positions, which may themselves be false.',
    ],
  },
  LOITER: {
    description:
      'Track straightness (net displacement / path length) below 0.32 over at ' +
      'least 60 km of flown path. Consistent with an ISR or tanker orbit.',
    limitations: [
      'Holding patterns near congested airports produce the same signature.',
      'Search and rescue, survey and training flights also orbit.',
    ],
  },
  SEISMIC_SHALLOW: {
    description:
      'USGS event with magnitude >= 3.2 and focal depth <= 6 km. Shallow and ' +
      'moderate is the profile of a surface release.',
    limitations: [
      'Preliminary USGS depths are frequently revised, often substantially.',
      'Mining, quarrying and induced seismicity share this profile.',
    ],
  },
  THERMAL_ANOMALY: {
    description:
      'VIIRS 375 m active-fire detection with fire radiative power above 40 MW.',
    limitations: [
      'Wildfire, agricultural burning, gas flaring and industrial heat all qualify.',
      'Overpass timing means detection can lag the event by hours.',
    ],
  },
  SQUAWK_EMERGENCY: {
    description: 'Transponder code 7500, 7600 or 7700 observed on ADS-B.',
    limitations: [
      'Codes are frequently set in error and cleared within a minute.',
      '7600 in particular is often an avionics fault rather than an event.',
    ],
  },
  CONFLUENCE: {
    description:
      'Independent detections from at least two different sensing modalities ' +
      'clustered within 150 km and 90 minutes by single-linkage union-find.',
    limitations: [
      'Spatial and temporal correlation is not causation and no causal claim is made.',
      'A single misbehaving feed can contribute to a cluster; check each member separately.',
    ],
  },
};

export async function buildEvidenceBundle(id: number): Promise<EvidenceBundle | null> {
  const d = await detectionById(id);
  if (!d) return null;

  const { rows: provRows } = d.provenance_ids.length
    ? await getPool().query(
        `SELECT id, source_id, url, fetched_at, http_status, payload_sha,
                prev_chain_sha, chain_sha, parser_version, record_count, bytes
           FROM provenance WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [d.provenance_ids],
      )
    : { rows: [] as Record<string, unknown>[] };

  const provenance = provRows.map((p) => ({
    ...p,
    source: SOURCE_BY_ID.get(Number(p.source_id))?.key ?? null,
    license: SOURCE_BY_ID.get(Number(p.source_id))?.license ?? null,
  }));

  // Verify the chain around these records rather than just asserting it.
  const chainVerification =
    provRows.length > 1
      ? verifyChain(
          provRows.map((p) => ({
            payloadSha: String(p.payload_sha),
            prevChainSha: String(p.prev_chain_sha),
            chainSha: String(p.chain_sha),
          })),
        )
      : { ok: true, note: 'single record -- verify against the full source chain' };

  const tracks: Record<string, unknown> = {};
  for (const eid of d.entity_ids.slice(0, 6)) {
    tracks[eid] = await trackFor(
      eid,
      d.ts_start - 12 * 3600_000,
      (d.ts_end ?? d.ts_start) + 6 * 3600_000,
      3000,
    );
  }

  const incident = d.incident_id
    ? (await getPool().query(`SELECT * FROM incident WHERE id = $1`, [d.incident_id]))
        .rows[0] ?? null
    : null;

  const siblings = incident
    ? (
        await getPool().query(
          `SELECT id, rule, severity, ts_start, lat, lon, title, hash
             FROM detection
            WHERE incident_id = $1 AND id <> $2 ORDER BY ts_start`,
          [d.incident_id, d.id],
        )
      ).rows
    : [];

  const method = METHOD[d.rule] ?? {
    description: 'Rule-specific method not documented.',
    limitations: ['Undocumented method -- treat with corresponding caution.'],
  };

  const body = {
    bundleVersion: 'deadreckon-evidence/1',
    generatedAt: new Date().toISOString(),
    detection: d as unknown as Record<string, unknown>,
    method: { rule: d.rule, ...method },
    provenance: { records: provenance, chainVerification },
    tracks,
    incident,
    siblingDetections: siblings,
  };

  return {
    ...body,
    manifest: {
      // Hash of the bundle contents, so a recipient can prove the copy they
      // hold is the copy that was issued.
      canonicalSha256: sha256(canonicalize(body)),
      recordCounts: {
        provenanceRecords: provenance.length,
        trackedEntities: Object.keys(tracks).length,
        siblingDetections: siblings.length,
      },
    },
    disclaimer:
      'DEADRECKON reports anomalies in public data. A detection establishes ' +
      'that observations were inconsistent with an explicit physical or ' +
      'statistical model -- nothing more. It does not establish intent, ' +
      'identity, attribution, or that any event occurred. Every input is ' +
      'listed above with its source, licence, fetch time and payload hash so ' +
      'that the finding can be independently reproduced or refuted.',
  };
}
