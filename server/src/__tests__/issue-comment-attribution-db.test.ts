import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, heartbeatRuns, instanceSettings, issueComments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { deriveIssueCommentRunLogAttribution, issueService } from "../services/issues.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { issueRunIdsCondition } from "../services/run-history-query.js";

// Deliberately no supported/skip gate: this contract must execute on native PG.
describe("native comment attribution service", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const logDir = mkdtempSync(join(tmpdir(), "luma-comment-attribution-logs-"));
  beforeAll(async () => {
    vi.stubEnv("RUN_LOG_BASE_PATH", logDir);
    vi.stubEnv("RUN_LOG_S3_BUCKET", "");
    fixture = await startEmbeddedPostgresTestDatabase("luma-comment-attribution-");
    db = createDb(fixture.connectionString);
    expect((await db.execute(sql`select version() as version`))[0].version).toMatch(/PostgreSQL 18/);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await fixture?.cleanup(); vi.unstubAllEnvs(); rmSync(logDir, { recursive: true, force: true }); });

  async function seed() {
    const company = randomUUID(), other = randomUUID(), issue = randomUUID();
    const agent = randomUUID(), secondAgent = randomUUID(), foreignAgent = randomUUID();
    await db.insert(companies).values([{ id: company, name: "A", issuePrefix: "A" + company.slice(0, 7) }, { id: other, name: "B", issuePrefix: "B" + other.slice(0, 7) }]);
    await db.insert(agents).values([{ id: agent, companyId: company, name: "A", adapterType: "codex_local" }, { id: secondAgent, companyId: company, name: "A2", adapterType: "codex_local" }, { id: foreignAgent, companyId: other, name: "B", adapterType: "codex_local" }]);
    await db.insert(issues).values({ id: issue, companyId: company, title: "Attribution" });
    return { company, other, issue, agent, secondAgent, foreignAgent };
  }

  it("lists real comments with context/activity membership, own-run bypass, isolation, windows, redaction and stable pagination", async () => {
    const f = await seed();
    const at = new Date("2026-01-02T12:00:00Z");
    const early = new Date("2026-01-01T12:00:00Z"), late = new Date("2026-01-04T12:00:00Z");
    const ids = Array.from({ length: 9 }, () => randomUUID());
    const comments = Array.from({ length: 13 }, () => randomUUID()).sort();
    const human = randomUUID();
    await db.insert(authUsers).values({ id: human, name: "Human", email: `${human}@example.test`, emailVerified: true });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: { censorUsernameInLogs: false } }).onConflictDoNothing();
    const store = getRunLogStore();
    for (let i = 0; i < ids.length; i++) {
      const companyId = i === 4 ? f.other : f.company, agentId = i === 4 ? f.foreignAgent : f.agent;
      const handle = await store.begin({ companyId, agentId, runId: ids[i] });
      // Every excluded run contains a tempting marker; inclusion must not leak it.
      await store.append(handle, { stream: "stdout", ts: at.toISOString(), chunk: `comment id: ${comments[i]}
comment id: ${comments[12]}
` });
      const log = await store.finalize(handle);
      const outside = i === 3 || i === 5 ? early : i === 6 ? late : at;
      await db.insert(heartbeatRuns).values({ id: ids[i], companyId, agentId, status: "succeeded", contextSnapshot: { issueId: [0, 2, 4, 5, 6, 8].includes(i) ? f.issue : "unrelated", secret: "context-secret-not-returned" }, createdAt: outside, startedAt: i === 8 ? null : outside, finishedAt: i === 8 ? null : outside, logStore: handle.store, logRef: handle.logRef, logBytes: log.bytes });
    }
    await db.insert(activityLog).values([1, 2, 2, 7].map(i => ({ companyId: i === 7 ? f.other : f.company, actorType: "system", actorId: "system", action: "fixture", entityType: "issue", entityId: f.issue, runId: ids[i] })));
    await db.insert(issueComments).values(comments.map((id, i) => ({ id, companyId: f.company, issueId: f.issue, createdAt: at, authorUserId: i === 9 ? human : "local-board", authorAgentId: i === 10 ? f.secondAgent : null, createdByRunId: i === 3 ? ids[3] : i === 4 ? ids[4] : i === 9 || i === 10 ? ids[0] : null, derivedAuthorAgentId: i === 11 ? f.secondAgent : null, derivedCreatedByRunId: i === 11 ? ids[0] : null, derivedAuthorSource: i === 11 ? "run_id" as const : null, body: "fixture token=ghp_abcdefghijklmnopqrstuvwxyz1234567890" })));
    const service = issueService(db);
    const result = await service.listComments(f.issue, { order: "asc" });
    expect(result.map(c => c.id)).toEqual(comments);
    for (const i of [0, 1, 2, 8]) expect(result[i]).toMatchObject({ authorAgentId: null, authorUserId: "local-board", derivedAuthorAgentId: f.agent, derivedCreatedByRunId: ids[i], derivedAuthorSource: "run_log_comment_post" });
    expect(result[3]).toMatchObject({ createdByRunId: ids[3], derivedAuthorAgentId: f.agent, derivedCreatedByRunId: ids[3], derivedAuthorSource: "run_id" });
    for (const i of [4, 5, 6, 7]) expect(result[i].derivedAuthorAgentId).toBeNull();
    expect(result[9]).toMatchObject({ authorUserId: human, derivedAuthorAgentId: null });
    expect(result[10]).toMatchObject({ authorAgentId: f.secondAgent, derivedAuthorAgentId: null });
    expect(result[11]).toMatchObject({ derivedAuthorAgentId: f.secondAgent, derivedAuthorSource: "run_id" });
    expect(JSON.stringify(result)).not.toContain("context-secret-not-returned");
    expect(JSON.stringify(result)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue)).orderBy(issueComments.id);
    expect(stored[3]).toMatchObject({ authorAgentId: null, authorUserId: "local-board", createdByRunId: ids[3], derivedCreatedByRunId: ids[3] });
    expect(stored[0].body).toContain("ghp_");
    expect(await service.listComments(f.issue, { order: "asc", limit: 4 })).toEqual(result.slice(0, 4));
    expect(await service.listComments(f.issue, { order: "asc", afterCommentId: comments[3], limit: 4 })).toEqual(result.slice(4, 8));
    expect((await service.listComments(f.issue, { order: "desc", limit: 4 })).map(c => c.id)).toEqual(comments.slice(-4).reverse());
    expect(await service.listComments(f.issue, { afterCommentId: "invalid" })).toEqual([]);
  });

  it("compares actual old/new candidate order with tied timestamps and exposes marker-distance ties", async () => {
    const f = await seed(), at = new Date("2026-02-02T12:00:00Z"), comment = randomUUID();
    const ids = Array.from({ length: 32 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map((id, i) => ({ id, companyId: f.company, agentId: i % 2 ? f.secondAgent : f.agent, status: "succeeded", createdAt: at, startedAt: at, finishedAt: at, contextSnapshot: { issueId: f.issue } })));
    const oldMembership = sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${f.issue} or exists (select 1 from activity_log where company_id = ${f.company} and entity_type = 'issue' and entity_id = ${f.issue} and run_id = ${heartbeatRuns.id})`;
    const select = (membership: ReturnType<typeof sql>) => db.select({ runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.company), membership)).orderBy(desc(heartbeatRuns.createdAt));
    const old = await select(oldMembership), actual = await select(issueRunIdsCondition(f.company, f.issue));
    expect(actual.map(r => r.runId).sort()).toEqual(old.map(r => r.runId).sort());
    console.info("tied candidate order", JSON.stringify({ identical: actual.every((r, i) => r.runId === old[i].runId), old: old.map(r => ids.indexOf(r.runId)), actual: actual.map(r => ids.indexOf(r.runId)) }));
    const candidate = { id: comment, authorUserId: "local-board", createdAt: at };
    const runs = actual.slice(0, 2).map(r => ({ ...r, logContent: `comment id: ${comment}` }));
    const first = deriveIssueCommentRunLogAttribution([candidate], runs).get(comment);
    const reverse = deriveIssueCommentRunLogAttribution([candidate], [...runs].reverse()).get(comment);
    // This documents the existing first-in-input rule, not a new UUID sort.
    expect(first?.derivedCreatedByRunId).toBe(runs[0].runId);
    expect(reverse?.derivedCreatedByRunId).toBe(runs[1].runId);
    const own = { ...candidate, createdByRunId: runs[1].runId };
    expect(deriveIssueCommentRunLogAttribution([own], runs).get(comment)?.derivedCreatedByRunId).toBe(runs[1].runId);
    const unique = runs.map((r, i) => ({ ...r, logContent: i ? "" : r.logContent }));
    expect(deriveIssueCommentRunLogAttribution([candidate], unique)).toEqual(deriveIssueCommentRunLogAttribution([candidate], [...unique].reverse()));
  });
});
