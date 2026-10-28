import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const { driver, warn, info } = vi.hoisted(() => ({ driver: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn, info } }));
vi.mock("@paperclipai/db", () => ({ postgres: driver }));
import { createLiveEventTransport } from "../services/live-events-transport.js";

describe("dedicated live-event session options and epochs", () => {
  beforeEach(() => { vi.useFakeTimers(); driver.mockReset(); warn.mockReset(); info.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  const event = { id: 1, companyId: "a", type: "activity.logged" as const, createdAt: "2026-10-14T00:00:00Z", payload: {} };
  function fixture(listen = () => Promise.resolve([])) {
    const clients: { unsafe: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
    const options: any[] = [];
    driver.mockImplementation((option: any) => {
      options.push(option);
      const client = { unsafe: vi.fn(listen), notify: vi.fn(() => Promise.resolve([])), end: vi.fn(() => Promise.resolve()) };
      clients.push(client); return client;
    });
    const password = () => Promise.resolve("synthetic-password");
    const ssl = { rejectUnauthorized: true, ca: "synthetic-ca" };
    const socket = vi.fn();
    const pool = { options: { host: ["pg-a", "pg-b"], port: [5432, 5433], database: "synthetic", user: "fixture", pass: password, ssl, socket,
      target_session_attrs: "primary", shared: { retries: 42, typeArrayMap: {} },
      connection: { search_path: "fixture", application_name: "pool", statement_timeout: 99999 },
      max: 20, max_pipeline: 100, idle_timeout: 30, max_lifetime: () => 100,
    } };
    const ready = vi.fn(), receive = vi.fn(), resync = vi.fn();
    const transport = createLiveEventTransport({ $client: pool } as unknown as Db, receive, ready, resync);
    return { clients, options, pool, password, ssl, socket, transport, ready, receive, resync };
  }
  it("keeps API readiness for a short reconnect, without extending grace on failed retries", async () => {
    const fixtureState = fixture();
    expect(fixtureState.transport.isReadyForRequests()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixtureState.transport.isReadyForRequests()).toBe(true);
    fixtureState.options[0].onclose();
    driver.mockImplementation(() => ({
      unsafe: vi.fn(() => Promise.reject(new Error("unavailable"))),
      notify: vi.fn(), end: vi.fn(() => Promise.resolve()),
    }));
    await vi.advanceTimersByTimeAsync(29999);
    expect(fixtureState.ready).toHaveBeenLastCalledWith(false);
    expect(fixtureState.transport.isReadyForRequests()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixtureState.transport.isReadyForRequests()).toBe(false);
    driver.mockImplementation(() => ({
      unsafe: vi.fn(() => Promise.resolve([])), notify: vi.fn(), end: vi.fn(() => Promise.resolve()),
    }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixtureState.transport.isReadyForRequests()).toBe(true);
    await fixtureState.transport.stop();
    expect(fixtureState.transport.isReadyForRequests()).toBe(false);
  });
  it("logs state changes once, with reasons and elapsed time but no event payload", async () => {
    const fixtureState = fixture();
    await vi.advanceTimersByTimeAsync(2000);
    fixtureState.options[0].onclose();
    fixtureState.options[0].onclose();
    await vi.advanceTimersByTimeAsync(1000);
    await fixtureState.transport.stop();
    const changes = info.mock.calls.filter(call => call[1] === "live_event_transport_readiness_changed");
    expect(changes.map(call => [call[0].ready, call[0].reason])).toEqual([
      [false, "starting"], [true, "connected"], [false, "close"], [true, "reconnected"], [false, "stopped"],
    ]);
    expect(changes[2][0]).toMatchObject({ previous_ready: true, previous_state_ms: 2000 });
    expect(changes[3][0]).toMatchObject({ previous_ready: false, previous_state_ms: 1000 });
    expect(changes.every(call => !Object.hasOwn(call[0], "payload"))).toBe(true);
  });
  it("reparses resolved credentials/TLS/multi-host options without sharing pool state", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const option = f.options[0];
    expect(option).not.toHaveProperty("shared");
    expect(option.pass).toBe(f.password); expect(option.ssl).toBe(f.ssl); expect(option.socket).toBe(f.socket);
    expect(option.host).toEqual(["pg-a", "pg-b"]); expect(option.port).toEqual([5432, 5433]);
    expect(option.target_session_attrs).toBe("primary");
    expect(option).toMatchObject({ max: 1, max_pipeline: 1, prepare: false, idle_timeout: 0, max_lifetime: 0, connect_timeout: 2, fetch_types: false,
      connection: { search_path: "fixture", application_name: "paperclip-live-events", statement_timeout: 2000 } });
    expect(f.pool.options.shared.retries).toBe(42);
    expect(f.pool.options.connection.application_name).toBe("pool");
    await f.transport.stop();
  });
  it("ignores stale disconnect/notification/probe completions and cannot revive after stop", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.options[0].onclose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.options).toHaveLength(2); expect(f.ready).toHaveBeenLastCalledWith(true);
    f.options[0].onclose();
    f.options[0].onnotify("paperclip_ui_events_v1", JSON.stringify({ origin: "00000000-0000-0000-0000-000000000001", sequence: 1, event }));
    expect(f.receive).not.toHaveBeenCalled(); expect(f.ready).toHaveBeenLastCalledWith(true);
    await f.transport.stop(); await f.transport.stop();
    const count = f.options.length;
    f.options[1].onclose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.options).toHaveLength(count); expect(f.ready).toHaveBeenLastCalledWith(false);
    expect(f.clients[1].end).toHaveBeenCalledTimes(1);
  });
  it("deadline kills a blackholed generation and discards late success", async () => {
    let resolve: (value: never[]) => void = () => {};
    const f = fixture(() => new Promise<never[]>(r => { resolve = r; }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.ready).toHaveBeenLastCalledWith(false); expect(f.clients[0].end).toHaveBeenCalledWith({ timeout: 0 });
    resolve([]); await vi.advanceTimersByTimeAsync(0);
    expect(f.ready).not.toHaveBeenCalledWith(true);
    await f.transport.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.options).toHaveLength(1);
  });
  it("overflow retains a reset fence rather than an unbounded publisher queue", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    let resolve: (value: never[]) => void = () => {};
    f.clients[0].notify.mockImplementationOnce(() => new Promise<never[]>(r => { resolve = r; }));
    for (let i = 0; i < 300; i++) f.transport.publish(event);
    expect(f.clients[0].notify).toHaveBeenCalledTimes(1);
    resolve([]); await vi.advanceTimersByTimeAsync(0);
    expect(f.clients[0].notify.mock.calls.length).toBeLessThanOrEqual(129);
    expect(f.clients[0].notify.mock.calls.some(call => JSON.parse(call[1]).reset === true)).toBe(true);
    await f.transport.stop();
  });
  it("resyncs peer and own resets without changing readiness, client or dedupe", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.transport.publish(event); await vi.advanceTimersByTimeAsync(0);
    const own = JSON.parse(f.clients[0].notify.mock.calls[0][1]).origin;
    f.ready.mockClear();
    for (const origin of [own, "00000000-0000-0000-0000-000000000001"]) {
      const notify = (data: object) => f.options[0].onnotify("paperclip_ui_events_v1", JSON.stringify(data));
      notify({ origin, sequence: 2, reset: true });
      notify({ origin, sequence: 2, reset: true });
      notify({ origin, sequence: 1, event });
      notify({ origin, sequence: 3, event });
    }
    expect(f.resync).toHaveBeenCalledTimes(2);
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(f.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.options).toHaveLength(1); expect(f.clients[0].end).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith({ reason: "reset_received", generation: 1 }, "live_event_transport_resync");
    await f.transport.stop();
  });
  it.each(["null", "{}", "bad json", JSON.stringify({ origin: "00000000-0000-0000-0000-000000000001", sequence: 1, reset: false }), JSON.stringify({ origin: "00000000-0000-0000-0000-000000000001", sequence: 1, reset: true, event })])("fails closed for invalid envelope %s", async raw => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.options[0].onnotify("paperclip_ui_events_v1", raw);
    expect(f.ready).toHaveBeenLastCalledWith(false);
    expect(f.clients[0].end).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ reason: "invalid_payload", generation: 1 }, "live_event_transport_failed");
    await f.transport.stop();
  });
  it("publishes and receives an oversized reset while staying ready", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0); f.ready.mockClear();
    f.transport.publish({ ...event, payload: { text: "x".repeat(8000) } });
    await vi.advanceTimersByTimeAsync(0);
    const raw = f.clients[0].notify.mock.calls[0][1];
    expect(JSON.parse(raw)).toMatchObject({ reset: true });
    expect(Buffer.byteLength(raw)).toBeLessThan(7500);
    f.options[0].onnotify("paperclip_ui_events_v1", raw);
    expect(f.resync).toHaveBeenCalledOnce(); expect(f.ready).not.toHaveBeenCalled();
    expect(f.options).toHaveLength(1); expect(f.clients[0].end).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ trigger: "oversize", bytes: expect.any(Number), generation: 1 }), "live_event_reset_published");
    await f.transport.stop();
  });

});
