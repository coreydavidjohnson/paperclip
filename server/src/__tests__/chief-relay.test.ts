import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authenticateChiefRelay, chiefRelayCardSnapshot, chiefRelayFingerprint, chiefRelayInputSchema, chiefRelayMiddleware, chiefRelayNativePath } from "../middleware/chief-relay.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Request } from "express";

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock("../services/access.js", async original => ({ ...await original<Record<string, unknown>>(),
  accessService: () => ({ decide: async () => ({ allowed: access.allowed, reason: "test_grant", explanation: "fixture" }) }),
}));
const chat = "chief-owned-chat";
const parsed = (overrides = {}) => chiefRelayInputSchema.parse({ sourceKind: "issue_thread_interaction", sourceId: randomUUID(),
  issueId: randomUUID(), action: "accept", input: {}, sourceSessionId: chat, sourceMessageId: "human-message-123",
  exactQuote: "Approve the disposable welcome note.", scope: "Disposable fixture note only", idempotencyKey: "answer-123", ...overrides });
const env = { PAPERCLIP_CHIEF_RELAY_AGENT_ID: "chief", PAPERCLIP_CHIEF_RELAY_COMPANY_ID: "company",
  PAPERCLIP_CHIEF_RELAY_USER_ID: "local-board", PAPERCLIP_CHIEF_RELAY_SOURCE_SESSION_ID: chat };
const actor = { type: "agent", agentId: "chief", companyId: "company" } as Request["actor"];

