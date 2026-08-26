/// <reference types="vite/client" />

/**
 * `?url` imports resolve to the emitted asset path at build time.
 *
 * Needed for maplibre-gl's worker: MapLibre locates it by concatenating
 * against import.meta.url, which no bundler can statically follow, so the
 * file has to be pulled in explicitly and handed to setWorkerUrl().
 */
declare module '*?url' {
  const url: string;
  export default url;
}
