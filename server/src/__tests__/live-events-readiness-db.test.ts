import { createServer, connect, type Socket } from "node:net";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import { startLiveEventTransport, isLiveEventTransportReady } from "../services/live-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../controller-drain.js", () => ({ isControllerDraining: () => false, beginControllerDrain: vi.fn() }));
vi.mock("../startup-recovery-state.js", () => ({ getStartupRecoveryState: () => ({ phase: "ready" }) }));

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check: () => boolean, milliseconds = 12_000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("transport_fixture_timeout");
    await delay(20);
  }
}

it("keeps real HTTP ready through a 25-second transport blackhole, then fails closed and recovers", async () => {
  const fixture = await startEmbeddedPostgresTestDatabase("transport-readiness-");
  const target = new URL(fixture.connectionString);
  const sockets = new Set<Socket>();
  let blackhole = false;
  const proxy = createServer(client => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", data => { if (!blackhole) upstream.write(data); });
    upstream.on("data", data => { if (!blackhole) client.write(data); });
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  });
  let transport: ReturnType<typeof startLiveEventTransport> | undefined;
  let transportDb: ReturnType<typeof createDb> | undefined;
  try {
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = new URL(target);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String((proxy.address() as { port: number }).port);
    transportDb = createDb(proxyUrl.toString(), { maxConnections: 1 });
    const db = createDb(fixture.connectionString, { maxConnections: 1 });
    const app = express();
    app.use("/health", healthRoutes(db));
    blackhole = true;
    transport = startLiveEventTransport(transportDb);
    expect((await request(app).get("/health/ready")).status).toBe(503);
    blackhole = false;
    for (const socket of sockets) socket.destroy();
    await until(isLiveEventTransportReady);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    blackhole = true;
    await until(() => !isLiveEventTransportReady(), 5000);
    const unavailableAt = Date.now();
    let successfulRequests = 0;
    while (Date.now() - unavailableAt < 25_000) {
      const started = Date.now();
      expect((await request(app).get("/health/ready")).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
      successfulRequests++;
      await delay(1000);
    }
    expect(successfulRequests).toBeGreaterThanOrEqual(10);
    await delay(Math.max(0, 30_100 - (Date.now() - unavailableAt)));
    expect((await request(app).get("/health/ready")).status).toBe(503);
    blackhole = false;
    for (const socket of sockets) socket.destroy();
    await until(isLiveEventTransportReady);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    await transport.stop();
    expect((await request(app).get("/health/ready")).status).toBe(503);
  } finally {
    await transport?.stop();
    for (const socket of sockets) socket.destroy();
    await transportDb?.$client.end({ timeout: 0 });
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await fixture.cleanup();
  }
}, 90_000);
