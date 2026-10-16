import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { privateJsonEtag } from "../middleware/private-json-etag.js";

describe("privateJsonEtag", () => {
  it("returns 304 for unchanged private JSON and changes when the payload changes", async () => {
    let revision = 1;
    const app = express();
    app.get("/issue", privateJsonEtag(), (_req, res) => res.json({ revision }));

    const first = await request(app).get("/issue");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    expect(first.headers.etag).toBeTruthy();

    const unchanged = await request(app).get("/issue").set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");

    revision = 2;
    const changed = await request(app).get("/issue").set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
  });
});

describe("attention representation validation", () => {
  it("ignores generation time but detects feed changes and preserves the response", async () => {
    let generatedAt = "2026-10-16T14:00:00Z";
    let totalCount = 0;
    const app = express();
    app.get("/attention", privateJsonEtag({ omitGeneratedAt: true }), (_req, res) => res.json({ companyId: "company-1", generatedAt, totalCount, items: [] }));
    const first = await request(app).get("/attention");
    expect(first.body.generatedAt).toBe(generatedAt);
    generatedAt = "2026-10-16T14:01:00Z";
    const unchanged = await request(app).get("/attention").set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);
    totalCount = 1;
    const changed = await request(app).get("/attention").set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ generatedAt, totalCount: 1 });
    expect(changed.headers.etag).not.toBe(first.headers.etag);
  });
});

describe("private JSON authorization", () => {
  it("requires revalidation and checks authorization before a conditional response", async () => {
    let allowed = true;
    const app = express();
    app.get("/issues", privateJsonEtag(), (_req, res) => {
      if (!allowed) { res.status(403).json({ error: "Forbidden" }); return; }
      res.json([{ id: "issue-1" }]);
    });
    const first = await request(app).get("/issues");
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    allowed = false;
    const denied = await request(app).get("/issues").set("If-None-Match", first.headers.etag);
    expect(denied.status).toBe(403);
  });
});
