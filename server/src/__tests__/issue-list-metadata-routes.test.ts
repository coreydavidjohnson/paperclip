import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue list optional metadata", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-list-metadata-", {
    resetEach: resetCompanyIssueFixtures,
  });

  it.each([
    ["", "blocked"],
    ["&touchedByUserId=me", "blocked"],
    ["&attention=blocked", "blocked"],
    ["", "in_review"],
    ["&view=compact", "in_review"],
  ])(
    "preserves default metadata and UI-read fields when opting out (%s, %s)",
    async (context, status) => {
      const company = await seedCompanyWithBoardAccess(ctx.db, "List metadata");
      const id = randomUUID();
      const descriptor = { owner: "board", action: "Inspect the blocked fixture" };
      await ctx.db.insert(issues).values({
        id, companyId: company.companyId, title: "Blocked fixture",
        status, priority: "medium",
        assigneeUserId: company.actor.userId,
        createdByUserId: company.actor.userId,
        description: "Keep the list description preview",
        unblockDescriptor: status === "blocked" ? descriptor : null,
      });
      const app = routeApp(ctx.db, company.actor, issueRoutes);
      const path = `/api/companies/${company.companyId}/issues?limit=25${context}`;
      const full = await request(app).get(path).expect(200);
      const explicit = await request(app)
        .get(`${path}&includeReviewAttention=true&includeUnblockDescriptor=true`).expect(200);
      const slim = await request(app)
        .get(`${path}&includeReviewAttention=false&includeUnblockDescriptor=false`).expect(200);
      const noReview = await request(app)
        .get(`${path}&includeReviewAttention=0`).expect(200);
      expect(noReview.body[0]).not.toHaveProperty("reviewAttention");
      if (!context.includes("view=compact")) {
        expect(noReview.body[0].unblockDescriptor).toEqual(full.body[0].unblockDescriptor);
        const noDescriptor = await request(app)
          .get(`${path}&includeUnblockDescriptor=0`).expect(200);
        expect(noDescriptor.body[0].unblockDescriptor).toBeNull();
        expect(noDescriptor.body[0].reviewAttention).toEqual(full.body[0].reviewAttention);
      }
      expect(full.body).toHaveLength(1);
      expect(explicit.body).toEqual(full.body);
      if (!context.includes("view=compact")) {
        expect(full.body[0].unblockDescriptor).toEqual(status === "blocked" ? descriptor : null);
        expect(slim.body[0].unblockDescriptor).toBeNull();
      }
      expect(full.body[0].reviewAttention).toEqual(expect.objectContaining({ paths: expect.any(Array) }));
      expect(slim.body[0]).not.toHaveProperty("reviewAttention");
      const { reviewAttention: _review, unblockDescriptor: _descriptor, ...rest } = full.body[0];
      expect(slim.body[0]).toEqual(context.includes("view=compact")
        ? rest
        : { ...rest, unblockDescriptor: null });
      expect(slim.body[0].blockerAttention).toEqual(full.body[0].blockerAttention);
      expect(slim.body[0].description).toBe(full.body[0].description);
      expect(JSON.stringify(slim.body).length).toBeLessThan(JSON.stringify(full.body).length);
    },
  );

  it("preserves company authorization for slim requests", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Allowed metadata");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other metadata");
    await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${other.companyId}/issues?includeReviewAttention=false&includeUnblockDescriptor=false`)
      .expect(403);
  });

  it.each(["includeReviewAttention", "includeUnblockDescriptor"])(
    "rejects invalid or repeated %s instead of silently changing the projection",
    async (key) => {
      const company = await seedCompanyWithBoardAccess(ctx.db, "List metadata validation");
      const app = routeApp(ctx.db, company.actor, issueRoutes);
      const path = `/api/companies/${company.companyId}/issues`;
      await request(app).get(`${path}?${key}=invalid`).expect(400);
      await request(app).get(`${path}?${key}=true&${key}=false`).expect(400);
    },
  );
});
