#!/usr/bin/env node
// Perf gate stub. The authoritative latency suite (Smart View p95 @ 100k leads)
// lands in Task 1c and runs against real Postgres in CI. Until then this is a
// no-op so the `perf` script and the CI perf job are wired end to end.
console.log('[perf] stub — no latency gate yet (arrives in Task 1c on real Postgres). OK.');
process.exit(0);
