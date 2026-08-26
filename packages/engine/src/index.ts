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

export interface EngineResult {
  detections: Detection[];
  newDetectionIds: number[];
  gapsOpened: number;
  incidents: number;
  timings: Record<string, number>;
  errors: { rule: string; message: string }[];
}

export async function runEngine(ctx: RuleCtx): Promise<EngineResult> {
  const timings: Record<string, number> = {};
  const errors: { rule: string; message: string }[] = [];
  const detections: Detection[] = [];

  const run = async (
    name: string,
    fn: () => Detection[] | Promise<Detection[]>,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      detections.push(...(await fn()));
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

  return { detections, newDetectionIds, gapsOpened, incidents, timings, errors };
}
