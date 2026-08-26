/**
 * DEADRECKON :: upstream HTTP.
 *
 * Every OSINT feed we touch is somebody else's free service. Hammering
 * them is both rude and self-defeating: the fastest way to lose a data
 * source is to get banned from it. So everything upstream goes through
 * here, and here enforces the manners.
 *
 *   - a hard per-source token bucket, independent of poll cadence
 *   - exponential backoff with full jitter on 429 / 5xx
 *   - Retry-After is obeyed when present
 *   - a real timeout via AbortSignal, because a hung socket is worse
 *     than an error (it silently stops the whole poll loop)
 *   - the raw payload is returned alongside the parse so provenance
 *     hashes what actually arrived, not what we think arrived
 */

export const USER_AGENT =
  'deadreckon/0.1 (open-source spatial intelligence; +https://github.com/)';

export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  /** Resolves when a token is available. Never rejects. */
  async take(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      await sleep(Math.ceil((deficit / this.refillPerSec) * 1000) + 25);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  ms: number;
  error?: string;
}

export interface FetchOpts {
  timeoutMs?: number;
  attempts?: number;
  headers?: Record<string, string>;
  bucket?: TokenBucket;
  /** Bail out of retries when the caller is shutting down. */
  signal?: AbortSignal;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let last: FetchResult = { ok: false, status: 0, body: '', url, ms: 0 };

  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) return { ...last, error: 'aborted' };
    if (opts.bucket) await opts.bucket.take();

    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json, text/plain, */*',
          'accept-encoding': 'gzip, deflate, br',
          ...opts.headers,
        },
      });
      const body = await res.text();
      last = { ok: res.ok, status: res.status, body, url, ms: Date.now() - started };

      if (res.ok) return last;

      // 4xx other than 408/429 will not fix themselves. Stop burning quota.
      if (res.status < 500 && res.status !== 429 && res.status !== 408) {
        last.error = `HTTP ${res.status}`;
        return last;
      }

      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : jitter(500 * Math.pow(2, i));
      last.error = `HTTP ${res.status}, retry in ${Math.round(waitMs)}ms`;
      if (i < attempts - 1) await sleep(waitMs);
    } catch (err) {
      const e = err as Error;
      last = {
        ok: false,
        status: 0,
        body: '',
        url,
        ms: Date.now() - started,
        error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message,
      };
      if (i < attempts - 1) await sleep(jitter(500 * Math.pow(2, i)));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  return last;
}

export function jitter(capMs: number): number {
  return Math.random() * capMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Never let one malformed upstream payload kill the poll loop. */
export function safeJson<T>(body: string, url: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    console.error(`[ingest] unparseable JSON from ${url}: ${(err as Error).message}`);
    return null;
  }
}
