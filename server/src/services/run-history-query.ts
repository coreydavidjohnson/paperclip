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

// One detoast/extraction pass instead of eight independent ->> projections.
// Non-object JSON previously produced null fields; retain that behavior.
export const runListContextJoin = sql`lateral jsonb_to_record(
  case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
    then ${heartbeatRuns.contextSnapshot} end
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

// Preserve driver JSON/text values; do not tighten record fields to UUIDs.
// JSON null and SQL NULL both deserialize to JS null; no SQL consumes these fields.
export const issueRunContextJoin = sql`lateral jsonb_to_record(
  case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
    then ${heartbeatRuns.contextSnapshot} end
) as issue_run_context(
  "wakeCommentIds" jsonb, "wakeCommentId" text, "commentId" text, "issueId" text
)`;
export const issueRunContextColumns = {
  wakeCommentIds: sql<string[] | null>`issue_run_context."wakeCommentIds"`,
  wakeCommentId: sql<string | null>`issue_run_context."wakeCommentId"`,
  contextCommentId: sql<string | null>`issue_run_context."commentId"`,
  contextIssueId: sql<string | null>`issue_run_context."issueId"`,
} as const;
