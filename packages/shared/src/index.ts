/**
 * @switchboard/shared — the contract package.
 *
 * All domain types live here as zod schemas with inferred TS types (CONTRACTS §intro).
 * Task 0c seeds only the layout (providers, events, dsl) with minimal exports;
 * the Smart View DSL and provider adapters are implemented in later phases.
 */

export const VERSION = '0.0.0';

export * from './domain.ts';
export * from './events.ts';
export * from './providers.ts';
export * from './dsl/index.ts';
