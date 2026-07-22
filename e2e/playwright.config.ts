import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/*
 * Playwright E2E for Switchboard (build guide task 5d).
 *
 * Drives the REAL web app (apps/web) in MOCK mode — MSW + synthetic fixtures,
 * zero external accounts. The app is served as a production build via
 * `vite preview` on a fixed port; in mock mode the build ships the MSW service
 * worker (apps/web/public/mockServiceWorker.js) so the static bundle answers the
 * whole REST surface from fixtures with no backend.
 *
 * This package lives OUTSIDE the pnpm workspace (like deploy/); the web app is
 * still a workspace member, so we build/serve it via `pnpm --filter` from the
 * repo root regardless of this config's location.
 */

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '..');
const STORAGE_STATE = resolve(configDir, '.auth', 'user.json');

const PORT = Number(process.env.E2E_PORT ?? '4173');
const HOST = '127.0.0.1';
const baseURL = `http://${HOST}:${PORT}`;
const isCI = !!process.env.CI;

// In CI the dist is prebuilt by the workflow step, so we only preview. Locally
// we build-then-preview so a single `pnpm test` works from a clean checkout;
// `reuseExistingServer` skips both when a preview is already up on the port.
const previewCmd = `pnpm --filter @switchboard/web exec vite preview --port ${PORT} --strictPort --host ${HOST}`;
const webServerCommand = isCI
  ? previewCmd
  : `pnpm --filter @switchboard/web run build && ${previewCmd}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Serialize in CI (single preview server, cleaner traces); auto-detect locally.
  ...(isCI ? { workers: 1 } : {}),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: isCI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Logs in once through the dev-login UI and saves the authenticated
    // localStorage as storageState for the authed specs to reuse.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
      // The full rep loop starts logged-out on /welcome; it opts out of the
      // shared storageState per-file. Everything else starts authenticated.
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: {
    command: webServerCommand,
    cwd: repoRoot,
    url: baseURL,
    env: { VITE_API_MODE: 'mock' },
    // Never attach the suite to an arbitrary process that happens to own the
    // port. A collision should fail clearly; E2E_PORT selects another port.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
