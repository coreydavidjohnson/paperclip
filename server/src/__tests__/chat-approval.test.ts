import express from "express";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import type { Enrollment } from "../services/chat-approval-proof.js";

const ORIGIN = "https://approval.example.test";
const envNames = ["BETTER_AUTH_SECRET", "PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_CHAT_APPROVAL_ENABLED", "PAPERCLIP_CHAT_APPROVAL_ORIGIN", "PAPERCLIP_CHAT_APPROVAL_HMAC_KEY", "PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS"] as const;
const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
// No support-based skip: this proof needs real Postgres and real human login.
describe("isolated chat approval with native authentication and persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let root: string;
  let cookie: string;
  let userId: string;
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
    const auth = createBetterAuthInstance(db, { deploymentMode: "authenticated", deploymentExposure: "private",
      authBaseUrlMode: "explicit", authPublicBaseUrl: ORIGIN, authDisableSignUp: false,
      allowedHostnames: ["127.0.0.1", "approval.example.test"], port: 0 } as unknown as Config, [ORIGIN]);
    app = await createApp(db, { uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "authenticated", deploymentExposure: "private", allowedHostnames: ["127.0.0.1", "approval.example.test"],
      bindHost: "127.0.0.1", authPublicBaseUrl: ORIGIN, authReady: true, companyDeletionEnabled: false,
      instanceId: `chat-approval-${randomUUID()}`, localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      betterAuthHandler: createBetterAuthHandler(auth), resolveSession: req => resolveBetterAuthSession(auth, req),
    });
    const signup = await testRequest().post("/api/auth/sign-up/email").set("Origin", ORIGIN)
      .send({ email: "synthetic-human@fixture.invalid", password: randomBytes(24).toString("hex"), name: "Synthetic human" });
    expect(signup.status, signup.text).toBe(200);
    userId = signup.body.user.id;
    const cookies = signup.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies : [cookies]).map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
  }, 120_000);
  afterAll(async () => {
    await app?.locals.paperclipShutdown();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    for (const name of envNames) { if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name]; }
  });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic approval", issuePrefix: companyId.slice(0, 8) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic coordinator", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic no-op approval", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native", responsibleUserId: userId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const card = await issueThreadInteractionService(db).create(issue!, { kind: "request_confirmation", resolverPolicy: "human_only", payload: { version: 1, prompt: "Approve the disposable marker test?", detailsMarkdown: "Synthetic data. No outside effects." } }, { agentId });
    const e: Enrollment = { companyId, issueId, interactionId: card.id, userId, chatId: `synthetic-chat-${randomUUID()}`, submittingAgentId: agentId,
      revision: "disposable-v1", action: "Write a synthetic marker", target: "Disposable test directory", scope: "Synthetic data only. No production access.", undo: "Remove the synthetic marker", effect: "synthetic_test_only" };
    enrollments.push(e);
    process.env.PAPERCLIP_CHAT_APPROVAL_ENROLLMENTS = JSON.stringify(enrollments);
    const path = `/api/issues/${issueId}/interactions/${card.id}/chat-approval`;
    const token = createLocalAgentJwt(agentId, companyId, "paperclip_runner", runId, userId);
    return { e, path, token, card, issueId };
  }
  async function prompt(f: Awaited<ReturnType<typeof seed>>) {
    const page = await testRequest().get(f.path).set("Cookie", cookie);
    expect(page.status, page.text).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
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

  it("opens one existing card from the agent route, accepts a real login answer, and retries once without a second audit", async () => {
    const f = await seed();
    const link = await testRequest().get(f.path).set("Authorization", `Bearer ${f.token}`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ humanLoginRequired: true, chatId: f.e.chatId, url: ORIGIN + f.path });
    expect(JSON.stringify(link.body)).not.toContain("sessionTag");
    const proof = await prompt(f);
    expect((await post(f.path, proof)).status).toBe(200);
    const card = await read(f.card.id);
    expect(card).toMatchObject({ status: "accepted", resolvedByUserId: userId, resolvedByAgentId: null, resolvedByRunId: null });
    expect((await post(f.path, proof)).status).toBe(200);
    const records = await audit(f.issueId);
    expect(records).toHaveLength(1);
    expect(records[0]?.details).toMatchObject({ humanUserId: userId, submittingAgentId: f.e.submittingAgentId, chatId: f.e.chatId, exactAnswer: "Approve", decision: "accept", question: "Approve the disposable marker test?" });
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
    expect((await post(revoked.path, oldProof)).status).not.toBe(200);
    expect((await read(revoked.card.id)).status).toBe("pending");
    expect(await audit(revoked.issueId)).toHaveLength(0);
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
