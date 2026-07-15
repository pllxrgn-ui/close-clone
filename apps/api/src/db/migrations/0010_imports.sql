-- Imports table (Task 4f / CONTRACTS §C1 v1.1.0, DECISIONS D-018).
--
-- Hand-authored and numbered 0010 (not the next sequential 0004) so the parallel
-- Phase-2/backfill streams (admin-ops, reporting, telephony, csv-import) can each
-- own a disjoint migration number and merge without renumbering — see D-008
-- (migrations serialized to keep numbering linear) / D-016 (isolated worktrees).
-- The DDL mirrors drizzle-kit's output for the `imports` table in
-- src/db/schema.ts (verified column-by-column against the schema definition).
--
-- Applied at runtime by the journal-driven migrator (drizzle-orm/pglite/migrator
-- in tests, drizzle-orm/node-postgres in the latency gate / CI). A drizzle-kit
-- `generate` snapshot for this migration is intentionally deferred to the
-- orchestrator's merge-time migration reconciliation (the snapshot chain is
-- rebuilt once all parallel migrations are linearized).
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_ref" text NOT NULL,
	"row_count" integer,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"mapping" jsonb,
	"dedupe_config" jsonb,
	"dry_run_result" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imports_created_by_idx" ON "imports" USING btree ("created_by");
