import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // deck.gl and maplibre are large and change rarely. Splitting them
        // means a UI tweak does not invalidate 900 KB of vendor cache.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          deck: ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox'],
          orbit: ['satellite.js'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/stream': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
