-- Global search (Task 1e): pg_trgm powers the gin_trgm_ops indexes below and the
-- similarity()/word_similarity() ranking in SearchService. Hand-added before the
-- drizzle-generated DDL (drizzle-kit does not emit CREATE EXTENSION); PGlite ships
-- pg_trgm as a contrib extension registered in the PGlite constructor (see
-- src/db/test-helpers.ts, mirroring the citext bootstrap in 0000).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(title, '') || ' ' || translate(coalesce(jsonb_path_query_array(emails, '$[*].email')::text, ''), '[]",', '    ') || ' ' || translate(coalesce(jsonb_path_query_array(phones, '$[*].phone')::text, ''), '[]",', '    '))) STORED;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "search_text" text GENERATED ALWAYS AS (lower(coalesce(name, '') || ' ' || coalesce(title, '') || ' ' || translate(coalesce(jsonb_path_query_array(emails, '$[*].email')::text, ''), '[]",', '    ') || ' ' || translate(coalesce(jsonb_path_query_array(phones, '$[*].phone')::text, ''), '[]",', '    '))) STORED;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "search_text" text GENERATED ALWAYS AS (lower(coalesce(name, '') || ' ' || coalesce(url, '') || ' ' || coalesce(description, ''))) STORED;--> statement-breakpoint
CREATE INDEX "contacts_search_tsv_gin_idx" ON "contacts" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_search_text_trgm_idx" ON "contacts" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "leads_name_trgm_idx" ON "leads" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "leads_search_text_trgm_idx" ON "leads" USING gin ("search_text" gin_trgm_ops);