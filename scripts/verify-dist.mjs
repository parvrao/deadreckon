#!/usr/bin/env node
/**
 * DEADRECKON :: post-build integrity check for apps/web/dist.
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Twice in one day the deployed console was completely dead because the
 * build emitted a file that referenced another file the build had not
 * emitted. Both times the build "succeeded", both times the build log
 * looked reasonable, and both times the browser reported it as a MIME
 * type problem, which points at the web server rather than at the bundle:
 *
 *   1. MapLibre locates its worker by concatenating against
 *      import.meta.url. Vite cannot see that, so no worker was emitted.
 *      The browser asked for /assets/maplibre-gl-worker.mjs, the SPA
 *      rewrite answered with index.html, and the module was rejected:
 *        Failed to load module script: non-JavaScript MIME type "text/html"
 *
 *   2. The fix imported the worker with `?url`, which copies a file
 *      verbatim WITHOUT following its imports. The 18 KB worker was
 *      emitted; the 489 KB `./maplibre-gl-shared.mjs` it imports was not.
 *      Same failure one level deeper:
 *        Failed to load module script: non-JavaScript MIME type of ""
 *
 * In both cases the app never executed at all, so every unrelated fix
 * made in the same window appeared to do nothing. That is the expensive
 * part: not the bug, but the days of misattributed debugging downstream
 * of it.
 *
 * A dangling asset reference is trivially detectable from dist alone.
 * This check does that and fails the build, so the failure is named at
 * build time by the thing that caused it, instead of at runtime by the
 * web server that merely reported it.
 * ---------------------------------------------------------------------
 *
 * Checks:
 *   1. every /assets/<file> and relative ./<file>.(m)js referenced from an
 *      emitted script or from index.html actually exists in dist
 *   2. the MapLibre worker chunk is large enough to be self-contained,
 *      which is what distinguishes a bundled worker from a copied stub
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'apps/web/dist');

/** Assets that are legitimately fetched at runtime, not bundled. */
const SCRIPT_EXT = /\.(m?js|css|wasm|json)$/;

/**
 * A bundled MapLibre worker carries the shared module with it. The stub
 * that broke production was 18,592 bytes, so anything in that region is
 * the bug rather than a small legitimate worker.
 */
const WORKER_MIN_BYTES = 150_000;

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
const notes = [];

let files;
try {
  files = await walk(DIST);
} catch {
  console.error(`verify-dist: no build output at ${DIST}`);
  process.exit(1);
}

const present = new Set(files.map((f) => f.slice(DIST.length + 1)));

/* ------------------------------------------- 1. dangling asset refs */

// Absolute references the browser resolves against the site root.
const ABS = /["'`(](\/assets\/[A-Za-z0-9._-]+\.(?:m?js|css|wasm))["'`)]/g;
// Relative module specifiers, which is how the copied worker stub failed.
const REL = /(?:from\s*|import\s*\(\s*)["'](\.\/[A-Za-z0-9._-]+\.m?js)["']/g;

for (const f of files) {
  const rel = f.slice(DIST.length + 1);
  if (!/\.(m?js|html)$/.test(rel)) continue;

  const text = await readFile(f, 'utf8');

  for (const m of text.matchAll(ABS)) {
    const target = m[1].replace(/^\//, '');
    if (!present.has(target)) {
      problems.push(
        `${rel} references ${m[1]} which was not emitted.\n` +
          `      The server will answer that request with the SPA fallback ` +
          `or a bare 404, and the browser will reject it as a module script.`,
      );
    }
  }

  for (const m of text.matchAll(REL)) {
    const target = join(dirname(rel), m[1]);
    if (!present.has(target)) {
      problems.push(
        `${rel} imports ${m[1]} which was not emitted.\n` +
          `      This is the signature of a module copied with ?url instead ` +
          `of bundled. Use ?worker&url for worker entry points.`,
      );
    }
  }
}

/* --------------------------------------- 2. worker is self-contained */

const workers = files.filter((f) => /maplibre-gl-worker/.test(basename(f)));

if (!workers.length) {
  problems.push(
    `no maplibre-gl-worker chunk in dist.\n` +
      `      MapLibre will request /assets/maplibre-gl-worker.mjs at runtime ` +
      `and the map will not initialise. wall.ts must import it with ` +
      `?worker&url so Vite emits it.`,
  );
} else {
  for (const w of workers) {
    const { size } = await stat(w);
    const rel = w.slice(DIST.length + 1);
    if (size < WORKER_MIN_BYTES) {
      problems.push(
        `${rel} is only ${size} bytes.\n` +
          `      That is the un-bundled stub, not a self-contained worker: ` +
          `it imports maplibre-gl-shared.mjs, which is not emitted ` +
          `alongside it. Import with ?worker&url, not ?url.`,
      );
    } else {
      notes.push(`worker ${rel} is ${(size / 1024).toFixed(0)} KB, bundled`);
    }
  }
}

/* ------------------------------------------------------------ report */

for (const n of notes) console.log(`verify-dist: ok -- ${n}`);

if (problems.length) {
  console.error(`\nverify-dist: ${problems.length} problem(s) in ${DIST}\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    `These would ship as a blank page with a misleading MIME type error.\n`,
  );
  process.exit(1);
}

console.log(
  `verify-dist: ${present.size} files, no dangling asset references.`,
);
