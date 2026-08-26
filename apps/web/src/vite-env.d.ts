/// <reference types="vite/client" />

/**
 * `?url` imports resolve to the emitted asset path at build time.
 *
 * Kept because it is a generally useful escape hatch, but note that it
 * copies a file VERBATIM without following its imports. Do not use it for
 * anything that is itself a module with dependencies -- see below.
 */
declare module '*?url' {
  const url: string;
  export default url;
}

/**
 * `?worker&url` bundles the target as a worker entry point, following its
 * dependency graph, and resolves to the emitted chunk's path.
 *
 * Needed for maplibre-gl's worker: MapLibre locates it by concatenating
 * against import.meta.url, which no bundler can statically follow, so the
 * file has to be pulled in explicitly and handed to setWorkerUrl().
 *
 * It must be `?worker&url` rather than `?url`. The worker module is 18 KB
 * of glue that imports a 489 KB sibling; copied verbatim it boots and then
 * 404s on that sibling. See the long comment in wall.ts.
 */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
