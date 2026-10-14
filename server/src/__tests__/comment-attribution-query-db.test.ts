import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRunIdsCondition } from "../services/run-history-query.js";

describe("comment attribution membership database contracts", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("luma-comment-membership-"); db = createDb(fixture.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await fixture?.cleanup(); });
  it("preserves full fields, windows, own unrelated runs, duplicates and tenant isolation", async () => {
    const company = randomUUID(), other = randomUUID(), agent = randomUUID(), otherAgent = randomUUID(), issue = randomUUID();
    await db.insert(companies).values([{ id: company, name: "A", issuePrefix: "A" }, { id: other, name: "B", issuePrefix: "B" }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "A", role: "engineer", adapterType: "codex_local" }, { id: otherAgent, companyId: other, name: "B", role: "engineer", adapterType: "codex_local" }]);
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const t = 1_700_000_000_000;
    await db.insert(heartbeatRuns).values(ids.map((id, i) => ({ id, companyId: i === 7 ? other : company, agentId: i === 7 ? otherAgent : agent, status: "succeeded", contextSnapshot: { issueId: [0, 2, 4, 7].includes(i) ? issue : "unrelated" }, createdAt: new Date(t + i * 1000), startedAt: i === 0 ? null : new Date(t + i * 1000), finishedAt: i === 0 ? null : new Date(t + i * 1000 + 500), logStore: "local", logRef: `log-${i}`, logBytes: i * 10 })));
    await db.insert(activityLog).values([1, 2, 2, 5].map(i => ({ companyId: i === 5 ? other : company, actorType: "system", actorId: "system", action: "test", entityType: "issue", entityId: issue, runId: ids[i] })));
    const oldMembership = sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue} or exists (select 1 from activity_log where company_id = ${company} and entity_type = 'issue' and entity_id = ${issue} and run_id = ${heartbeatRuns.id}))`;
    const columns = { runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef, logBytes: heartbeatRuns.logBytes };
    for (const own of [[], [ids[6], ids[7]]]) {
      const read = (membership: ReturnType<typeof sql>) => db.select(columns).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company), or(and(membership, sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${new Date(t).toISOString()}::timestamptz`, sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${new Date(t + 2500).toISOString()}::timestamptz`), own.length ? inArray(heartbeatRuns.id, own) : sql`false`))).orderBy(desc(heartbeatRuns.createdAt));
      const old = await read(oldMembership), actual = await read(issueRunIdsCondition(company, issue));
      expect(actual).toEqual(old);
      expect(actual.map(r => r.runId)).toEqual(own.length ? [ids[6], ids[2], ids[1], ids[0]] : [ids[2], ids[1], ids[0]]);
    }
  });
});
