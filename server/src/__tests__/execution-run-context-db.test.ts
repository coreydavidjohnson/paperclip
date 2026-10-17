import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, heartbeatRuns, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import { executionRunContextColumn, executionRunContextJoin } from "../services/execution-run-context.js";

describe("execution context database contract", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("luma-execution-context-"); db = createDb(fixture.connectionString); }, 90_000);
  afterAll(async () => { await fixture?.cleanup(); });
  it("preserves every allowlisted JSON type, null shape and one-row membership", async () => {
    const values = [null, [], "text", 42, true, {}, { issueId: "large", extra: Array.from({length: 5000}, (_, i) => `${i}-large-context`).join(",") },
      { issueId: "i", failureRetriesBeforeAiConnectionWait: 3, failureRetriesBeforeWorkspaceWait: 0, secret: "never-return" },
      { issueId: 123, failureRetriesBeforeAiConnectionWait: "3", failureRetriesBeforeWorkspaceWait: false },
      { issueId: { a: 1 }, failureRetriesBeforeAiConnectionWait: [1, "x"], failureRetriesBeforeWorkspaceWait: null },
      { IssueId: "wrong-case", failureRetriesBeforeAiConnectionWait: { nested: true }, failureRetriesBeforeWorkspaceWait: -1 }];
    for (const value of values) {
      const result = await db.execute(sql`with heartbeat_runs as (select ${JSON.stringify(value)}::jsonb as context_snapshot)
        select jsonb_build_object('issueId', context_snapshot->'issueId',
          'failureRetriesBeforeAiConnectionWait', context_snapshot->'failureRetriesBeforeAiConnectionWait',
          'failureRetriesBeforeWorkspaceWait', context_snapshot->'failureRetriesBeforeWorkspaceWait') as old,
          ${executionRunContextColumn} as actual from heartbeat_runs left join ${executionRunContextJoin} on true`);
      expect(result).toHaveLength(1);
      expect(result[0].actual).toEqual(result[0].old);
      expect(result[0].actual).not.toHaveProperty("secret");
    }
    const result = await db.execute(sql`with heartbeat_runs as (select null::jsonb as context_snapshot)
      select ${executionRunContextColumn} as actual from heartbeat_runs left join ${executionRunContextJoin} on true`);
    expect(result).toHaveLength(1);
    expect(result[0].actual).toEqual({ issueId: null, failureRetriesBeforeAiConnectionWait: null, failureRetriesBeforeWorkspaceWait: null });
  });
  it("executes the actual Drizzle projection and keeps company isolation", async () => {
    const company = randomUUID(), other = randomUUID(), agent = randomUUID(), otherAgent = randomUUID();
    await db.insert(companies).values([{ id: company, name: "A", issuePrefix: "A" }, { id: other, name: "B", issuePrefix: "B" }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "A", role: "engineer", adapterType: "codex_local" }, { id: otherAgent, companyId: other, name: "B", role: "engineer", adapterType: "codex_local" }]);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values(ids.map((id, i) => ({ id, companyId: i === 2 ? other : company, agentId: i === 2 ? otherAgent : agent, status: "succeeded", contextSnapshot: i === 1 ? null : { issueId: "00000000-0000-4000-8000-000000000001", failureRetriesBeforeAiConnectionWait: 3, secret: "never-return" } })));
    const rows = await db.select({ id: heartbeatRuns.id, contextSnapshot: executionRunContextColumn }).from(heartbeatRuns).leftJoin(executionRunContextJoin, sql`true`).where(and(eq(heartbeatRuns.companyId, company), inArray(heartbeatRuns.id, ids)));
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === ids[0])?.contextSnapshot).toEqual({ issueId: "00000000-0000-4000-8000-000000000001", failureRetriesBeforeAiConnectionWait: 3, failureRetriesBeforeWorkspaceWait: null });
    const projections = await executionProjectionsForRuns(db, company, ids);
    expect([...projections.keys()].sort()).toEqual(ids.slice(0, 2).sort());
    expect(projections.get(ids[0])?.phase).toBe("completed");
    expect(projections.get(ids[1])?.phase).toBe("completed");
    expect(await executionProjectionsForRuns(db, company, [])).toEqual(new Map());
  });
});
