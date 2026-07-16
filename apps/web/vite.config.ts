/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Subpath deploys (GitHub Pages serves at /<repo>/): set VITE_BASE='/close-clone/'.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    // Real-API mode (VITE_API_MODE=real): the PGlite dev server owns /api + /healthz.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    // Route-level code splitting relies on dynamic import(); keep chunks lean.
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
