import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiMetrics } from "../api-metrics.js";

describe("private API metrics", () => {
  it("aggregates by route template, not task IDs, query strings or request contents", async () => {
    const metrics = createApiMetrics();
    const app = express();
    app.use(metrics.middleware);
    app.post("/api/issues/:id/comments", (_req, res) => { res.status(201).json({ saved: true }); });
    await request(app).post("/api/issues/secret-task-one/comments?token=secret").send({ body: "private-text" });
    await request(app).post("/api/issues/secret-task-two/comments").send({ body: "other-private-text" });
    const text = metrics.render();
    expect(text).toContain('paperclip_api_request_duration_seconds_count{method="POST",route="/api/issues/:id/comments",status="201"} 2');
    expect(text).toContain('le="0.3"');
    expect(text).not.toMatch(/secret|private-text|token/);
  });

  it("collapses unmatched requests and variable router mounts to bounded labels", async () => {
    const metrics = createApiMetrics();
    const app = express();
    app.use(metrics.middleware);
    const router = express.Router();
    router.get("/records/:id", (_req, res) => { res.status(503).end(); });
    app.use("/api/plugins/:secretMount", router);
    await request(app).get("/api/plugins/sensitive/records/secret-id");
    await request(app).get("/api/unknown-sensitive-one");
    await request(app).get("/api/unknown-sensitive-two");
    const text = metrics.render();
    expect(text).toContain('route="/api/:mount/records/:id",status="503"');
    expect(text).toContain('route="unmatched",status="404"} 2');
    expect(text).not.toMatch(/sensitive|secret-id/);
  });

  it("exports cumulative buckets, sum, process start and closed failure counters", async () => {
    const metrics = createApiMetrics();
    const app = express();
    app.use(metrics.middleware);
    app.get("/api/health/metrics", (_req, res) => { res.type("text/plain").send(metrics.render()); });
    metrics.failure("lease_loss");
    metrics.failure("disposition_failure");
    metrics.failure("lease_loss");
    const text = (await request(app).get("/api/health/metrics")).text;
    expect(text).toContain('paperclip_control_failures_total{reason="lease_loss"} 2');
    expect(text).toContain('paperclip_control_failures_total{reason="disposition_failure"} 1');
    expect(text).toMatch(/paperclip_process_start_time_seconds [0-9.]+/);
    // Scraping is not an API operation and must not distort route latency.
    expect(metrics.render()).not.toContain('route="/api/health/metrics"');
  });
});
