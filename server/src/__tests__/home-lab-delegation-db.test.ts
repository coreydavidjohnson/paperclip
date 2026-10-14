import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { authorizeHomeLabChild } from "../services/home-lab-delegation.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("Home Lab delegation real transaction fence", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-home-lab-"); db = createDb(temp.connectionString); }, 60000);
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), caller = randomUUID(), target = randomUUID(), parentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tests", issuePrefix: `T${companyId.slice(0, 6)}`, defaultResponsibleUserId: "board-user" });
    await db.insert(agents).values([
      { id: caller, companyId, name: "Client", status: "idle", adapterType: "process" },
      { id: target, companyId, name: "Home Lab", status: "idle", adapterType: "process" },
    ]);
    await db.insert(issues).values({ id: parentId, companyId, title: "[test] caller-owned foreign root", assigneeAgentId: caller, createdByAgentId: target, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: caller, status: "running", contextSnapshot: { issueId: parentId }, responsibleUserId: "board-user" });
    const actor: Express.Request["actor"] = { type: "agent", source: "agent_key", agentId: caller, companyId, runId, onBehalfOfUserId: "board-user", keyScope: { kind: "standard" } };
    const child = { title: "[test] native platform child", status: "todo", assigneeAgentId: target, blockParentUntilDone: true,
      actorAgentId: caller, createdByAgentId: caller, actorRunId: runId, homeLabDelegationActor: actor };
    return { companyId, caller, target, parentId, runId, actor, child };
  }
  it("commits the real child and native blocker together", async () => {
    const f = await fixture();
    const result = await issueService(db).createChild(f.parentId, f.child);
    expect(result.issue.assigneeAgentId).toBe(f.target);
    expect(result.issue.createdByAgentId).toBe(f.caller);
    const blockers = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.parentId));
    expect(blockers.map(b => b.issueId)).toContain(result.issue.id);
  });
  it("rejects ownership changed after route admission, leaving no child", async () => {
    const f = await fixture();
    expect(await authorizeHomeLabChild(db, f.parentId, f.actor, f.child)).toBe(true);
    await db.update(issues).set({ assigneeAgentId: f.target }).where(eq(issues.id, f.parentId));
    await expect(issueService(db).createChild(f.parentId, f.child)).rejects.toThrow();
    expect(await db.select().from(issues).where(eq(issues.parentId, f.parentId))).toHaveLength(0);
  });
  it("rejects cancellation requested after route admission", async () => {
    const f = await fixture();
    expect(await authorizeHomeLabChild(db, f.parentId, f.actor, f.child)).toBe(true);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(issueService(db).createChild(f.parentId, f.child)).rejects.toThrow();
    expect(await db.select().from(issues).where(eq(issues.parentId, f.parentId))).toHaveLength(0);
  });
  it("rolls back the child if its parent blocker cannot be inserted", async () => {
    const f = await fixture();
    // A transaction-local trigger rejects only this test company's relation write.
    await db.execute((await import("drizzle-orm")).sql.raw(`CREATE FUNCTION reject_test_relation_${f.companyId.replaceAll("-", "")}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test blocker failure'; END $$`));
    const fn = `reject_test_relation_${f.companyId.replaceAll("-", "")}`;
    await db.execute((await import("drizzle-orm")).sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON issue_relations FOR EACH ROW WHEN (NEW.company_id = '${f.companyId}') EXECUTE FUNCTION ${fn}()`));
    try {
      await expect(issueService(db).createChild(f.parentId, f.child)).rejects.toThrow();
      expect(await db.select().from(issues).where(eq(issues.parentId, f.parentId))).toHaveLength(0);
    } finally {
      await db.execute((await import("drizzle-orm")).sql.raw(`DROP TRIGGER ${fn} ON issue_relations; DROP FUNCTION ${fn}()`));
    }
  });
});
