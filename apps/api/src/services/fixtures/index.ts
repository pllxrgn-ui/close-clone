/**
 * Fixture loader (Task 1a). Bulk-loads the golden/latency datasets from
 * `fixtures/out` into a Drizzle db. Seed utility (out-of-band), not an
 * application write path.
 */
export {
  fixturesPresent,
  loadGoldenFixtures,
  loadLatencyFixtures,
  type LatencyLoadOptions,
  type LoadedCounts,
  type LoadOptions,
} from './loader.ts';
