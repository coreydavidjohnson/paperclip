-- Execute one transaction per call. The primary-key cursor never rescans rows
-- already visited. Concurrent source updates win through the trigger; a stale
-- backfill INSERT must not overwrite an existing projection.
WITH batch AS MATERIALIZED (
  SELECT id, company_id, context_snapshot FROM heartbeat_runs
  WHERE nullif(:'cursor', '')::uuid IS NULL OR id > nullif(:'cursor', '')::uuid
  ORDER BY id LIMIT 100
), copied AS (
  INSERT INTO heartbeat_run_list_context (run_id, company_id, context)
  SELECT id, company_id, public.project_heartbeat_run_list_context(context_snapshot) FROM batch
  ON CONFLICT (run_id) DO NOTHING
  RETURNING run_id
)
SELECT coalesce((SELECT id::text FROM batch ORDER BY id DESC LIMIT 1), '');
