import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the deploy kit's static-analysis tests (the compose-
 * invariants suite + the backup/restore script-safety checks). These run under
 * Node with no DB, no Docker, and no external accounts — they parse the shipped
 * YAML/shell/Dockerfiles as text and assert the deploy contract holds.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // The deploy kit is standalone; keep vitest from walking up into the app tree.
    root: import.meta.dirname,
  },
});
