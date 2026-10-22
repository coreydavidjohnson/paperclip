import { afterAll, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createDb, persistentDedicatedDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { healthRoutes } from "../routes/health.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/live-events.js", () => ({ isLiveEventTransportReady: () => true }));
vi.mock("../controller-drain.js", () => ({ isControllerDraining: () => false, beginControllerDrain: vi.fn() }));
vi.mock("../startup-recovery-state.js", () => ({ getStartupRecoveryState: () => ({ phase: "ready" }) }));

let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  fixture = await startEmbeddedPostgresTestDatabase("readiness-isolation-");
  db = createDb(fixture.connectionString, { maxConnections: 1 });
}, 90_000);
afterAll(async () => { await fixture?.cleanup(); });

it("isolates readiness from a held shared pool, but not from its own unavailable connection", async () => {
  const app = express();
  app.use("/health", healthRoutes(db));
  const heldShared = await db.$client.reserve();
  let sharedSettled = false;
  const queued = db.execute(sql`select 1`).then(() => { sharedSettled = true; });
  try {
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect(sharedSettled).toBe(false);
    const dedicated = persistentDedicatedDb(db, "paperclip-readiness")!;
    expect(dedicated.$client.options.max).toBe(1);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect(persistentDedicatedDb(db, "paperclip-readiness")).toBe(dedicated);
    expect((await dedicated.execute(sql`select count(*)::int as n from pg_stat_activity
      where application_name = 'paperclip-readiness' and backend_type = 'client backend'`))[0].n).toBe(1);
    const heldProbe = await dedicated.$client.reserve();
    try {
      const failed = await request(app).get("/health/ready");
      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({ ready: false });
    } finally { heldProbe.release(); }
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect(sharedSettled).toBe(false);
  } finally { heldShared.release(); await queued; }
});
