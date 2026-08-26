/**
 * DEADRECKON :: engine orchestrator.
 *
 * One pass over a tick of observations. Rules are independent by design --
 * one throwing must never silence the others, because the tick that breaks
 * a rule is disproportionately likely to be the tick that mattered.
 */

import type { Detection } from '@deadreckon/core';
import { insertDetection } from '@deadreckon/store';
import {
  ruleReacquisition,
  ruleAirspaceVoid,
  ruleGnssBloom,
  ruleSquawk,
  ruleRendezvous,
  ruleLoiter,
  ruleThermal,
  ruleSeismic,
  scanGoingDark,
  type RuleCtx,
} from './rules.js';
import { runConfluence } from './confluence.js';

export * from './rules.js';
export * from './confluence.js';

/**
 * Circuit breaker.
 *
 * On its first live run, RENDEZVOUS emitted 47 detections in a single
 * tick, every one of them a Scandinavian ferry sitting at a jetty. The
 * rule was wrong, but the deeper failure was that nothing stopped it. A
 * board flooded with junk destroys the reader's trust in DARK_VESSEL and
 * CONFLUENCE too, and those are the findings that matter.
 *
 * So: any rule producing more than this many detections in one tick is
 * treated as malfunctioning rather than as unusually productive. We keep
 * the strongest few for diagnosis, drop the rest, and say so loudly.
 *
 * The world does not produce forty ship-to-ship transfers in thirty
 * seconds. If it ever genuinely does, the log will make that obvious and
 * the number can be raised deliberately.
 */
const MAX_PER_RULE_PER_TICK: Record<string, number> = {
  RENDEZVOUS: 6,
  DARK_VESSEL: 12,
  SPOOF_DISCONTINUITY: 12,
  AIRSPACE_VOID: 8,
  GNSS_BLOOM: 8,
  LOITER: 10,
  SQUAWK_EMERGENCY: 10,
  THERMAL_ANOMALY: 15,
  SEISMIC_SHALLOW: 15,
  REACQUISITION: 20,
};
const DEFAULT_MAX_PER_RULE = 12;

export interface EngineResult {
  detections: Detection[];
  newDetectionIds: number[];
  gapsOpened: number;
  incidents: number;
  timings: Record<string, number>;
  errors: { rule: string; message: string }[];
  /** Rules that tripped the breaker this tick, with how many they tried to emit. */
  suppressed: { rule: string; produced: number; kept: number }[];
}

export async function runEngine(ctx: RuleCtx): Promise<EngineResult> {
  const timings: Record<string, number> = {};
  const errors: { rule: string; message: string }[] = [];
  const suppressed: { rule: string; produced: number; kept: number }[] = [];
  const detections: Detection[] = [];

  const run = async (
    name: string,
    fn: () => Detection[] | Promise<Detection[]>,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      const produced = await fn();
      const cap = MAX_PER_RULE_PER_TICK[name] ?? DEFAULT_MAX_PER_RULE;

      if (produced.length > cap) {
        // Keep the highest-severity few so the flood is still diagnosable
        // from the Case File rather than only from the logs.
        const kept = [...produced].sort((a, b) => b.severity - a.severity).slice(0, cap);
        suppressed.push({ rule: name, produced: produced.length, kept: kept.length });
        console.warn(
          `[engine] BREAKER: ${name} produced ${produced.length} detections in one ` +
            `tick (cap ${cap}). Keeping the ${cap} highest-severity and dropping the ` +
            `rest. A rule this productive is almost certainly malfunctioning.`,
        );
        detections.push(...kept);
      } else {
        detections.push(...produced);
      }
    } catch (err) {
      errors.push({ rule: name, message: (err as Error).message });
      console.error(`[engine] ${name} threw:`, (err as Error).message);
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  // Cheap synchronous rules first so a slow DB rule cannot delay them.
  await run('SQUAWK_EMERGENCY', () => ruleSquawk(ctx));
  await run('GNSS_BLOOM', () => ruleGnssBloom(ctx));
  await run('RENDEZVOUS', () => ruleRendezvous(ctx));
  await run('THERMAL_ANOMALY', () => ruleThermal(ctx));
  await run('SEISMIC_SHALLOW', () => ruleSeismic(ctx));

  await run('REACQUISITION', () => ruleReacquisition(ctx));
  await run('AIRSPACE_VOID', () => ruleAirspaceVoid(ctx));
  await run('LOITER', () => ruleLoiter(ctx));

  // Persist. ON CONFLICT (hash) DO NOTHING makes this idempotent, so an
  // ongoing condition produces one row rather than one row per tick.
  const newDetectionIds: number[] = [];
  for (const d of detections) {
    try {
      const id = await insertDetection(d);
      if (id != null) {
        d.id = id;
        newDetectionIds.push(id);
      }
    } catch (err) {
      errors.push({ rule: `persist:${d.rule}`, message: (err as Error).message });
    }
  }

  let gapsOpened = 0;
  try {
    const t0 = Date.now();
    gapsOpened = await scanGoingDark(ctx);
    timings.SCAN_DARK = Date.now() - t0;
  } catch (err) {
    errors.push({ rule: 'SCAN_DARK', message: (err as Error).message });
  }

  // CONFLUENCE runs last: it can only fuse what already exists.
  let incidents = 0;
  try {
    const t0 = Date.now();
    incidents = (await runConfluence(ctx.now)).length;
    timings.CONFLUENCE = Date.now() - t0;
  } catch (err) {
    errors.push({ rule: 'CONFLUENCE', message: (err as Error).message });
  }

  return {
    detections,
    newDetectionIds,
    gapsOpened,
    incidents,
    timings,
    errors,
    suppressed,
  };
}
