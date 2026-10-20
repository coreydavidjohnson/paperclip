SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE heartbeat_runs
 ADD COLUMN context_issue_id text GENERATED ALWAYS AS (context_snapshot ->> 'issueId') STORED,
 ADD COLUMN context_task_id text GENERATED ALWAYS AS (context_snapshot ->> 'taskId') STORED;
