ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "external_run_handle" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_alive_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "unknown_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "observer_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_probe" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_liveness_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid REFERENCES "companies"("id"),
  "run_id" uuid,
  "action" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "done_at" timestamp with time zone,
  CONSTRAINT "run_liveness_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_liveness_outbox_pending_idx" ON "run_liveness_outbox" USING btree ("next_attempt_at") WHERE "run_liveness_outbox"."status" = 'pending';--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_run_liveness_stop_on_end() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- PER-966 10.2: a failed, cancelled, timed-out, gone or past-deadline ending stops the provider
  -- session in the same transaction as the terminal status. Success keeps the session; an unknown
  -- ending is owned by its reconcile hold and is never stopped.
  IF NEW.status IN ('failed', 'cancelled', 'timed_out') AND OLD.status IN ('queued', 'running')
     AND NEW.external_run_handle IS NOT NULL
     AND coalesce(NEW.error_code, '') <> 'external_liveness_unknown' THEN
    INSERT INTO run_liveness_outbox(company_id, run_id, action, dedupe_key, payload)
      VALUES (NEW.company_id, NEW.id, 'stop_provider_session', 'stop:' || NEW.id::text,
        jsonb_build_object('status', NEW.status, 'errorCode', NEW.error_code))
      ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_liveness_stop_on_end" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_liveness_stop_on_end" AFTER UPDATE OF "status" ON "heartbeat_runs"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION paperclip_run_liveness_stop_on_end();
