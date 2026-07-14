/**
 * Smart View DSL (CONTRACTS §C3) — the single query authority.
 *
 * Task 0c seeds the module boundary only. The lexer, parser, zod-typed AST and
 * SQL compiler (`parse`, `compile`, `astToDsl`) are implemented in Phase 1 and
 * MUST emit parameterized SQL with keyset pagination. Nothing here implements
 * the grammar yet.
 */

export const DSL_GRAMMAR_VERSION = '1.0.0';
