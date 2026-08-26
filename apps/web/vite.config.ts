import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,

    // NO manualChunks. This is deliberate, and it cost most of an evening.
    //
    // There used to be a manualChunks map pinning maplibre-gl, deck.gl and
    // satellite.js into named chunks, on the reasonable theory that a UI
    // tweak should not invalidate 900 KB of vendor cache.
    //
    // MapLibre 6 loads its web worker as a SEPARATE module file, resolved
    // at runtime relative to its own bundle:
    //
    //   /assets/maplibre-gl-worker.mjs
    //
    // Forcing maplibre-gl into a manual chunk broke Rollup's ability to
    // emit that worker as its own addressable asset. The file was simply
    // never written to dist/. The browser requested it, Render's SPA
    // rewrite answered the 404 with index.html, and the browser refused
    // the HTML as a module script:
    //
    //   Failed to load module script: non-JavaScript MIME type "text/html"
    //
    // The map then never initialised. Worse, the failure looked like a
    // caching problem rather than a build problem, so several unrelated
    // fixes appeared to change nothing because the app was not running at
    // all.
    //
    // Rollup's automatic chunking already splits vendor code sensibly and,
    // critically, keeps the worker emit intact. A slightly worse cache
    // profile is not worth a build that silently omits a required file.
    rollupOptions: {},
  },

  // Emit workers as ES modules, matching how maplibre-gl requests them.
  worker: { format: 'es' },

  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/stream': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
