#!/usr/bin/env node
// Perf gate entrypoint (Task 1c). Runs the latency harness
// (apps/api/src/perf/run.ts) against real Postgres when DATABASE_URL is set
// (authoritative; fails the build when any core p95 > 150ms) or in-process
// PGlite otherwise (non-authoritative smoke check, per DECISIONS D-003).
//
// The runner is launched with --experimental-transform-types because the shared
// Smart View compiler uses a TS parameter property (non-erasable syntax), so
// plain strip-only type stripping cannot load its module graph.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '../apps/api/src/perf/run.ts');

const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', runner], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
