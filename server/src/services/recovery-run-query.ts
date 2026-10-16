import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// Keep JSON types; one detoast/extraction pass leaves prompts/history in DB.
export const recoveryRunContext = sql<Record<string, unknown> | null>`(
  select to_jsonb(context) from jsonb_to_record(
    case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} end
  ) as context(
    "issueId" jsonb, "taskId" jsonb, "retryReason" jsonb, "source" jsonb,
    "wakeReason" jsonb, "handoffReason" jsonb, "handoffRequired" jsonb,
    "handoffAttempt" jsonb, "maxHandoffAttempts" jsonb, "sourceRunId" jsonb,
    "resumeFromRunId" jsonb, "missingDisposition" jsonb,
    "providerQuotaRetryNotBefore" jsonb, "transientRetryNotBefore" jsonb,
    "dispositionRepairAttempt" jsonb, "dispositionRepairFingerprint" jsonb,
    "legacyDispositionEpisode" jsonb, "livenessContinuationAttempt" jsonb,
    "livenessContinuationSourceRunId" jsonb, "externalChatContinuation" jsonb,
    "paperclipWake" jsonb, "wakeCommentId" jsonb, "wakeCommentIds" jsonb,
    "paperclipWorkspace" jsonb, "reviewPathRecoveryAttempt" jsonb
  )
)`;

// Preserve the entire-snapshot race check without transporting the snapshot.
export const recoveryRunContextFingerprint = sql<string | null>`
  encode(sha256(convert_to(${heartbeatRuns.contextSnapshot}::text, 'UTF8')), 'hex')`;

export const recoveryRunSelect = {
  id: heartbeatRuns.id,
  agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status,
  error: heartbeatRuns.error,
  errorCode: heartbeatRuns.errorCode,
  contextSnapshot: recoveryRunContext,
  contextSnapshotFingerprint: recoveryRunContextFingerprint,
  livenessState: heartbeatRuns.livenessState,
  // Failure classification searches provider JSON and merges back into it.
  // Preserve full results for that path; successful run output stays in DB.
  resultJson: sql<unknown>`case when ${heartbeatRuns.errorCode} in
    ('adapter_failed', 'provider_quota', 'configuration_incomplete')
    then ${heartbeatRuns.resultJson}
    else (select to_jsonb(result) from jsonb_to_record(
      case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object'
        then ${heartbeatRuns.resultJson} end
    ) as result("errorFamily" jsonb, "workspaceValidation" jsonb,
      "configurationIncomplete" jsonb, "cancelledByActorType" jsonb,
      "finalizationReasonCode" jsonb, "providerQuotaRetryNotBefore" jsonb,
      "retryNotBefore" jsonb, "transientRetryNotBefore" jsonb)) end`,
  startedAt: heartbeatRuns.startedAt,
  createdAt: heartbeatRuns.createdAt,
} as const;

export const retryAccountingRunSelect = {
  responsibleUserId: heartbeatRuns.responsibleUserId,
  scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
  contextSnapshot: sql<Record<string, unknown> | null>`(
    select to_jsonb(context) from jsonb_to_record(
      case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
        then ${heartbeatRuns.contextSnapshot} end
    ) as context("executionRetryAccounting" jsonb,
      "failureRetriesBeforeAiConnectionWait" jsonb,
      "failureRetriesBeforeWorkspaceWait" jsonb)
  )`,
} as const;
