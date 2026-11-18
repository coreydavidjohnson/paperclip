import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, approvals, companies, heartbeatRuns, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalResolutionRecords } from "../lib/approval-records.js";
import type { ChiefRelay } from "../services/chief-relay-types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Chief relay approval records", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let proof: ChiefRelay;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-approval-relay-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => database?.cleanup());
  beforeEach(async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Relay approvals", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chief", role: "ceo", status: "idle" });
    proof = { agentId, companyId, representedUserId: "local-board", sourceSessionId: "source-session", sourceMessageId: "source-message",
      exactQuote: "Approve this card.", scope: "This approval", idempotencyKey: "relay-1", requestFingerprint: "request-1" };
  });
  async function create(type = "request_board_approval") {
    return (await db.insert(approvals).values({ companyId: proof.companyId, type, status: "pending", payload: { title: "Requested action" } }).returning())[0]!;
  }
  const receipts = (id: string) => db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "approval.chief_relay_resolved")));

  it.each(["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"])("records agent resolution and exact proof for %s without mutating payload", async type => {
    const approval = await create(type);
    const records = approvalResolutionRecords(db);
    const result = await records.resolveApproval(approval.id, "approved", null, "Approved", db, proof);
    expect(result).toMatchObject({ applied: true, approval: { status: "approved", decidedByUserId: null, decisionNote: "Approved", payload: approval.payload } });
    const audit = await receipts(approval.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: proof.agentId, agentId: proof.agentId, responsibleUserId: null,
      details: { chiefRelay: proof, status: "approved", decidedByUserId: null } });
    expect(await records.resolveApproval(approval.id, "approved", null, "Approved", db, proof)).toMatchObject({ applied: false });
    expect(await receipts(approval.id)).toHaveLength(1);
  });

  it("rejects an altered quote, source, scope, fingerprint, key, or note on replay", async () => {
    const approval = await create();
    const records = approvalResolutionRecords(db);
    await records.resolveApproval(approval.id, "rejected", null, "Not now", db, proof);
    for (const key of ["sourceSessionId", "sourceMessageId", "exactQuote", "scope", "representedUserId", "requestFingerprint", "idempotencyKey"] as const) {
      await expect(records.resolveApproval(approval.id, "rejected", null, "Not now", db, { ...proof, [key]: "changed" })).rejects.toThrow("chief_relay_replay_mismatch");
    }
    await expect(records.resolveApproval(approval.id, "rejected", null, "Changed note", db, proof)).rejects.toThrow("chief_relay_replay_mismatch");
    expect(await receipts(approval.id)).toHaveLength(1);
  });

  it("keeps one receipt and one applied resolution under simultaneous identical relays", async () => {
    const approval = await create();
    const records = approvalResolutionRecords(db);
    const results = await Promise.all([records.resolveApproval(approval.id, "approved", null, null, db, proof), records.resolveApproval(approval.id, "approved", null, null, db, proof)]);
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(await receipts(approval.id)).toHaveLength(1);
  });

  it("keeps one CAS winner for conflicting approve and reject relays", async () => {
    const approval = await create();
    const records = approvalResolutionRecords(db);
    const results = await Promise.allSettled([records.resolveApproval(approval.id, "approved", null, null, db, proof), records.resolveApproval(approval.id, "rejected", null, null, db, { ...proof, requestFingerprint: "other-choice" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await receipts(approval.id)).toHaveLength(1);
  });

  it("rolls the receipt and approval back together when the surrounding lifecycle transaction fails", async () => {
    const approval = await create();
    await expect(db.transaction(async tx => {
      await approvalResolutionRecords(db).resolveApproval(approval.id, "approved", null, null, tx as unknown as Db, proof, []);
      throw new Error("lifecycle failed");
    })).rejects.toThrow("lifecycle failed");
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0]?.status).toBe("pending");
    expect(await receipts(approval.id)).toHaveLength(0);
  });

  it.each(["approved", "rejected"] as const)("blocks a real cancelled run before the relay %s CAS", async status => {
    const approval = await create();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: proof.companyId, agentId: proof.agentId, status: "running", resultJson: { executionCancellation: { state: "requested" } } });
    await expect(approvalResolutionRecords(db).resolveApproval(approval.id, status, null, null, db, proof, undefined, runId)).rejects.toThrow("This run was cancelled");
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0]).toMatchObject({ status: "pending", decidedAt: null });
    expect(await receipts(approval.id)).toHaveLength(0);
  });

  it.each(["succeeded", "failed"])("rejects a real supplied run that became %s before resolution", async status => {
    const approval = await create();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: proof.companyId, agentId: proof.agentId, status });
    await expect(approvalResolutionRecords(db).resolveApproval(approval.id, "approved", null, null, db, proof, undefined, runId)).rejects.toThrow("active running run");
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0]).toMatchObject({ status: "pending", decidedAt: null });
    expect(await receipts(approval.id)).toHaveLength(0);
  });

  it("records an actual run ID, and rejects a supplied run owned by a different agent", async () => {
    const approval = await create();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: proof.companyId, agentId: proof.agentId, status: "running" });
    const otherAgentId = randomUUID();
    const foreignRunId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: proof.companyId, name: "Other agent", status: "idle" });
    await db.insert(heartbeatRuns).values({ id: foreignRunId, companyId: proof.companyId, agentId: otherAgentId, status: "running" });
    const records = approvalResolutionRecords(db);
    await expect(records.resolveApproval(approval.id, "approved", null, null, db, proof, undefined, randomUUID())).rejects.toThrow("current registered run");
    await expect(records.resolveApproval(approval.id, "approved", null, null, db, proof, undefined, foreignRunId)).rejects.toThrow("current registered run");
    await records.resolveApproval(approval.id, "approved", null, null, db, proof, undefined, runId);
    expect((await receipts(approval.id))[0]).toMatchObject({ actorType: "agent", actorId: proof.agentId, runId });
  });

  it("does not accept an unowned company or a fabricated decidedByUserId", async () => {
    const approval = await create();
    const records = approvalResolutionRecords(db);
    await expect(records.resolveApproval(approval.id, "approved", "local-board", null, db, proof)).rejects.toThrow("must not impersonate");
    await expect(records.resolveApproval(approval.id, "approved", null, null, db, { ...proof, companyId: randomUUID() })).rejects.toThrow("chief_relay_company_mismatch");
    await expect(records.resolveApproval(approval.id, "approved", null, null)).rejects.toThrow("requires a submitter");
    expect(await receipts(approval.id)).toHaveLength(0);
  });
});
