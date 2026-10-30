import { compactRunContext } from "./run-history-query.js";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

export function listAttentionExhaustedRuns(db: Db, companyId: string) {
  // Recovery can revisit an exhausted run. Deduplicate its historical events
  // before joining run data so duplicate events never multiply the wire payload.
  const latestExhaustion = db
    .selectDistinctOn([heartbeatRunEvents.runId], {
      runId: heartbeatRunEvents.runId,
      eventId: heartbeatRunEvents.id,
      message: heartbeatRunEvents.message,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.eventType, "lifecycle"),
      sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
    ))
    .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id))
    .as("latest_exhaustion");

  // Match the legacy raw-JSON candidate fallback, not newer-run text coercion.
  const issueKey = sql`(case when jsonb_typeof(case
    when ${compactRunContext} -> 'issueId' is null
      or ${compactRunContext} -> 'issueId' = 'null'::jsonb
    then ${compactRunContext} -> 'taskId'
    else ${compactRunContext} -> 'issueId' end) = 'string'
    then coalesce(${compactRunContext} ->> 'issueId',
        ${compactRunContext} ->> 'taskId', '')
    else '' end)`;

  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      // Preserve JSON types and issueId/taskId fallback semantics without
      // transferring prompts, transcripts, or the rest of the run context.
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'issueId', ${compactRunContext} -> 'issueId',
        'taskId', ${compactRunContext} -> 'taskId'
      )`,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      finishedAt: heartbeatRuns.finishedAt,
      exhaustionMessage: latestExhaustion.message,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(latestExhaustion, eq(latestExhaustion.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      // Feed retention only: keep historical runs and recovery evidence intact.
      sql`${heartbeatRuns.createdAt} >= now() - interval '7 days'`,
      eq(agents.companyId, companyId),
      // Independent anti-probes let each fallback use its expression index.
      sql`not exists (select 1 from heartbeat_runs newer
        where newer.company_id = ${heartbeatRuns.companyId}
          and newer.agent_id = ${heartbeatRuns.agentId}
          and newer.created_at >= date_trunc('milliseconds', ${heartbeatRuns.createdAt}) + interval '1 millisecond'
          and newer.context_snapshot ->> 'issueId' = ${issueKey})`,
      sql`not exists (select 1 from heartbeat_runs newer
        where newer.company_id = ${heartbeatRuns.companyId}
          and newer.agent_id = ${heartbeatRuns.agentId}
          and newer.created_at >= date_trunc('milliseconds', ${heartbeatRuns.createdAt}) + interval '1 millisecond'
          and newer.context_snapshot ->> 'issueId' is null
          and newer.context_snapshot ->> 'taskId' = ${issueKey})`,
      sql`not exists (select 1 from heartbeat_runs newer
        where newer.company_id = ${heartbeatRuns.companyId}
          and newer.agent_id = ${heartbeatRuns.agentId}
          and newer.created_at >= date_trunc('milliseconds', ${heartbeatRuns.createdAt}) + interval '1 millisecond'
          and newer.context_snapshot ->> 'issueId' is null
          and newer.context_snapshot ->> 'taskId' is null
          and ${issueKey} = '')`,
      notInArray(agents.status, ["terminated"]),
      inArray(heartbeatRuns.status, ["failed", "timed_out"]),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(latestExhaustion.eventId));
}
