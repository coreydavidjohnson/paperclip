import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
const f = vi.hoisted(() => ({ now: 0, setReady: (_ready: boolean) => {} }));
vi.mock("../middleware/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../services/live-events-transport.js", () => ({
  createLiveEventTransport: (_db: unknown, _receive: unknown, setReady: (ready: boolean) => void) => {
    f.setReady = setReady; setReady(false);
    return { publish: vi.fn(), stop: async () => setReady(false) };
  },
}));
// Unrelated health endpoints do not participate in /ready.
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: vi.fn() }));
vi.mock("../services/workspace-readiness.js", () => ({ isManagedWorkspaceInstance: vi.fn(), resolveWorkspaceReadiness: vi.fn() }));
vi.mock("../services/native-runtime/native-restart-recovery.js", () => ({ nativeRestartRecoverySummary: vi.fn() }));
vi.mock("../services/hot-restart.js", () => ({ removeHotRestartIntent: vi.fn(), writeHotRestartIntent: vi.fn() }));
vi.mock("../dev-server-status.js", () => ({ readPersistedDevServerStatus: vi.fn(), removeDevServerRestartRequest: vi.fn(), toDevServerHealthStatus: vi.fn(), writeDevServerRestartRequest: vi.fn() }));
vi.mock("../server-info.js", () => ({ getServerInfoSnapshot: vi.fn() }));
vi.mock("../services/cloud-instance.js", () => ({ getCloudStackContext: vi.fn(), isCloudManagedInstance: vi.fn() }));
vi.mock("../services/cloud-runtime-identity.js", () => ({ getCloudRuntimeIdentity: vi.fn() }));
vi.mock("../services/database-backup-health.js", () => ({ inspectDatabaseBackupHealth: vi.fn() }));
vi.mock("../auth/workspace-login-handoff.js", () => ({ resolveWorkspaceReadinessLocalToken: vi.fn(), WORKSPACE_READINESS_TOKEN_HEADER: "fixture-token", WORKSPACE_READINESS_USER_EMAIL_HEADER: "fixture-email", WORKSPACE_READINESS_USER_ID_HEADER: "fixture-id" }));
vi.mock("../version.js", () => ({ serverVersion: "fixture" }));
async function fixture(authReady = true, noDb = false) {
  const events = await import("../services/live-events.js");
  const controller = events.startLiveEventTransport({} as Db);
  const { healthRoutes } = await import("../routes/health.js");
  const drain = await import("../controller-drain.js");
  const recovery = await import("../startup-recovery-state.js");
  const execute = vi.fn().mockResolvedValue([]);
  const app = express();
  app.use(healthRoutes(noDb ? undefined : { execute } as unknown as Db, {
    deploymentMode: "local_trusted", deploymentExposure: "private", authReady, companyDeletionEnabled: true,
  }));
  return { app, execute, controller, ...drain, ...recovery };
}
describe("GET /ready reconnect protection", () => {
  beforeEach(() => { vi.resetModules(); f.now = 0; vi.spyOn(performance, "now").mockImplementation(() => f.now); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("startup fails closed, eight seconds loss stays available, ten seconds fails, recovery succeeds", async () => {
    const e = await fixture();
    f.now += 10001;
    expect((await request(e.app).get("/ready")).status).toBe(503);
    f.setReady(true);
    expect((await request(e.app).get("/ready")).status).toBe(200);
    f.setReady(false); f.now += 8000;
    expect((await request(e.app).get("/ready")).status).toBe(200);
    f.now += 2000;
    expect((await request(e.app).get("/ready")).status).toBe(503);
    f.setReady(true);
    expect((await request(e.app).get("/ready")).status).toBe(200);
    await e.controller.stop();
    expect((await request(e.app).get("/ready")).status).toBe(503);
  });
  it("grace never masks startup recovery or controller drain", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    e.setStartupRecoveryPhase("recovering");
    expect((await request(e.app).get("/ready")).status).toBe(503);
    e.setStartupRecoveryPhase("ready");
    expect((await request(e.app).get("/ready")).status).toBe(200);
    e.beginControllerDrain();
    expect((await request(e.app).get("/ready")).status).toBe(503);
    await e.controller.stop();
  });
  it.each([[false, false], [true, true]])("authReady=%s noDb=%s stays fail closed", async (authReady, noDb) => {
    const e = await fixture(authReady, noDb); f.setReady(true); f.setReady(false);
    expect((await request(e.app).get("/ready")).status).toBe(503);
    expect(e.execute).not.toHaveBeenCalled(); await e.controller.stop();
  });
  it("database rejection is not masked by grace", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    e.execute.mockRejectedValue(new Error("fixture_database_unavailable"));
    expect((await request(e.app).get("/ready")).status).toBe(503);
    await e.controller.stop();
  });
  it("hung DB times out at two seconds and shares the outstanding probe", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    e.execute.mockImplementation(() => new Promise(() => {}));
    const first = await request(e.app).get("/ready");
    const second = await request(e.app).get("/ready");
    expect(first.status).toBe(503); expect(second.status).toBe(503);
    expect(e.execute).toHaveBeenCalledTimes(1); await e.controller.stop();
  });
  it.each(["grace", "drain", "recovery"])("rechecks %s after an in-flight DB query", async reason => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    let finish!: (rows: unknown[]) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    e.execute.mockImplementation(() => { entered(); return new Promise(r => { finish = r; }); });
    const response = request(e.app).get("/ready").then(r => r);
    await started;
    if (reason === "grace") f.now += 10000;
    if (reason === "drain") e.beginControllerDrain();
    if (reason === "recovery") e.setStartupRecoveryPhase("recovering");
    finish([]);
    expect((await response).status).toBe(503); await e.controller.stop();
  });
});
