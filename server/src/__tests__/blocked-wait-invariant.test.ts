import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, approvals, issueApprovals, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("blocked needs a first-class wait (PER-626)", () => {
  const ctx = useEmbeddedPostgres("paperclip-blocked-wait-", { resetEach: async (db) => { await db.delete(activityLog); await db.delete(issueApprovals); await db.delete(approvals); await resetCompanyIssueFixtures(db); } });
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

  it.each(["todo", "blocked"])("rejects entering/reasserting blocked from %s, even with prose", async (status) => {
    const { issue, svc } = await fixture(status);
    await expect(svc.update(issue.id, { status: "blocked", unblockDescriptor: { owner: "board", action: "Wait for X" } })).rejects.toMatchObject({ status: 422 });
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

  it("preserves pending approval cards", async () => {
    const { companyId, issue, svc } = await fixture();
    const [approval] = await ctx.db.insert(approvals).values({ companyId, type: "test", status: "pending", payload: {} }).returning();
    await ctx.db.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId: approval.id });
    await expect(svc.update(issue.id, { status: "blocked" })).resolves.toMatchObject({ status: "blocked" });
  });

  it("rejects descriptor-only HTTP repeated blocked writes", async () => {
    const { issue, actor } = await fixture("blocked");
    await request(routeApp(ctx.db, actor, issueRoutes)).patch(`/api/issues/${issue.id}`).send({ status: "blocked", unblockDescriptor: { owner: "board", action: "Wait for CI" } }).expect(422);
  });

  it("accepts a real blocker through HTTP and rejects descriptor-only HTTP creation", async () => {
    const { companyId, issue, actor, svc } = await fixture();
    const blocker = await svc.create(companyId, { title: "Build owner", status: "todo" });
    const app = routeApp(ctx.db, actor, issueRoutes);
    await request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked", blockedByIssueIds: [blocker.id] }).expect(200);
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
