import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// Retain JSON types, three-key/null shape and non-object rows; decode once.
// Explicit JSON null and missing keys coincide only after jsonb_build_object.
export const executionRunContextJoin = sql`lateral jsonb_to_record(
  case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
    then ${heartbeatRuns.contextSnapshot} end
) as execution_run_context(
  "issueId" jsonb, "failureRetriesBeforeAiConnectionWait" jsonb,
  "failureRetriesBeforeWorkspaceWait" jsonb
)`;
export const executionRunContextColumn = sql<Record<string, unknown>>`jsonb_build_object(
  'issueId', execution_run_context."issueId",
  'failureRetriesBeforeAiConnectionWait', execution_run_context."failureRetriesBeforeAiConnectionWait",
  'failureRetriesBeforeWorkspaceWait', execution_run_context."failureRetriesBeforeWorkspaceWait"
)`;
