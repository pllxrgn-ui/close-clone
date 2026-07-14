CREATE INDEX "activities_lead_type_occurred_idx" ON "activities" USING btree ("lead_id","type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_threads_triage_idx" ON "email_threads" USING btree ("triage_status","lead_id") WHERE "email_threads"."triage_status" = 'ambiguous';--> statement-breakpoint
CREATE INDEX "leads_last_contacted_at_idx" ON "leads" USING btree ("last_contacted_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_last_inbound_at_idx" ON "leads" USING btree ("last_inbound_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_next_task_due_at_idx" ON "leads" USING btree ("next_task_due_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_last_call_at_idx" ON "leads" USING btree ("last_call_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_last_email_at_idx" ON "leads" USING btree ("last_email_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_last_sms_at_idx" ON "leads" USING btree ("last_sms_at") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "leads_custom_gin_idx" ON "leads" USING gin ("custom" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "leads_search_tsv_gin_idx" ON "leads" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "send_intents_state_due_idx" ON "send_intents" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "suppressions_active_lookup_idx" ON "suppressions" USING btree ("kind","value") WHERE "suppressions"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_open_due_idx" ON "tasks" USING btree ("assignee_id","due_at") WHERE "tasks"."completed_at" IS NULL;