/**
 * DEADRECKON :: migrate.
 *
 * Idempotent. Runs on every deploy as part of the build command. The whole
 * schema is CREATE TABLE IF NOT EXISTS, so there is no migration ledger to
 * drift out of sync -- deliberate, for a system whose schema is small and
 * whose data is reconstructible.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES } from '@deadreckon/core';
import { getPool, closePool } from './pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chokepoints and corridors where a dark target actually means something. */
const WATCHBOXES = [
  ['hormuz', 'Strait of Hormuz', 25.2, 54.2, 27.4, 57.6, 1800],
  ['malacca', 'Strait of Malacca', -0.5, 98.0, 6.5, 105.0, 2700],
  ['bab_el_mandeb', 'Bab-el-Mandeb / S. Red Sea', 11.0, 41.0, 16.5, 45.0, 1800],
  ['suez', 'Suez Canal approaches', 27.0, 32.0, 32.5, 34.5, 1800],
  ['bosphorus', 'Bosphorus / Sea of Marmara', 40.2, 26.5, 41.6, 30.2, 1800],
  ['panama', 'Panama Canal approaches', 7.5, -80.5, 10.5, -78.0, 2700],
  ['taiwan_strait', 'Taiwan Strait', 22.0, 117.0, 26.5, 122.5, 1800],
  ['kerch', 'Kerch Strait / N. Black Sea', 44.0, 33.0, 47.0, 39.5, 1800],
  ['gulf_of_guinea', 'Gulf of Guinea', -2.0, 2.0, 7.0, 9.5, 3600],
  ['baltic_approaches', 'Danish Straits / Baltic', 54.0, 10.0, 60.0, 22.0, 2700],
] as const;

export async function migrate(): Promise<void> {
  const pool = getPool({ label: 'migrate', max: 2 });
  const sql = readFileSync(join(HERE, 'schema.sql'), 'utf8');

  console.log('[migrate] applying schema...');
  await pool.query(sql);

  console.log('[migrate] seeding sources...');
  for (const s of SOURCES) {
    await pool.query(
      `INSERT INTO source (id, key, domain, label, license, homepage)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         key = EXCLUDED.key, label = EXCLUDED.label,
         license = EXCLUDED.license, homepage = EXCLUDED.homepage`,
      [s.id, s.key, s.domain, s.label, s.license, s.homepage],
    );
  }

  console.log('[migrate] seeding watchboxes...');
  for (const [key, label, minLat, minLon, maxLat, maxLon, darkS] of WATCHBOXES) {
    await pool.query(
      `INSERT INTO watchbox
         (key, label, min_lat, min_lon, max_lat, max_lon, dark_threshold_s)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (key) DO UPDATE SET
         label = EXCLUDED.label,
         min_lat = EXCLUDED.min_lat, min_lon = EXCLUDED.min_lon,
         max_lat = EXCLUDED.max_lat, max_lon = EXCLUDED.max_lon,
         dark_threshold_s = EXCLUDED.dark_threshold_s`,
      [key, label, minLat, minLon, maxLat, maxLon, darkS],
    );
  }

  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM source)   AS sources,
       (SELECT count(*) FROM watchbox) AS watchboxes`,
  );
  console.log('[migrate] done:', rows[0]);
}

// Executed directly by `npm run migrate` in the Render build command.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] FAILED:', err);
      process.exit(1);
    });
}
