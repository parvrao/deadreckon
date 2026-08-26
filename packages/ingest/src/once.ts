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
const WATCHDOG_SECONDS = RUN_SECONDS + num('WATCHDOG_MARGIN_S', 180);

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

  // ORDERING IS LOAD-BEARING.
  //
  // The first scheduled run put pollOrbit here, before the air loop. It
  // fetched eight TLE groups including Starlink's 10,736 element sets,
  // took 305 seconds, blew straight past the 240-second deadline, and the
  // air loop executed ZERO passes. The watchdog then killed the process
  // before the engine could evaluate anything it had collected.
  //
  // So: the cheap, high-value, time-sensitive work happens first, and
  // anything slow and optional runs afterwards only if there is budget
  // left. Starlink has also been dropped from the groups entirely.
  const deadline = started + RUN_SECONDS * 1000;
  const airEvery = num('POLL_AIR_S', 20) * 1000;
  let airPasses = 0;

  await ing.pollGeo().catch((e) => console.error('[geo]', (e as Error).message));
  await ing.pollThermal().catch((e) => console.error('[thermal]', (e as Error).message));

  while (Date.now() < deadline) {
    const t0 = Date.now();
    await ing.pollAir().catch((e) => console.error('[air]', (e as Error).message));
    airPasses++;
    const spent = Date.now() - t0;
    const wait = Math.min(airEvery - spent, deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }

  // Orbital elements last, and only with real time to spare. They change
  // on the order of hours, so missing a refresh costs nothing; missing the
  // engine evaluation costs the entire run.
  const orbitBudgetMs = num('ORBIT_BUDGET_S', 45) * 1000;
  const spare = WATCHDOG_SECONDS * 1000 - (Date.now() - started) - 60_000;
  if (spare > orbitBudgetMs) {
    const refreshed = await Promise.race([
      ing.pollOrbit(num('POLL_ORBIT_S', 21600)).catch((e) => {
        console.error('[orbit]', (e as Error).message);
        return false;
      }),
      sleep(orbitBudgetMs).then(() => {
        console.warn(`[orbit] budget of ${orbitBudgetMs / 1000}s exhausted, moving on`);
        return false;
      }),
    ]);
    if (!refreshed) console.log('[orbit] not refreshed this run');
  } else {
    console.log('[orbit] skipped, no time budget left');
  }

  console.log(
    `[once] collection window closed after ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${airPasses} air passes, sea ${seaUp ? (ing.seaHealthy ? 'up' : 'degraded') : 'off'}, ` +
      `${ing.queued} observations queued)`,
  );

  // Close the AIS socket first so its final batch lands before we evaluate.
  await ing.stop();
  await sleep(1500);

  // The evaluation phase gets its own fresh budget.
  //
  // On the first scheduled run the collection watchdog fired at 360s and
  // killed the process while 2,335 observations sat unevaluated. The
  // engine pass is the entire point of the job; it must not be starved by
  // a timer that was sized for collection.
  clearTimeout(watchdog);
  const evalDog = setTimeout(() => {
    console.error('[once] evaluation watchdog fired -- forcing exit');
    process.exit(2);
  }, num('EVAL_WATCHDOG_S', 120) * 1000);
  evalDog.unref?.();

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

  clearTimeout(evalDog);
  await closePool();
  console.log(`\n[once] done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[once] fatal:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
