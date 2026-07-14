-- Bootstrap migration (Task 1a): enable extensions the schema depends on.
-- Runs first (journal idx 0) so `citext` columns exist before the generated
-- schema migration creates tables.
--   citext → case-insensitive text (users.email, email_accounts.address,
--            suppressions.value). PGlite registers it via the constructor
--            `extensions` option (see src/db/test-helpers.ts); real Postgres
--            ships it in contrib.
-- Note: uuid PK defaults use core `gen_random_uuid()` (Postgres 13+), so no
-- pgcrypto/uuid-ossp extension is required.
CREATE EXTENSION IF NOT EXISTS citext;
