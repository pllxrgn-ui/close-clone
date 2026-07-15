-- Migration 0011 (Task 5b): make `audit_log` append-only at the database level.
--
-- The AuditWriter service exposes only INSERTs (no update/delete surface), but the
-- database is the last line of defense (CONTRACTS §C1: "audit_log append-only").
-- A BEFORE trigger raises on any UPDATE, DELETE, or TRUNCATE so no path — service
-- bug, REST/API bypass, psql, a future migration, or a raw admin connection — can
-- ever mutate or erase an audit row. INSERT is unaffected, so the writer works
-- normally. The append-only spine of the compliance story (auth events, admin
-- changes, compliance-switch flips, exports, hard-deletes) is therefore tamper-
-- evident by construction.
CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
