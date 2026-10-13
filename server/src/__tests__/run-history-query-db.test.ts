import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRunIdsCondition } from "../services/run-history-query.js";

describe("run history database contracts", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("luma-run-history-"); db = createDb(fixture.connectionString); }, 90_000);
  afterAll(async () => { await fixture?.cleanup(); });
  it("preserves issue/activity union membership, duplicates, company isolation and order", async () => {
    const company = randomUUID(), other = randomUUID(), agent = randomUUID(), otherAgent = randomUUID(), issue = randomUUID(), unrelated = randomUUID(), otherIssue = randomUUID();
    await db.insert(companies).values([{ id: company, name: "A", issuePrefix: "A" }, { id: other, name: "B", issuePrefix: "B" }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "A", role: "engineer", adapterType: "codex_local" }, { id: otherAgent, companyId: other, name: "B", role: "engineer", adapterType: "codex_local" }]);
    await db.insert(issues).values([
      { id: issue, companyId: company, title: "I", identifier: "A-1", issueNumber: 1 },
      { id: unrelated, companyId: company, title: "U", identifier: "A-2", issueNumber: 2 },
      { id: otherIssue, companyId: other, title: "O", identifier: "B-1", issueNumber: 1 },
    ] as any);
    const ids = Array.from({length: 5}, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map((id, i) => ({ id, companyId: i === 4 ? other : company, agentId: i === 4 ? otherAgent : agent, status: "succeeded",
      issueId: i === 4 ? otherIssue : i === 0 || i === 2 ? issue : unrelated, createdAt: new Date(1_700_000_000_000 + i * 1000) })));
    await db.insert(activityLog).values([1, 2, 2, 3].map(i => ({ companyId: i === 3 ? other : company, actorType: "system", actorId: "system", action: "test", entityType: "issue", entityId: issue, runId: ids[i] })));
    const oldCondition = sql`${heartbeatRuns.companyId} = ${company} and (
      ${heartbeatRuns.issueId} = ${issue} or exists (
        select 1 from activity_log where company_id = ${company} and entity_type = 'issue' and entity_id = ${issue} and run_id = ${heartbeatRuns.id}))`;
    const old = await db.select({id: heartbeatRuns.id}).from(heartbeatRuns).where(oldCondition).orderBy(sql`${heartbeatRuns.createdAt} desc`);
    const actual = await db.select({id: heartbeatRuns.id}).from(heartbeatRuns).where(sql`${heartbeatRuns.companyId} = ${company} and ${issueRunIdsCondition(company, issue)}`).orderBy(sql`${heartbeatRuns.createdAt} desc`);
    expect(actual).toEqual(old);
    expect(actual.map(r => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });
});
