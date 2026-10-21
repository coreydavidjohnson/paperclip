import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// Use the existing context/activity indexes before fetching the run projection.
// IN preserves OR membership without duplicates or a correlated company scan.
export function issueRunIdsCondition(companyId: string, issueId: string) {
  return sql`${heartbeatRuns.id} in (
    select id from heartbeat_runs
    where company_id = ${companyId} and context_snapshot ->> 'issueId' = ${issueId}
    union
    select run_id from activity_log
    where company_id = ${companyId} and entity_type = 'issue'
      and entity_id = ${issueId} and run_id is not null
  )`;
}

// The trigger-maintained sidecar avoids reading retained prompt/transcript blobs.
// During the bounded historical backfill, absent rows retain exact old behavior.
export const compactRunContext = sql`coalesce(
  (select c.context from heartbeat_run_list_context c
    where c.run_id = ${heartbeatRuns.id} and c.company_id = ${heartbeatRuns.companyId}),
  case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
    then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end
)`;

// Keep the text coercion and null behavior of the original list projection.

// Non-object JSON previously produced null fields; retain that behavior.
export const runListContextJoin = sql`lateral jsonb_to_record(
  ${compactRunContext}
) as run_list_context(
  "issueId" text, "taskId" text, "taskKey" text, "commentId" text,
  "wakeCommentId" text, "wakeReason" text, "wakeSource" text, "wakeTriggerDetail" text
)`;
export const runListContextColumns = {
  contextIssueId: sql<string | null>`run_list_context."issueId"`.as("contextIssueId"),
  contextTaskId: sql<string | null>`run_list_context."taskId"`.as("contextTaskId"),
  contextTaskKey: sql<string | null>`run_list_context."taskKey"`.as("contextTaskKey"),
  contextCommentId: sql<string | null>`run_list_context."commentId"`.as("contextCommentId"),
  contextWakeCommentId: sql<string | null>`run_list_context."wakeCommentId"`.as("contextWakeCommentId"),
  contextWakeReason: sql<string | null>`run_list_context."wakeReason"`.as("contextWakeReason"),
  contextWakeSource: sql<string | null>`run_list_context."wakeSource"`.as("contextWakeSource"),
  contextWakeTriggerDetail: sql<string | null>`run_list_context."wakeTriggerDetail"`.as("contextWakeTriggerDetail"),
} as const;
