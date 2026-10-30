WITH batch AS MATERIALIZED (
  SELECT id FROM heartbeat_runs
  WHERE nullif(:'cursor', '')::uuid IS NULL OR id > nullif(:'cursor', '')::uuid
  ORDER BY id LIMIT 100
), missing AS MATERIALIZED (
  SELECT h.id, h.company_id, h.context_snapshot
  FROM batch b JOIN heartbeat_runs h ON h.id = b.id
  WHERE NOT EXISTS (SELECT 1 FROM heartbeat_run_list_context c WHERE c.run_id = h.id)
), copied AS (
  INSERT INTO heartbeat_run_list_context (run_id, company_id, context)
  SELECT id, company_id, public.project_heartbeat_run_list_context(context_snapshot) FROM missing
  ON CONFLICT (run_id) DO NOTHING
  RETURNING run_id
)
SELECT coalesce((SELECT id::text FROM batch ORDER BY id DESC LIMIT 1), '');
