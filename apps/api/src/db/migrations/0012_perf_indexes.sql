CREATE INDEX "opportunities_lead_id_idx" ON "opportunities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "notes_lead_id_idx" ON "notes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "email_threads_lead_id_idx" ON "email_threads" USING btree ("lead_id") WHERE "email_threads"."lead_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_messages_thread_dir_sent_idx" ON "email_messages" USING btree ("thread_id","direction","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_created_id_live_idx" ON "leads" USING btree ("created_at" DESC NULLS LAST,"id" DESC) WHERE "leads"."deleted_at" IS NULL;
