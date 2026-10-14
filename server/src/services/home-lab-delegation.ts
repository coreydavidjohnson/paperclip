import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { forbidden } from "../errors.js";

type Actor = Express.Request["actor"];
type Child = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  status?: string;
  blockParentUntilDone?: boolean;
  blockedByIssueIds?: string[];
};

// Route admission is repeated on the child-plus-blocker write transaction.
export async function authorizeHomeLabChild(
  db: Db, parentId: string, actor: Actor, body: Child, lock = false,
): Promise<boolean> {
  if (actor.type !== "agent" || !body.assigneeAgentId) return false;
  const [candidate] = await db.select().from(agents).where(eq(agents.id, body.assigneeAgentId));
  if (candidate?.name !== "Home Lab") return false;
  const deny = () => { throw forbidden("Home Lab delegation requires your active run, owned parent, todo child and parent blocker"); };
  if (!actor.agentId || !actor.runId || !actor.companyId || actor.source !== "agent_jwt"
      || (actor.keyScope && actor.keyScope.kind !== "standard")
      || body.assigneeUserId || body.status !== "todo" || body.blockParentUntilDone !== true
      || (body.blockedByIssueIds?.length ?? 0) > 0) deny();

  // ponytail: short identity fence prevents phantom duplicate Home Lab rows.
  // Replace with a company-scoped unique platform-target constraint if contention matters.
  if (lock) await db.execute(sql`lock table ${agents} in share mode`);
  const companyAgents = await db.select().from(agents).where(eq(agents.companyId, actor.companyId!));
  const targets = companyAgents.filter((row) => row.name === "Home Lab");
  const caller = companyAgents.find((row) => row.id === actor.agentId);
  const active = (status: string | undefined) => ["idle", "running", "error"].includes(status ?? "");
  if (targets.length !== 1 || targets[0].id !== body.assigneeAgentId
      || !active(targets[0].status) || !active(caller?.status)) deny();
  const runQuery = db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, actor.runId!), eq(heartbeatRuns.companyId, actor.companyId!),
    eq(heartbeatRuns.agentId, actor.agentId!),
  ));
  const [run] = await (lock ? runQuery.for("share") : runQuery);
  const parentQuery = db.select().from(issues).where(and(
    eq(issues.id, parentId), eq(issues.companyId, actor.companyId!),
  ));
  const [parent] = await (lock ? parentQuery.for("update") : parentQuery);
  const contextIssue = run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
  if (!run || run.status !== "running" || agentRunWritesRevoked(run)
      || (run.nativeIssueId ?? contextIssue) !== parentId
      || (contextIssue != null && contextIssue !== parentId)
      || (run.activeIdentityContextId ?? null) !== (actor.identityContextId ?? null)
      || !parent || parent.assigneeAgentId !== actor.agentId || parent.assigneeUserId
      || ["done", "cancelled"].includes(parent.status)) deny();
  return true;
}
