import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companySecretBindings, companySecretProposals, companySecretProviderConfigs, companySecretVersions, companySecrets, userSecretDeclarations, userSecretDefinitions, createDb, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import type { ChiefRelay } from "../services/chief-relay-types.js";
import { assertCanResolveProposal } from "../services/secret-proposal-authorization.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("Chief relay secret proposal service", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-chief-relay-${randomUUID()}`);
  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("chief-relay-secret-proposals");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretProposals);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretProviderConfigs);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret proposals",
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: `SEC-${issueId}`,
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  async function chiefRelayBindingFixture() {
    const fixture = await seedRun();
    const [chief] = await db.insert(agents).values({ companyId: fixture.companyId, name: "Chief", role: "ceo", adapterType: "process" }).returning();
    const svc = createSecretProposalsService(db);
    const context = { companyId: fixture.companyId, heartbeatRunId: fixture.heartbeatRunId, registerForRedaction: () => {} };
    const secret = await svc.createSecret(context, { name: "dev/relay/token", value: "synthetic-fixture-value", justification: "Needed for fixture" });
    const binding = await svc.createBinding(context, { secretProposalId: secret.id, configPath: "env.RELAY_TOKEN", justification: "Bind fixture", bindingTargetPolicy: "self_and_reports" });
    const chiefRelay: ChiefRelay = { agentId: chief.id, companyId: fixture.companyId, representedUserId: "corey",
      sourceSessionId: "owned-chief-chat", sourceMessageId: "message-1498", exactQuote: "Approve this credential binding.",
      scope: "This binding and its prerequisite", idempotencyKey: randomUUID(), requestFingerprint: "binding-fingerprint" };
    const [chiefRun] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: chief.id, status: "running" }).returning();
    const actor = { agentId: chief.id, userId: null, runId: chiefRun.id, chiefRelay };
    return { ...fixture, svc, secret, binding, actor };
  }

  it("Chief relay credential approval rejects ordinary agents and mismatched actor or company proof", async () => {
    const f = await chiefRelayBindingFixture();
    await expect(f.svc.approve(f.companyId, f.binding.id, { actor: { agentId: f.agentId }, cascade: true })).rejects.toMatchObject({ status: 403 });
    for (const chiefRelay of [{ ...f.actor.chiefRelay, companyId: randomUUID() }, { ...f.actor.chiefRelay, agentId: f.agentId }]) {
      await expect(f.svc.approve(f.companyId, f.binding.id, { actor: { ...f.actor, chiefRelay }, cascade: true })).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, resolvedByUserId: "board", cascade: true })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByUserId: null });
  });

  it("Chief relay credential approval persists exact proof and real resolver atomically with binding effects", async () => {
    const f = await chiefRelayBindingFixture();
    const approved = await f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true,
      assertCanResolve: (proposal, txDb) => assertCanResolveProposal({ db: txDb, actor: { type: "agent", agentId: f.actor.agentId, companyId: f.companyId }, companyId: f.companyId, chiefRelay: f.actor.chiefRelay, proposal }) });
    expect(approved).toMatchObject({ status: "approved", resolvedByUserId: null, appliedBindingConfigPath: "env.RELAY_TOKEN" });
    const [secret] = await db.select().from(companySecrets);
    expect(secret).toMatchObject({ createdByAgentId: f.actor.agentId, createdByUserId: null });
    expect(await db.select().from(companySecretBindings)).toEqual([expect.objectContaining({ secretId: secret.id, targetId: f.agentId, configPath: "env.RELAY_TOKEN" })]);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].adapterConfig).toMatchObject({ env: { RELAY_TOKEN: { type: "secret_ref", secretId: secret.id } } });
    const [interaction] = await db.select().from(issueThreadInteractions);
    expect(interaction).toMatchObject({ status: "accepted", resolvedByAgentId: f.actor.agentId, resolvedByRunId: f.actor.runId, resolvedByUserId: null, result: { outcome: "accepted", secretProposal: { status: "executed" } } });
    expect((interaction.result as Record<string, unknown>).chiefRelay).toEqual(f.actor.chiefRelay);
    const approvals = await db.select().from(activityLog).where(eq(activityLog.action, "secret.proposal.approved"));
    expect(approvals).toHaveLength(2);
    for (const approval of approvals) expect(approval).toMatchObject({ actorType: "agent", actorId: f.actor.agentId, agentId: f.actor.agentId, runId: f.actor.runId });
  });

  it("Chief relay credential approval rolls back when target configuration became stale", async () => {
    const f = await chiefRelayBindingFixture();
    await db.update(agents).set({ adapterConfig: { env: { RELAY_TOKEN: "already-occupied" } } }).where(eq(agents.id, f.agentId));
    await expect(f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true })).rejects.toThrow("Agent config path already exists");
    expect((await f.svc.getById(f.companyId, f.binding.id))?.status).toBe("pending");
    // Existing two-phase behavior intentionally retains the approved prerequisite.
    expect((await f.svc.getById(f.companyId, f.secret.id))?.status).toBe("approved");
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByUserId: null });
  });

  it("Chief relay credential approval rejects mismatched and terminal actual actor runs before effects", async () => {
    const f = await chiefRelayBindingFixture();
    for (const runId of [f.heartbeatRunId, randomUUID()]) {
      await expect(f.svc.approve(f.companyId, f.binding.id, { actor: { ...f.actor, runId }, cascade: true })).rejects.toMatchObject({ status: 403 });
    }
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.actor.runId));
      await expect(f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true })).rejects.toMatchObject({ status: 403 });
    }
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "secret.proposal.approved"))).toHaveLength(0);
  });

  it("Chief relay credential approval serializes against actual run cancellation", async () => {
    const f = await chiefRelayBindingFixture();
    let signalLocked!: () => void;
    let releaseStop!: () => void;
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseStop = resolve; });
    const stopping = db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.actor.runId));
      signalLocked();
      await release;
    });
    await locked;
    const approval = f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock'
            AND query ILIKE '%heartbeat_runs%' AND query ILIKE '%for share%'
        ) AS waiting`);
        if (row?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } finally {
      releaseStop();
      await stopping;
    }
    expect(waiting).toBe(true);
    expect((await approval).error).toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByRunId: null });
  });

  it("Chief relay credential binding rechecks cancellation after the prerequisite phase", async () => {
    const f = await chiefRelayBindingFixture();
    let checks = 0;
    await expect(f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true, assertCanResolve: async (_proposal, txDb) => {
      checks++;
      // Simulate Stop taking effect at the boundary before the binding transaction.
      await txDb.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.actor.runId));
    } })).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect(checks).toBe(1);
    expect((await f.svc.getById(f.companyId, f.secret.id))?.status).toBe("approved");
    expect((await f.svc.getById(f.companyId, f.binding.id))?.status).toBe("pending");
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByRunId: null });
  });

  it("Chief relay credential approval preserves expiry denial before any effects", async () => {
    const f = await chiefRelayBindingFixture();
    await db.update(companySecretProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(companySecretProposals.id, f.binding.id));
    await expect(f.svc.approve(f.companyId, f.binding.id, { actor: f.actor, cascade: true })).rejects.toThrow("Expired proposals cannot be approved");
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("pending");
  });

});
