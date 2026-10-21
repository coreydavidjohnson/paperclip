SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "heartbeat_run_list_context" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"context" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_list_context" ADD CONSTRAINT "heartbeat_run_list_context_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Schema/trigger only. Historical data is copied by a separate keyset-batched
-- PostSync job; never rewrite heartbeat_runs in a startup migration.
CREATE FUNCTION public.project_heartbeat_run_list_context(snapshot jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(snapshot) = 'object' THEN snapshot ELSE '{}'::jsonb END)
  WHERE key = ANY(ARRAY['issueId','taskId','taskKey','commentId','wakeCommentId',
    'wakeCommentIds','wakeReason','wakeSource','wakeTriggerDetail',
    'failureRetriesBeforeAiConnectionWait','failureRetriesBeforeWorkspaceWait']);
$$;
--> statement-breakpoint
CREATE FUNCTION public.sync_heartbeat_run_list_context()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.heartbeat_run_list_context (run_id, company_id, context)
  VALUES (NEW.id, NEW.company_id, public.project_heartbeat_run_list_context(NEW.context_snapshot))
  ON CONFLICT (run_id) DO UPDATE SET company_id = EXCLUDED.company_id, context = EXCLUDED.context
  WHERE heartbeat_run_list_context.company_id IS DISTINCT FROM EXCLUDED.company_id
     OR heartbeat_run_list_context.context IS DISTINCT FROM EXCLUDED.context;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_run_list_context_sync
AFTER INSERT OR UPDATE OF context_snapshot, company_id ON public.heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION public.sync_heartbeat_run_list_context();
