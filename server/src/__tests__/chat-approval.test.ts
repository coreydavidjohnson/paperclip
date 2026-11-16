import express from "express";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createChatApprovalAuth } from "../auth/chat-approval-auth.js";
import { designationQuestion, digest, readChatApprovalConfig } from "../services/chat-approval-proof.js";
import { designationSnapshot, designatedChatApprovalActor, presentChatApproval, resolveChatApproval } from "../services/chat-approval-resolution.js";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import type { Enrollment } from "../services/chat-approval-proof.js";

const ORIGIN = "https://approval.example.test";
const envNames = ["BETTER_AUTH_SECRET", "PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_CHAT_APPROVAL_ENABLED", "PAPERCLIP_CHAT_APPROVAL_ORIGIN", "PAPERCLIP_CHAT_APPROVAL_HMAC_KEY", "PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS", "PAPERCLIP_CHAT_APPROVAL_SIGNUP_ENABLED"] as const;
const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
// No support-based skip: this proof needs real Postgres and real human login.
describe("isolated chat approval with native authentication and persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let root: string;
  let cookie: string;
  let userId: string;
  let password: string;
  let enrollments: Enrollment[] = [];
  // Supertest can choose an IPv6 bind host. Send the same allowed host as the human page.
  const testRequest = () => request.agent(app).set("Host", new URL(ORIGIN).host);
  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    process.env.PAPERCLIP_CHAT_APPROVAL_ENABLED = "1";
    process.env.PAPERCLIP_CHAT_APPROVAL_ORIGIN = ORIGIN;
    process.env.PAPERCLIP_CHAT_APPROVAL_HMAC_KEY = randomBytes(32).toString("hex");
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = "[]";
    temporary = await startEmbeddedPostgresTestDatabase("chat-approval-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(join(tmpdir(), "chat-approval-"));
    await db.insert(authUsers).values({ id: "local-board", name: "Local Board", email: "local@fixture.invalid", createdAt: new Date(), updatedAt: new Date() });
    const auth = createChatApprovalAuth(db, readChatApprovalConfig()!);
    app = await createApp(db, { uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1", "approval.example.test"],
      bindHost: "127.0.0.1", authPublicBaseUrl: ORIGIN, authReady: true, companyDeletionEnabled: false,
      instanceId: `chat-approval-${randomUUID()}`, localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      chatApprovalAuth: auth,
    });
    password = randomBytes(24).toString("hex");
    process.env.PAPERCLIP_CHAT_APPROVAL_SIGNUP_ENABLED = "1";
    const signup = await testRequest().post("/api/chat-approval-auth/sign-up/email").set("Origin", ORIGIN)
      .send({ email: "synthetic-human@fixture.invalid", password, name: "Synthetic human" });
    expect(signup.status, signup.text).toBe(200);
    process.env.PAPERCLIP_CHAT_APPROVAL_SIGNUP_ENABLED = "0";
    userId = signup.body.user.id;
    const cookies = signup.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies]).map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    expect(cookie).toContain("paperclip-chat-approval");
    expect((Array.isArray(cookies) ? cookies : [cookies]).some(value => value.includes("Secure"))).toBe(true);
  }, 120_000);
  afterAll(async () => {
    await app?.locals.paperclipShutdown();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    for (const name of envNames) { if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name]; }
  });
  beforeEach(() => {
    enrollments = [];
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = "[]";
  });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic approval", issuePrefix: companyId.slice(0, 8) });
    // A fresh login must not need a broader company grant to answer the one test.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic coordinator", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic no-op approval", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native", responsibleUserId: "local-board", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const card = await issueThreadInteractionService(db).create(issue!, { kind: "request_confirmation", resolverPolicy: "human_only", addresseeUserId: "local-board", payload: { version: 1, prompt: "Approve the disposable marker test?", detailsMarkdown: "Synthetic data. No outside effects." } }, { agentId });
    const binding = { companyId, issueId, interactionId: card.id, userId: "local-board", chatId: `synthetic-chat-${randomUUID()}`, submittingAgentId: agentId,
      revision: "disposable-v1", action: "Write a synthetic marker", target: "Disposable test directory", scope: "Synthetic data only. No production access.", undo: "Remove the synthetic marker", effect: "synthetic_test_only" as const };
    const designation = await issueThreadInteractionService(db).create(issue!, { kind: "ask_user_questions", resolverPolicy: "human_only", addresseeUserId: "local-board", payload: { version: 1, supersedeOnUserComment: false, questions: [designationQuestion(binding)] } }, { agentId });
    // Synthetic native answer, not evidence of Corey approval. Exercise the real
    // free-text normalization rather than manufacturing a result in the database.
    await issueThreadInteractionService(db).answerQuestions(issue!, designation.id, { answers: [{ questionId: "designate-test-account", optionIds: ["bind-this-account"], otherText: userId }] }, { userId: "local-board" });
    const [designationRow] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, designation.id));
    const e: Enrollment = { ...binding, loginAccountId: userId, designationId: designation.id, designationHash: digest(designationSnapshot(designationRow!)), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    enrollments.push(e);
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments);
    const path = `/api/issues/${issueId}/interactions/${card.id}/chat-approval`;
    const token = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, "local-board");
    return { e, path, token, card, issueId };
  }
  async function prompt(f: Awaited<ReturnType<typeof seed>>) {
    const page = await testRequest().get(f.path).set("Cookie", cookie);
    expect(page.status, page.text).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.text).toContain(f.e.scope);
    expect(page.text).toContain("Synthetic data. No outside effects.");
    const proof = page.text.match(/name="proof" value="([^"]+)"/)?.[1];
    expect(proof).toBeTruthy();
    return proof!;
  }
  const read = async (id: string) => (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]!;
  const audit = async (issueId: string) => (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).filter(row => row.action === "issue.chat_approval_answered");
  const post = (path: string, proof: string, choice = "accept", answer = "") => testRequest().post(path).set("Cookie", cookie).set("Origin", ORIGIN).type("form").send({ proof, choice, answer });

  it("keeps the human cookie out of ordinary local-board routes and refuses an anonymous approval", async () => {
    for (const sessionCookie of [cookie, ""]) {
      const profile = await testRequest().get("/api/auth/get-session").set("Cookie", sessionCookie);
      expect(profile.status, profile.text).toBe(200);
      expect(profile.body.user.id).toBe("local-board");
    }
    const f = await seed();
    expect((await testRequest().get(f.path)).status).toBe(403);
    expect((await read(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it("limits sign-in to the human origin and closes registration after enrollment", async () => {
    // The empty-enrollment state alone must not open public registration.
    expect((await testRequest().post("/api/chat-approval-auth/sign-up/email").set("Origin", ORIGIN).send({ email: "closed@fixture.invalid", password, name: "Other" })).status).toBe(403);
    const f = await seed();
    const page = await testRequest().get("/api/chat-approval-auth/login");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.text).not.toContain(password);
    for (const headers of [{ Authorization: `Bearer ${f.token}` }, { "X-Paperclip-Run-Id": randomUUID() }]) {
      expect((await testRequest().get("/api/chat-approval-auth/login").set(headers)).status).toBe(403);
    }
    expect((await testRequest().post("/api/chat-approval-auth/sign-in/email").send({ email: "synthetic-human@fixture.invalid", password })).status).toBe(403);
    expect((await testRequest().post("/api/chat-approval-auth/sign-up/email").set("Origin", ORIGIN).send({ email: "other@fixture.invalid", password, name: "Other" })).status).toBe(403);
    expect((await testRequest().post("/api/chat-approval-auth/change-password").set("Origin", ORIGIN).set("Cookie", cookie).send({})).status).toBe(404);
    const login = await testRequest().post("/api/chat-approval-auth/sign-in/email").set("Origin", ORIGIN).send({ email: "synthetic-human@fixture.invalid", password });
    expect(login.status, login.text).toBe(200);
    expect(login.body.user.id).toBe(userId);
  });
  it("signs out only that human session and refuses its old form without changing the card", async () => {
    const f = await seed();
    const login = await testRequest().post("/api/chat-approval-auth/sign-in/email").set("Origin", ORIGIN)
      .send({ email: "synthetic-human@fixture.invalid", password });
    expect(login.status, login.text).toBe(200);
    const cookies = login.headers["set-cookie"];
    const signedOutCookie = (Array.isArray(cookies) ? cookies : [cookies]).map(value => value.split(";")[0]).join("; ");
    const page = await testRequest().get(f.path).set("Cookie", signedOutCookie);
    expect(page.status, page.text).toBe(200);
    const proof = page.text.match(/name="proof" value="([^"]+)"/)?.[1];
    expect(proof).toBeTruthy();
    const response = await testRequest().post("/api/chat-approval-auth/sign-out")
      .set("Cookie", signedOutCookie).set("Origin", ORIGIN).send({});
    expect(response.status, response.text).toBe(200);
    expect((await testRequest().get(f.path).set("Cookie", signedOutCookie)).status).toBe(403);
    expect((await testRequest().post(f.path).set("Cookie", signedOutCookie).set("Origin", ORIGIN)
      .type("form").send({ proof, choice: "accept", answer: "" })).status).toBe(403);
    expect((await read(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
    const profile = await testRequest().get("/api/auth/get-session").set("Cookie", signedOutCookie);
    expect(profile.body.user.id).toBe("local-board");
    await prompt(f); // A different human session is not signed out.
  });
  it("turns off only this path and invalidates its old session on key rotation", async () => {
    const f = await seed();
    const key = process.env.PAPERCLIP_CHAT_APPROVAL_HMAC_KEY;
    try {
      process.env.PAPERCLIP_CHAT_APPROVAL_HMAC_KEY = randomBytes(32).toString("hex");
      expect((await testRequest().get(f.path).set("Cookie", cookie)).status).not.toBe(200);
      expect((await testRequest().get("/api/chat-approval-auth/login")).status).toBe(404);
      process.env.PAPERCLIP_CHAT_APPROVAL_ENABLED = "0";
      expect((await testRequest().get("/api/chat-approval-auth/login")).status).toBe(404);
      const profile = await testRequest().get("/api/auth/get-session").set("Cookie", cookie);
      expect(profile.status).toBe(200);
      expect(profile.body.user.id).toBe("local-board");
      expect((await read(f.card.id)).status).toBe("pending");
    } finally {
      process.env.PAPERCLIP_CHAT_APPROVAL_HMAC_KEY = key;
      process.env.PAPERCLIP_CHAT_APPROVAL_ENABLED = "1";
    }
    expect((await post(f.path, await prompt(f))).status).toBe(200);
  });

  it("opens one existing card from the agent route, accepts a real login answer, and retries once without a second audit", async () => {
    const f = await seed();
    const link = await testRequest().get(f.path).set("Authorization", `Bearer ${f.token}`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ humanLoginRequired: true, chatId: f.e.chatId, url: ORIGIN + f.path });
    expect(JSON.stringify(link.body)).not.toContain("sessionTag");
    const proof = await prompt(f);
    expect((await post(f.path, proof)).status).toBe(200);
    const card = await read(f.card.id);
    expect(card).toMatchObject({ status: "accepted", resolvedByUserId: "local-board", resolvedByAgentId: null, resolvedByRunId: null });
    expect((await post(f.path, proof)).status).toBe(200);
    const records = await audit(f.issueId);
    expect(records).toHaveLength(1);
    expect(records[0]?.details).toMatchObject({ humanUserId: "local-board", loginAccountId: userId, designationId: f.e.designationId, submittingAgentId: f.e.submittingAgentId, chatId: f.e.chatId, exactAnswer: "Approve", decision: "accept", question: "Approve the disposable marker test?" });
    const receipt = await testRequest().get(f.path).set("Authorization", `Bearer ${f.token}`);
    expect(receipt.body.receipt.responseId).toBe(records[0]!.details!.responseId);
    const marker = join(root, `${f.card.id}.marker`);
    await writeFile(marker, "synthetic execution after authoritative acceptance");
    expect(await readFile(marker, "utf8")).toContain("after authoritative acceptance");
    await rm(marker);
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("records exact typed answers and denial without model interpretation", async () => {
    for (const [answer, status] of [["  Approve  ", "accepted"], ["Deny", "rejected"]]) {
      const f = await seed();
      expect((await post(f.path, await prompt(f), "", answer)).status).toBe(200);
      expect((await read(f.card.id)).status).toBe(status);
      expect((await audit(f.issueId))[0]?.details?.exactAnswer).toBe(answer);
    }
  });
  it("refuses an agent POST even with the human proof and copied user id", async () => {
    const f = await seed(), proof = await prompt(f);
    const response = await testRequest().post(f.path).set("Authorization", `Bearer ${f.token}`).set("Origin", ORIGIN).type("form").send({proof,choice:"accept",answer:""});
    expect(response.status).toBe(403);
    expect((await read(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it("denies a changed target, cancellation, stale policy, forged proof and conflicting answer", async () => {
    for (const mode of ["target", "cancelled", "policy", "forged", "conflict", "origin"]) {
      const f = await seed();
      let proof = await prompt(f);
      if (mode === "target") await db.update(issues).set({ title: "Changed target", updatedAt: new Date(Date.now() + 1000) }).where(eq(issues.id, f.issueId));
      if (mode === "cancelled") await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, f.card.id));
      if (mode === "policy") { f.e.revision = "revoked-v2"; process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments); }
      if (mode === "forged") proof += "x";
      const response = mode === "origin"
        ? await testRequest().post(f.path).set("Cookie", cookie).set("Origin", "https://evil.example.test").type("form").send({proof,choice:"accept",answer:""})
        : await post(f.path, proof, "accept", mode === "conflict" ? "Deny" : "");
      expect(response.status).not.toBe(200);
      expect((await read(f.card.id)).status).toBe(mode === "cancelled" ? "cancelled" : "pending");
      expect(await audit(f.issueId)).toHaveLength(0);
    }
  });
  it("serializes concurrent replay and makes revocation effective before any later answer", async () => {
    const f = await seed(), proof = await prompt(f);
    const results = await Promise.all([post(f.path, proof), post(f.path, proof)]);
    expect(results.map(r => r.status)).toEqual([200,200]);
    expect(await audit(f.issueId)).toHaveLength(1);
    const revoked = await seed(), oldProof = await prompt(revoked);
    expect((await post(revoked.path, oldProof, "revoke")).status).toBe(200);
    // Stopping this card survives harmless enrollment serialization/revision changes.
    revoked.e.expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments);
    const browserRefusal = await testRequest().get(revoked.path).set("Cookie", cookie).set("Accept", "text/html");
    expect(browserRefusal.status).toBe(403);
    expect(browserRefusal.headers["content-type"]).toContain("text/html");
    expect(browserRefusal.text).toContain("Chat approval was revoked");
    const toolRefusal = await testRequest().get(revoked.path).set("Cookie", cookie).set("Accept", "application/json");
    expect(toolRefusal.status).toBe(403);
    expect(toolRefusal.body.error).toContain("Chat approval was revoked");
    expect((await post(revoked.path, oldProof)).status).toBe(403);
    expect((await read(revoked.card.id)).status).toBe("pending");
    expect(await audit(revoked.issueId)).toHaveLength(0);
  });
  it("requires the exact current human designation without granting the login account membership", async () => {
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, userId))).toHaveLength(0);
    for (const mode of ["changed-answer", "cancelled", "expired", "wrong-account", "foreign-designation", "missing-native-rights"]) {
      const f = await seed(), proof = await prompt(f);
      if (mode === "changed-answer") await db.update(issueThreadInteractions).set({ result: { version: 1, answers: [{ questionId: "designate-test-account", optionIds: ["bind-this-account"], otherText: "some-other-account" }] } }).where(eq(issueThreadInteractions.id, f.e.designationId));
      if (mode === "cancelled") await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, f.e.designationId));
      if (mode === "expired") f.e.expiresAt = new Date(Date.now() - 1).toISOString();
      if (mode === "wrong-account") f.e.loginAccountId = "some-other-account";
      if (mode === "foreign-designation") f.e.designationId = (await seed()).e.designationId;
      if (mode === "missing-native-rights") await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.e.companyId));
      process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments);
      expect([403, 404]).toContain((await testRequest().get(f.path).set("Cookie", cookie)).status);
      expect([403, 404]).toContain((await post(f.path, proof)).status);
      expect((await read(f.card.id)).status).toBe("pending");
      expect(await audit(f.issueId)).toHaveLength(0);
    }
  });
  it("does not reuse a designation for another test on the same issue", async () => {
    const f = await seed(), proof = await prompt(f);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const other = await issueThreadInteractionService(db).create(issue!, { kind: "request_confirmation", resolverPolicy: "human_only", addresseeUserId: "local-board", payload: { version: 1, prompt: "Approve a different marker test?" } }, { agentId: f.e.submittingAgentId });
    f.e.interactionId = other.id;
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments);
    const path = `/api/issues/${f.issueId}/interactions/${other.id}/chat-approval`;
    expect((await testRequest().get(path).set("Cookie", cookie)).status).toBe(403);
    expect((await post(path, proof)).status).toBe(403);
    expect((await read(other.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it("rechecks native rights after the route-local alias was created", async () => {
    const f = await seed(), config = readChatApprovalConfig()!;
    // Internal service boundary fixture. This is not proof of a real user's identity.
    const actor = await designatedChatApprovalActor(db, f.e, { type: "board", source: "session", chatApprovalSession: true, userId, sessionId: "synthetic-service-session" });
    const page = await presentChatApproval(db, config, f.e, actor);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, f.e.companyId));
    await expect(presentChatApproval(db, config, f.e, actor)).rejects.toMatchObject({ status: 403 });
    await expect(resolveChatApproval(db, { config, enrollment: f.e, actor, proof: page.token, origin: ORIGIN, choice: "accept", answer: "" })).rejects.toMatchObject({ status: 403 });
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.e.companyId));
    await expect(resolveChatApproval(db, { config, enrollment: f.e, actor, proof: page.token, origin: ORIGIN, choice: "accept", answer: "" })).rejects.toMatchObject({ status: 403 });
    expect((await read(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it("rolls back the native answer and all audit on a real database audit failure", async () => {
    const f = await seed(), proof = await prompt(f);
    await db.execute(sql.raw(`CREATE FUNCTION fail_chat_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'issue.chat_approval_answered' THEN RAISE EXCEPTION 'disposable audit failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER fail_chat_approval_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_chat_approval_audit()"));
    try {
      expect((await post(f.path, proof)).status).toBe(500);
      expect((await read(f.card.id)).status).toBe("pending");
      expect(await audit(f.issueId)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER fail_chat_approval_audit ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION fail_chat_approval_audit()"));
    }
    expect((await post(f.path, proof)).status).toBe(200);
  });
});
