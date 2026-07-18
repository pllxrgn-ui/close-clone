/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Subpath deploys (GitHub Pages serves at /<repo>/): set VITE_BASE='/close-clone/'.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    // Allow Cloudflare quick-tunnel hosts so the dev server can be shared over a
    // tunnel for a live demo (Vite blocks unknown Host headers by default). Scoped
    // to *.trycloudflare.com — not a blanket allow.
    allowedHosts: ['.trycloudflare.com'],
    // Real-API mode (VITE_API_MODE=real): the PGlite dev server owns /api + /healthz.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    // Route-level code splitting relies on dynamic import(); keep chunks lean.
    target: 'es2022',
    rollupOptions: {
      output: {
        // Split the stable framework layer out of the entry so app-code churn
        // never invalidates the (large, rarely-changing) vendor cache entries.
        // Function form: the object form misses pnpm's nested .pnpm paths
        // (react-dom stayed in the entry chunk).
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          // ONE react chunk: react-router-dom imports react-dom imports react —
          // splitting them creates a chunk cycle that breaks module init on the
          // entry route (found by the E2E welcome-boot check).
          if (
            /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)
          ) {
            return 'react';
          }
          if (/node_modules\/@tanstack\//.test(id)) return 'query';
          if (/node_modules\/zod\//.test(id)) return 'zod';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
