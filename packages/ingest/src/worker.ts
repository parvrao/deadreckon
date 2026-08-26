/**
 * DEADRECKON :: continuous ingest worker.
 *
 * Exactly one of these runs. Forever. That is the entire scalability
 * argument in one sentence: upstream load is a function of what we watch,
 * never of how many people are watching.
 *
 * The worker never serves a request and never holds a socket from a
 * browser. It polls, normalizes, stamps provenance, writes, and evaluates.
 * If every reader disappeared tomorrow the archive would keep filling,
 * which is the point, because the archive is what makes it possible to
 * scrub back to a moment nobody thought to record.
 *
 * If you are on a host with no free always-on tier, `once.ts` runs the
 * same collection logic in a bounded window suitable for a cron job.
 */

import { archiveStats, closePool, getPool } from '@deadreckon/store';
import { Ingest, num } from './core.js';
import { sleep } from './http.js';

const POLL_AIR_S = num('POLL_AIR_S', 20);
const POLL_GEO_S = num('POLL_GEO_S', 60);
const POLL_THERMAL_S = num('POLL_THERMAL_S', 900);
const POLL_ORBIT_S = num('POLL_ORBIT_S', 21600);
const ENGINE_TICK_S = num('ENGINE_TICK_S', 30);

let shuttingDown = false;

/**
 * A loop that logs and continues rather than one that throws and dies.
 * A worker that exits on a transient upstream error is a worker that is
 * offline for exactly the events it exists to catch.
 */
function every(label: string, seconds: number, fn: () => Promise<void>): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (shuttingDown || running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] tick failed:`, (err as Error).message);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), seconds * 1000).unref?.();
}

async function main(): Promise<void> {
  console.log('DEADRECKON ingest worker');
  console.log('  always on. nobody has to press record.\n');

  getPool({ label: 'ingest', max: 4 });
  const ing = new Ingest();
  await ing.init();
  console.log(`[worker] ${ing.watchboxes.length} watchboxes active`);

  ing.startSea();

  every('air', POLL_AIR_S, () => ing.pollAir());
  every('geo', POLL_GEO_S, () => ing.pollGeo());
  every('thermal', POLL_THERMAL_S, () => ing.pollThermal());
  every('orbit', POLL_ORBIT_S, async () => {
    await ing.pollOrbit();
  });

  every('engine', ENGINE_TICK_S, async () => {
    const queued = ing.queued;
    const t0 = Date.now();
    const result = await ing.engineTick();
    Ingest.report(result, queued, Date.now() - t0);
  });

  every('retention', 3600, async () => {
    const r = await ing.retention();
    const s = await archiveStats();
    console.log(
      `[retention] thinned ${r.thinned}, purged ${r.purged} | ` +
        `archive ${Number(s.observations).toLocaleString()} obs, ` +
        `${(Number(s.db_bytes) / 1e6).toFixed(1)} MB`,
    );
  });

  every('heartbeat', 300, async () => {
    const s = await archiveStats();
    console.log(
      `[heartbeat] entities=${s.entities} detections=${s.detections} ` +
        `incidents=${s.incidents} sea=${ing.seaHealthy ? 'up' : 'down'} ` +
        `db=${(Number(s.db_bytes) / 1e6).toFixed(1)}MB`,
    );
  });

  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[worker] ${sig} -- draining`);
    await ing.stop();
    // Flush whatever the engine has not yet seen, so the last tick before
    // a deploy is not silently lost.
    const queued = ing.queued;
    const result = await ing.engineTick().catch(() => null);
    Ingest.report(result, queued, 0);
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (r) =>
    console.error('[worker] unhandled rejection:', r),
  );

  for (;;) await sleep(3600_000);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
