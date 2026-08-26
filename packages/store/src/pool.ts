import pg from 'pg';

const { Pool, types } = pg;

/**
 * Postgres returns bigint as a string to avoid silent precision loss.
 * Our ids will not exceed 2^53 in this decade, and every call site wants
 * a number, so parse them once here rather than in forty places.
 */
types.setTypeParser(20, (v: string) => Number(v));
/** timestamptz -> epoch ms. Date objects are pure overhead on this path. */
types.setTypeParser(1184, (v: string) => new Date(v).getTime());
types.setTypeParser(1114, (v: string) => new Date(v + 'Z').getTime());

let pool: pg.Pool | null = null;

export interface PoolOpts {
  /** Keep this small. Free-tier Postgres connection limits are the
   *  first wall you hit, long before CPU. */
  max?: number;
  label?: string;
}

export function getPool(opts: PoolOpts = {}): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Point it at Render Postgres, Neon, or a ' +
        'local instance: postgres://user:pass@host:5432/deadreckon',
    );
  }

  const needsSsl =
    /\bsslmode=require\b/.test(connectionString) ||
    /render\.com|neon\.tech|supabase\.co|railway/.test(connectionString);

  pool = new Pool({
    connectionString,
    max: opts.max ?? 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed Postgres providers terminate long-idle sockets; without this
    // the first query after a quiet spell fails with ECONNRESET.
    keepAlive: true,
    application_name: `deadreckon-${opts.label ?? 'app'}`,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // An unhandled 'error' on an idle client crashes the process. It is not
  // an application error -- it is the provider recycling a socket.
  pool.on('error', (err) => {
    console.error('[pg] idle client error (recoverable):', err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Errors worth retrying rather than surfacing. */
const TRANSIENT = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isTransient(err: unknown): boolean {
  const e = err as { code?: string };
  return !!e?.code && TRANSIENT.has(e.code);
}

/**
 * Retry with full jitter. Not decorative: managed Postgres restarts for
 * maintenance, and a worker that dies on a 3-second blip loses the very
 * window it exists to capture.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  baseMs = 250,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const cap = baseMs * Math.pow(2, i);
      await sleep(Math.random() * cap);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
