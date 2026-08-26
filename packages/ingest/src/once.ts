/**
 * DEADRECKON :: bounded ingest run.
 *
 * Collects for a fixed window, evaluates, and exits. Built for a scheduled
 * CI job rather than a long-lived process.
 *
 *   node --env-file=.env packages/ingest/dist/once.js
 *
 * The shape of a run:
 *
 *   t=0      connect, load watchboxes, open the AIS stream
 *   t=0..N   poll air every POLL_AIR_S, geo once, thermal once
 *   t=N      close the stream, flush the last batch through the engine
 *   exit 0
 *
 * Everything is bounded. A CI runner that hangs is a CI runner that burns
 * minutes and blocks the next scheduled run, so the whole thing sits under
 * a hard watchdog that exits non-zero rather than waiting.
 */

import { archiveStats, closePool, getPool } from '@deadreckon/store';
import { Ingest, num } from './core.js';
import { sleep } from './http.js';

/** How long to collect. Keep comfortably under the workflow timeout. */
const RUN_SECONDS = num('RUN_SECONDS', 240);
/** Hard ceiling. If we are still here after this, something is wedged. */
const WATCHDOG_SECONDS = RUN_SECONDS + num('WATCHDOG_MARGIN_S', 120);

async function main(): Promise<void> {
  const started = Date.now();
  console.log('DEADRECKON bounded ingest');
  console.log(`  collecting for ${RUN_SECONDS}s, then evaluating and exiting.\n`);

  const watchdog = setTimeout(() => {
    console.error(`[once] watchdog fired at ${WATCHDOG_SECONDS}s -- forcing exit`);
    process.exit(2);
  }, WATCHDOG_SECONDS * 1000);
  watchdog.unref?.();

  getPool({ label: 'once', max: 4 });
  const ing = new Ingest();
  await ing.init();
  console.log(`[once] ${ing.watchboxes.length} watchboxes active`);

  const seaUp = ing.startSea();

  // Orbital elements are only refreshed if they are actually stale. A job
  // running every five minutes must not refetch 11,000 element sets each
  // time; CelesTrak would rightly stop answering us.
  const refreshed = await ing.pollOrbit(num('POLL_ORBIT_S', 21600)).catch((e) => {
    console.error('[orbit]', (e as Error).message);
    return false;
  });
  if (!refreshed) console.log('[orbit] elements still fresh, skipped');

  // One pass each; these change slowly.
  await ing.pollGeo().catch((e) => console.error('[geo]', (e as Error).message));
  await ing.pollThermal().catch((e) => console.error('[thermal]', (e as Error).message));

  // Air on its normal cadence for the length of the window.
  const airEvery = num('POLL_AIR_S', 20) * 1000;
  const deadline = started + RUN_SECONDS * 1000;
  let airPasses = 0;

  while (Date.now() < deadline) {
    const t0 = Date.now();
    await ing.pollAir().catch((e) => console.error('[air]', (e as Error).message));
    airPasses++;
    const spent = Date.now() - t0;
    const wait = Math.min(airEvery - spent, deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }

  console.log(
    `[once] collection window closed after ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${airPasses} air passes, sea ${seaUp ? (ing.seaHealthy ? 'up' : 'degraded') : 'off'}, ` +
      `${ing.queued} observations queued)`,
  );

  // Close the AIS socket first so its final batch lands before we evaluate.
  await ing.stop();
  await sleep(1500);

  const t0 = Date.now();
  const queued = ing.queued;
  const result = await ing.engineTick();
  Ingest.report(result, queued, Date.now() - t0);
  if (!result) console.log('[engine] nothing new to evaluate this run');

  // Retention is hourly work, not five-minutely. Run it in the first slot
  // of each hour so it happens roughly once per hour without needing any
  // state to remember when it last ran.
  if (new Date().getUTCMinutes() < 5) {
    const r = await ing.retention().catch(() => ({ thinned: 0, purged: 0 }));
    console.log(`[retention] thinned ${r.thinned}, purged ${r.purged}`);
  }

  const s = await archiveStats().catch(() => null);
  if (s) {
    console.log(
      `[archive] ${Number(s.observations).toLocaleString()} obs, ` +
        `${Number(s.entities).toLocaleString()} entities, ` +
        `${Number(s.detections).toLocaleString()} detections, ` +
        `${Number(s.incidents).toLocaleString()} incidents, ` +
        `${(Number(s.db_bytes) / 1e6).toFixed(1)} MB`,
    );

    // The free Postgres tier is 1 GB and there is no warning before it
    // fills. Surfacing this in the job log means the ceiling is visible
    // long before it is a problem.
    const pct = (Number(s.db_bytes) / 1e9) * 100;
    if (pct > 70) {
      console.warn(
        `[archive] WARNING: ${pct.toFixed(0)}% of a 1 GB free tier used. ` +
          `Lower RETAIN_TRACK_H or move to a paid instance.`,
      );
    }
  }

  clearTimeout(watchdog);
  await closePool();
  console.log(`\n[once] done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[once] fatal:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