describe("Chief relay entry-point contract", () => {
  it("derives the actual submitter and represented user from server configuration", () => {
    expect(authenticateChiefRelay(actor, parsed(), env)).toMatchObject({ agentId: "chief", companyId: "company", representedUserId: "local-board" });
  });
  it.each(["board", "other-agent", "other-company", "other-chat", "disabled"])("rejects %s", which => {
    const a = which === "board" ? { type: "board", userId: "local-board" } : { ...actor,
      ...(which === "other-agent" ? { agentId: "other" } : {}), ...(which === "other-company" ? { companyId: "other" } : {}) };
    expect(() => authenticateChiefRelay(a as Request["actor"], parsed(which === "other-chat" ? { sourceSessionId: "other" } : {}), which === "disabled" ? {} : env)).toThrow();
  });
  it("rejects blank provenance and caller-selected authority", () => {
    for (const field of ["exactQuote", "scope", "sourceMessageId", "idempotencyKey"]) expect(chiefRelayInputSchema.safeParse({ ...parsed(), [field]: " " }).success).toBe(false);
  });
  it("has no caller-controlled represented user or agent", () => {
    expect(chiefRelayInputSchema.safeParse({ ...parsed(), representedUserId: "admin" }).success).toBe(false);
  });
  it("fingerprints the exact request, independently of object key order", () => {
    expect(chiefRelayFingerprint({ b: 2, a: 1 })).toBe(chiefRelayFingerprint({ a: 1, b: 2 }));
    expect(chiefRelayFingerprint({ choice: "yes" })).not.toBe(chiefRelayFingerprint({ choice: "no" }));
  });
  it("keeps raw tool and credential payloads out of the audit card snapshot", () => {
    expect(JSON.stringify(chiefRelayCardSnapshot({ id: "card", payload: { prompt: "Approve target?", signedSpec: "secret", toolAction: { arguments: "secret" }, secretProposal: { value: "secret" } } }))).not.toContain("secret");
  });
  it("rejects incompatible actions rather than calling an arbitrary endpoint", () => {
    expect(() => chiefRelayNativePath(parsed({ sourceKind: "approval", action: "respond" }))).toThrow();
    expect(() => chiefRelayNativePath(parsed({ issueId: undefined }))).toThrow();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Chief relay native route and outcome", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("chief-relay-"); db = createDb(temporary.connectionString); }, 120000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); access.allowed = true; });
  async function fixture(kind = "request_confirmation") {
    const companyId = randomUUID(), chiefId = randomUUID(), ownerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Relay fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([{ id: chiefId, companyId, name: "Chief", adapterType: "omnigent" },
      { id: ownerId, companyId, name: "Owner", adapterType: "omnigent" }]);
    const [issue] = await db.insert(issues).values({ companyId, title: "Disposable relay fixture", status: "in_progress", assigneeAgentId: ownerId }).returning();
    const svc = issueThreadInteractionService(db);
    const payload = kind === "ask_user_questions" ? { version: 1, questions: [{ id: "color", prompt: "Select fixture color", selectionMode: "single", required: true,
      options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }] }] }
      : kind === "request_checkbox_confirmation" ? { version: 1, prompt: "Select disposable notes", options: [{ id: "note", label: "Note" }, { id: "other", label: "Other note" }], minSelected: 1, defaultSelectedOptionIds: ["other"] }
      : kind === "request_item_verdicts" ? { version: 1, prompt: "Review fixture items", items: [{ id: "note", label: "Note" }, { id: "other", label: "Other" }], verdicts: ["approve", "reject"] }
      : kind === "suggest_tasks" ? { version: 1, tasks: [{ clientKey: "note", title: "Disposable suggested note" }, { clientKey: "other", title: "Do not create" }] }
      : { version: 1, prompt: "Approve the disposable welcome note?" };
    const card = await svc.create(issue, { kind, payload, resolverPolicy: "human_only", addresseeUserId: "local-board" } as never, { agentId: ownerId });
    expect(card.effectiveResolverPolicy).toBe("human_only");
    vi.stubEnv("PAPERCLIP_CHIEF_RELAY_AGENT_ID", chiefId); vi.stubEnv("PAPERCLIP_CHIEF_RELAY_COMPANY_ID", companyId);
    vi.stubEnv("PAPERCLIP_CHIEF_RELAY_USER_ID", "local-board"); vi.stubEnv("PAPERCLIP_CHIEF_RELAY_SOURCE_SESSION_ID", chat);
    const authActor = { type: "agent", agentId: chiefId, companyId, source: "agent_key", runId: undefined } as Request["actor"];
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = authActor; next(); });
    app.use(chiefRelayMiddleware(db)); app.use(issueRoutes(db, {} as never)); app.use(errorHandler);
    const input = parsed({ issueId: issue.id, sourceId: card.id });
    return { app, input, card, issue, svc, chiefId, ownerId, companyId, authActor };
  }
  const readCard = (id: string) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)).then(rows => rows[0]!);
  it.each(["accept", "reject"])("records %s with actual Chief attribution and native audit", async action => {
    const f = await fixture(); const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, action });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ status: action === "accept" ? "accepted" : "rejected", resolvedByAgentId: f.chiefId, resolvedByUserId: null,
      result: { chiefRelay: { sourceMessageId: f.input.sourceMessageId, exactQuote: f.input.exactQuote, representedUserId: "local-board" } } });
    expect((await readCard(f.card.id)).resolvedByRunId).toBeNull();
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, f.card.id));
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "chief_relay.submitted", actorType: "agent", actorId: f.chiefId })]));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    expect(comments).toEqual(expect.arrayContaining([expect.objectContaining({ authorAgentId: f.chiefId, authorUserId: null,
      body: expect.stringContaining(f.input.exactQuote) })]));
  });
  it("answers a human-only question with explicit native choices", async () => {
    const f = await fixture("ask_user_questions");
    const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, action: "respond", input: { answers: [{ questionId: "color", optionIds: ["blue"] }] } });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ status: "answered", resolvedByUserId: null, resolvedByAgentId: f.chiefId,
      result: { answers: [{ questionId: "color", optionIds: ["blue"] }], chiefRelay: { agentId: f.chiefId } } });
  });
  it("carries checkbox selections without inventing defaults", async () => {
    const f = await fixture("request_checkbox_confirmation");
    const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, input: { selectedOptionIds: ["note"] } });
    expect(response.status, response.text).toBe(200); expect(response.body.result.selectedOptionIds).toEqual(["note"]);
    expect(response.body.result.chiefRelay.agentId).toBe(f.chiefId);
  });
  it("records each item verdict with the real Chief resolver across partial replies", async () => {
    const f = await fixture("request_item_verdicts");
    const firstInput = { ...f.input, action: "verdicts", input: { verdicts: [{ id: "note", verdict: "approve" }] } };
    const first = await request(f.app).post("/chief-relay/answers").send(firstInput);
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ status: "pending", result: { complete: false, items: [{ id: "note", resolvedByAgentId: f.chiefId, chiefRelay: { sourceMessageId: f.input.sourceMessageId } }] } });
    const secondInput = { ...f.input, idempotencyKey: "answer-124", sourceMessageId: "human-message-124", exactQuote: "Reject the other note.", action: "verdicts", input: { verdicts: [{ id: "other", verdict: "reject", reason: "Not needed" }] } };
    const second = await request(f.app).post("/chief-relay/answers").send(secondInput);
    expect(second.status, second.text).toBe(200);
    expect(second.body).toMatchObject({ status: "answered", resolvedByAgentId: f.chiefId, resolvedByUserId: null, result: { complete: true } });
    const retry = await request(f.app).post("/chief-relay/answers").send(firstInput);
    expect(retry.status, retry.text).toBe(200);
    expect(retry.body).toEqual(second.body);
    const altered = await request(f.app).post("/chief-relay/answers").send({ ...firstInput, scope: "Different scope" });
    expect(altered.status, altered.text).toBe(409);
    expect(second.body.result.items).toEqual([
      expect.objectContaining({ id: "note", resolvedByAgentId: f.chiefId, chiefRelay: { ...authenticateChiefRelay(f.authActor, parsed(firstInput)) } }),
      expect.objectContaining({ id: "other", resolvedByAgentId: f.chiefId, chiefRelay: { ...authenticateChiefRelay(f.authActor, parsed(secondInput)) } }),
    ]);
  });
  it("creates only explicitly selected suggested tasks and keeps Chief attribution", async () => {
    const f = await fixture("suggest_tasks");
    const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, input: { selectedClientKeys: ["note"] } });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ status: "accepted", resolvedByAgentId: f.chiefId, resolvedByUserId: null, result: { chiefRelay: { agentId: f.chiefId }, createdTasks: [{ clientKey: "note" }] } });
    const created = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
    expect(created.map(row => row.title).sort()).toEqual(["Disposable relay fixture", "Disposable suggested note"]);
    expect(created.find(row => row.title === "Disposable suggested note")).toMatchObject({ createdByAgentId: f.chiefId, createdByUserId: null });
  });
  it("replays the same receipt without another comment and rejects a changed answer", async () => {
    const f = await fixture(); const first = await request(f.app).post("/chief-relay/answers").send(f.input); expect(first.status, first.text).toBe(200);
    const second = await request(f.app).post("/chief-relay/answers").send(f.input); expect(second.status, second.text).toBe(200);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id)); expect(comments).toHaveLength(1);
    expect((await request(f.app).post("/chief-relay/answers").send({ ...f.input, action: "reject" })).status).toBe(409);
    expect((await request(f.app).post("/chief-relay/answers").send({ ...f.input, action: "reject", idempotencyKey: "different" })).status).toBe(409);
  });
  it("rechecks current scope even for an exact replay", async () => {
    const f = await fixture(); expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(200);
    access.allowed = false; expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(403);
  });
  it("does not allow ordinary native endpoints to spoof the server-owned proof", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.chiefId, status: "running" });
    f.authActor.runId = runId;
    const response = await request(f.app).post(`/issues/${f.issue.id}/interactions/${f.card.id}/accept`)
      .set("x-chief-relay", "true").send({ chiefRelay: authenticateChiefRelay(f.authActor, f.input) });
    expect(response.status, response.text).toBe(403); expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it("rejects cancelled actual run authority without mutating the card", async () => {
    const f = await fixture(), runId = randomUUID(); await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.chiefId, status: "cancelled" });
    f.authActor.runId = runId; const response = await request(f.app).post("/chief-relay/answers").send(f.input);
    expect(response.status, response.text).toBe(403); expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it("rechecks the represented user rather than accepting an old proof after authority changes", async () => {
    const f = await fixture(); expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(200);
    vi.stubEnv("PAPERCLIP_CHIEF_RELAY_USER_ID", "another-user");
    expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(409);
  });
  it("answers a historical ordinary question on a completed issue without reopening it", async () => {
    const f = await fixture("ask_user_questions");
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id, authorUserId: "local-board", authorType: "user", body: "Continue with the chosen plan", createdAt: new Date(Date.now() + 1000) });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, action: "respond", input: { answers: [{ questionId: "color", optionIds: ["blue"] }] } });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ status: "answered", resolvedByAgentId: f.chiefId, resolvedByUserId: null });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("done");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(0);
  });
  it("keeps a stopped-but-not-yet-settled actual run from resolving a card", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.chiefId, status: "running", resultJson: { executionCancellation: { state: "requested" } } });
    f.authActor.runId = runId;
    expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(403);
    await expect(f.svc.acceptInteraction(f.issue, f.card.id, {}, { agentId: f.chiefId, runId, chiefRelay: authenticateChiefRelay(f.authActor, f.input) })).rejects.toMatchObject({ status: 403 });
    expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it("expires a stale document target instead of accepting it", async () => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: "Approve this old revision?", target: { type: "issue_document", key: "plan", revisionId: randomUUID() } } }).where(eq(issueThreadInteractions.id, f.card.id));
    const response = await request(f.app).post("/chief-relay/answers").send(f.input);
    expect(response.status, response.text).toBe(409);
    expect(await readCard(f.card.id)).toMatchObject({ status: "expired", result: { outcome: "stale_target" } });
  });
  it("preserves closed-issue and addressee limits", async () => {
    const f = await fixture(); await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    expect((await request(f.app).post("/chief-relay/answers").send(f.input)).status).toBe(409);
    expect((await readCard(f.card.id)).status).toBe("pending");
    const g = await fixture(); await db.update(issueThreadInteractions).set({ addresseeUserId: "someone-else" }).where(eq(issueThreadInteractions.id, g.card.id));
    expect((await request(g.app).post("/chief-relay/answers").send(g.input)).status).toBe(403);
  });
  it("skips through the explicit relay without opening the board-only native path", async () => {
    const f = await fixture(); const response = await request(f.app).post("/chief-relay/answers").send({ ...f.input, action: "skip", input: { reason: "Corey withdrew this fixture" } });
    expect(response.status, response.text).toBe(200); expect(response.body).toMatchObject({ status: "cancelled", resolvedByAgentId: f.chiefId, resolvedByUserId: null, result: { chiefRelay: { agentId: f.chiefId } } });
  });
});
