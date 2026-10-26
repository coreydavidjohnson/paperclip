import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { approvalService } from "../services/approvals.js";
import { activityLog, approvals, issueApprovals, issueComments, issueRecoveryActions, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("blocked needs a first-class wait (PER-626)", () => {
  const ctx = useEmbeddedPostgres("paperclip-blocked-wait-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issueApprovals);
      await db.delete(approvals);
      await resetCompanyIssueFixtures(db);
    },
  });
  async function fixture(status = "todo") {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Blocked wait");
    const [issue] = await ctx.db.insert(issues).values({ companyId: company.companyId, title: "Dependent", status }).returning();
    return { ...company, issue, svc: issueService(ctx.db) };
  }

  it("rejects descriptor-only blocked creation and rolls the insert back", async () => {
    const { companyId, svc } = await fixture();
    await expect(svc.create(companyId, { title: "Invalid wait", status: "blocked", unblockDescriptor: { owner: "board", action: "Wait for CI" } })).rejects.toMatchObject({ status: 422 });
    const rows = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows.map(row => row.title)).toEqual(["Dependent"]);
  });

  it("does not insert a blocked issue when an outer transaction catches the rejection", async () => {
    const { companyId } = await fixture();
    await ctx.db.transaction(async (tx) => {
      const svc = issueService(tx as unknown as typeof ctx.db);
      await expect(svc.create(companyId, { title: "Caught invalid wait", status: "blocked" }))
        .rejects.toMatchObject({ status: 422, details: { code: "blocked_wait_required" } });
      const rows = await tx.select().from(issues).where(eq(issues.companyId, companyId));
      expect(rows.map(row => row.title)).toEqual(["Dependent"]);
    });
  });

  it.each(["todo", "blocked"])("rejects entering/reasserting blocked from %s, even with prose", async (status) => {
    const { issue, svc } = await fixture(status);
    await expect(svc.update(issue.id, { status: "blocked", unblockDescriptor: { owner: "board", action: "Wait for X" } }))
      .rejects.toMatchObject({ status: 422, details: { code: "blocked_wait_required" } });
    const [after] = await ctx.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.status).toBe(status);
    expect(after.unblockDescriptor).toBeNull();
  });

  it("accepts a linked blocker and rejects removing the final link atomically", async () => {
    const { companyId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "CI owner", status: "todo" });
    await expect(svc.update(issue.id, { status: "blocked", blockedByIssueIds: [blocker.id] })).resolves.toMatchObject({ status: "blocked" });
    await expect(svc.update(issue.id, { blockedByIssueIds: [] })).rejects.toMatchObject({ status: 422 });
    expect((await svc.getRelationSummaries(issue.id)).blockedBy.map(b => b.id)).toEqual([blocker.id]);
    await expect(svc.update(issue.id, { status: "todo", blockedByIssueIds: [] })).resolves.toMatchObject({ status: "todo" });
  });

  it("refuses deleting a blocked dependent's last blocker without cascading away its wait", async () => {
    const { companyId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Do not strand dependent" });
    await svc.update(issue.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
    await expect(svc.remove(blocker.id))
      .rejects.toMatchObject({ status: 422, details: { code: "blocked_wait_required", issueId: issue.id } });
    expect((await svc.getRelationSummaries(issue.id)).blockedBy.map(b => b.id)).toEqual([blocker.id]);
    expect(await svc.getById(blocker.id)).not.toBeNull();
  });

  it.each(["card", "dependency"])("allows blocker deletion when another %s preserves the wait", async (kind) => {
    const { companyId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Removable dependency" });
    await svc.update(issue.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
    const alternate = kind === "dependency"
      ? await svc.create(companyId, { title: "Alternate wait" }) : null;
    if (alternate) {
      await svc.update(issue.id, { blockedByIssueIds: [blocker.id, alternate.id] });
    } else {
      await ctx.db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
        kind: "ask_user_questions", payload: { questions: [] } as never });
    }
    await expect(svc.remove(blocker.id)).resolves.toMatchObject({ id: blocker.id });
    expect((await svc.getRelationSummaries(issue.id)).blockedBy.map(b => b.id))
      .toEqual(alternate ? [alternate.id] : []);
  });

  it("rejects done and foreign-company blockers", async () => {
    const { companyId, issue, svc } = await fixture();
    const done = await svc.create(companyId, { title: "Finished CI", status: "done" });
    await expect(svc.update(issue.id, { status: "blocked", blockedByIssueIds: [done.id] })).rejects.toMatchObject({ status: 422 });
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other company");
    const foreign = await svc.create(other.companyId, { title: "Foreign CI" });
    await expect(svc.update(issue.id, { status: "blocked", blockedByIssueIds: [foreign.id] })).rejects.toMatchObject({ status: 422 });
  });

  it("keeps native cancelled-blocker semantics", async () => {
    const { companyId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Cancelled owner", status: "cancelled" });
    await expect(svc.update(issue.id, { status: "blocked", blockedByIssueIds: [blocker.id] })).resolves.toMatchObject({ status: "blocked" });
  });

  it("accepts a pending question, not a resolved question or another issue's card", async () => {
    const { companyId, issue, svc } = await fixture();
    const [card] = await ctx.db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", payload: { questions: [] } as never }).returning();
    await expect(svc.update(issue.id, { status: "blocked" })).resolves.toMatchObject({ status: "blocked" });
    await ctx.db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, card.id));
    await expect(svc.update(issue.id, { status: "blocked" })).rejects.toMatchObject({ status: 422 });
    const other = await svc.create(companyId, { title: "Other task" });
    await ctx.db.insert(issueThreadInteractions).values({ companyId, issueId: other.id, kind: "ask_user_questions", payload: { questions: [] } as never });
    await expect(svc.update(issue.id, { status: "blocked" })).rejects.toMatchObject({ status: 422 });
  });

  it.each(["ask_user_questions", "request_confirmation"])("uses current question semantics without releasing %s gates", async (kind) => {
    const { companyId, issue, svc, userId } = await fixture();
    await ctx.db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: kind as "ask_user_questions" | "request_confirmation", payload: { questions: [] } as never,
      createdAt: new Date(Date.now() - 10_000) });
    await ctx.db.insert(issueComments).values({ companyId, issueId: issue.id,
      body: "Continue the other work. The old question no longer applies.",
      authorType: "user", authorUserId: userId });
    if (kind === "ask_user_questions") {
      await expect(svc.update(issue.id, { status: "blocked" }))
        .rejects.toMatchObject({ status: 422, details: { code: "blocked_wait_required" } });
    } else {
      await expect(svc.update(issue.id, { status: "blocked" })).resolves.toMatchObject({ status: "blocked" });
    }
  });

  it("does not treat a real Board recovery decision as a blocked prerequisite", async () => {
    const { companyId, issue, svc } = await fixture();
    await ctx.db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "deliberate_wait_without_target", cause: "deliberate_wait_without_target",
      ownerType: "board", fingerprint: "exhausted-repair", nextAction: "Inspect failed repair evidence",
      wakePolicy: { type: "board_escalation" } });
    await expect(svc.update(issue.id, { status: "blocked" }))
      .rejects.toMatchObject({ status: 422, details: { code: "blocked_wait_required" } });
  });
  it("preserves pending approval cards", async () => {
    const { companyId, issue, svc } = await fixture();
    const [approval] = await ctx.db.insert(approvals).values({ companyId, type: "test", status: "pending", payload: {} }).returning();
    await ctx.db.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId: approval.id });
    await expect(svc.update(issue.id, { status: "blocked" })).resolves.toMatchObject({ status: "blocked" });
  });

  it("preserves a revision-requested approval when reasserting blocked or deleting its last ticket", async () => {
    const { companyId, userId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Alternate dependency" });
    const [approval] = await ctx.db.insert(approvals).values({ companyId, type: "test", status: "pending", payload: {} }).returning();
    await ctx.db.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId: approval.id });
    await approvalService(ctx.db).requestRevision(approval.id, userId, "Revise before approval");
    await expect(svc.update(issue.id, { status: "blocked" })).resolves.toMatchObject({ status: "blocked" });
    await svc.update(issue.id, { blockedByIssueIds: [blocker.id] });
    await expect(svc.remove(blocker.id)).resolves.toMatchObject({ id: blocker.id });
    expect((await svc.getRelationSummaries(issue.id)).blockedBy).toEqual([]);
    const [preserved] = await ctx.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(preserved.status).toBe("revision_requested");
    await approvalService(ctx.db).cancel(approval.id, "Withdraw gate");
    await expect(svc.update(issue.id, { status: "blocked" })).rejects.toMatchObject({ status: 422 });
  });

  it.each(["create", "update"])("rechecks a proposed blocker after concurrent completion before blocked %s", async (mode) => {
    const { companyId, issue, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Completing dependency", status: "todo" });
    let releaseCompletion!: () => void;
    const completionReleased = new Promise<void>(resolve => { releaseCompletion = resolve; });
    let reportLocked!: () => void;
    const locked = new Promise<void>(resolve => { reportLocked = resolve; });
    const completion = ctx.db.transaction(async tx => {
      await tx.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, blocker.id));
      reportLocked();
      await completionReleased;
    });
    await locked;
    let reportWriter!: (pid: number) => void;
    const writerReady = new Promise<number>(resolve => { reportWriter = resolve; });
    const attempt = ctx.db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      reportWriter(Number(backend.pid));
      const writer = issueService(tx as unknown as typeof ctx.db);
      try {
        if (mode === "create") {
          await writer.create(companyId, { title: "Concurrent blocked creation", status: "blocked", blockedByIssueIds: [blocker.id] });
        } else {
          await writer.update(issue.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
        }
        return { error: null };
      } catch (error) {
        // A caught creation failure must not retain a partial insert in this transaction.
        return { error };
      }
    });
    try {
      const pid = await writerReady;
      await expect.poll(async () => {
        const [waiting] = await ctx.db.execute(sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`);
        return waiting.blocked;
      }, { timeout: 5000 }).toBe(true);
    } finally {
      releaseCompletion();
      await completion;
    }
    const result = await attempt;
    expect(result.error).toMatchObject({ status: 422, details: { code: "blocked_wait_required" } });
    expect((await svc.getRelationSummaries(issue.id)).blockedBy).toEqual([]);
    expect((await svc.getById(issue.id))?.status).toBe("todo");
    const rows = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows.some(row => row.title === "Concurrent blocked creation")).toBe(false);
  });

  it("rejects descriptor-only HTTP repeated blocked writes", async () => {
    const { issue, actor } = await fixture("blocked");
    const response = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked", unblockDescriptor: { owner: "board", action: "Wait for CI" } }).expect(422);
    expect(response.body.details).toMatchObject({ code: "blocked_wait_required" });
  });

  it("accepts a real blocker through HTTP and rejects descriptor-only HTTP creation", async () => {
    const { companyId, issue, actor, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Build owner", status: "todo" });
    const app = routeApp(ctx.db, actor, issueRoutes);
    await request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked", blockedByIssueIds: [blocker.id] }).expect(200);
    await request(app).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Valid wait target", status: "blocked", blockedByIssueIds: [blocker.id] }).expect(201);
    await request(app).post(`/api/companies/${companyId}/issues`)
      .send({ title: "No wait target", status: "blocked", unblockDescriptor: { owner: "board", action: "Wait" } }).expect(422);
  });

  it("returns blocker links by default with list/detail agreement", async () => {
    const { companyId, issue, actor } = await fixture("blocked");
    const [blocker] = await ctx.db.insert(issues).values({ companyId, title: "Real CI owner", identifier: "TST-1125", status: "todo" }).returning();
    await ctx.db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
    const app = routeApp(ctx.db, actor, issueRoutes);
    const detail = await request(app).get(`/api/issues/${issue.id}`).expect(200);
    for (const suffix of ["", "?view=compact"]) {
      const response = await request(app).get(`/api/companies/${companyId}/issues${suffix}`).expect(200);
      const row = response.body.find((r: { id: string }) => r.id === issue.id);
      expect(row.blockedBy.map((b: { id: string }) => b.id)).toEqual(detail.body.blockedBy.map((b: { id: string }) => b.id));
      expect(row.blockedBy[0]).toMatchObject({ id: blocker.id, identifier: "TST-1125" });
    }
    const slim = await request(app).get(`/api/companies/${companyId}/issues?includeBlockedBy=false`).expect(200);
    expect(slim.body.find((r: { id: string }) => r.id === issue.id)).not.toHaveProperty("blockedBy");
  });
});
