/**
 * DEADRECKON :: purge detections from one rule.
 *
 * For when a rule shipped broken and filled the board with junk. Removes
 * its detections and unlinks any incidents that were built on them, so
 * CONFLUENCE does not keep citing findings that no longer exist.
 *
 * Observations are never touched. The archive is append-only and the
 * detections can simply be re-derived from it by the corrected rule.
 *
 *   node --env-file=.env scripts/purge-rule.mjs RENDEZVOUS
 *   node --env-file=.env scripts/purge-rule.mjs RENDEZVOUS --dry-run
 */

import pg from 'pg';

const rule = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!rule) {
  console.error('usage: node --env-file=.env scripts/purge-rule.mjs <RULE> [--dry-run]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run with --env-file=.env');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: /render\.com|neon\.tech|supabase\.co/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

const { rows: before } = await pool.query(
  `SELECT rule, count(*)::int AS n, min(severity) AS lo, max(severity) AS hi
     FROM detection GROUP BY rule ORDER BY n DESC`,
);

console.log('\ncurrent detections by rule:');
for (const r of before) {
  const mark = r.rule === rule ? '  <-- target' : '';
  console.log(`  ${String(r.n).padStart(6)}  ${r.rule.padEnd(22)} sev ${r.lo}-${r.hi}${mark}`);
}

const target = before.find((r) => r.rule === rule);
if (!target) {
  console.log(`\nnothing to do: no detections with rule "${rule}"`);
  await pool.end();
  process.exit(0);
}

if (dryRun) {
  console.log(`\n--dry-run: would delete ${target.n} "${rule}" detections. Nothing changed.`);
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Incidents that would be left citing deleted members.
  const { rows: orphaned } = await client.query(
    `SELECT DISTINCT incident_id FROM detection
      WHERE rule = $1 AND incident_id IS NOT NULL`,
    [rule],
  );

  const del = await client.query(`DELETE FROM detection WHERE rule = $1`, [rule]);

  let incidentsRemoved = 0;
  if (orphaned.length) {
    const ids = orphaned.map((r) => r.incident_id);
    // An incident whose remaining membership is under two is no longer a
    // confluence of anything. CONFLUENCE will rebuild it if it still holds.
    const inc = await client.query(
      `DELETE FROM incident i
        WHERE i.id = ANY($1::bigint[])
          AND (SELECT count(*) FROM detection d WHERE d.incident_id = i.id) < 2`,
      [ids],
    );
    incidentsRemoved = inc.rowCount ?? 0;
  }

  await client.query('COMMIT');
  console.log(
    `\ndeleted ${del.rowCount} "${rule}" detections, removed ${incidentsRemoved} now-empty incidents.`,
  );
  console.log('observations untouched -- the corrected rule will re-derive from the archive.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nrolled back:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
