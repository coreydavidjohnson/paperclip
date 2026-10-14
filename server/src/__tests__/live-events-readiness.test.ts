import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const f = vi.hoisted(() => ({ now: 0, setReady: (_ready: boolean) => {}, info: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { info: f.info } }));
vi.mock("../services/live-events-transport.js", () => ({
  createLiveEventTransport: (_db: unknown, _receive: unknown, setReady: (ready: boolean) => void) => {
    f.setReady = setReady;
    setReady(false);
    return { publish: vi.fn(), stop: vi.fn(async () => setReady(false)) };
  },
}));
async function fixture() {
  const events = await import("../services/live-events.js");
  const controller = events.startLiveEventTransport({} as Db);
  return { ...events, controller };
}
describe("API readiness reconnect grace, not transport readiness", () => {
  beforeEach(() => { vi.resetModules(); f.now = 0; vi.spyOn(performance, "now").mockImplementation(() => f.now); f.info.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("fails closed until initial LISTEN succeeds even after ten seconds", async () => {
    const e = await fixture();
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    f.now += 10001;
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    f.setReady(true);
    expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    await e.controller.stop();
  });
  it("keeps the API available for brief loss but immediately notifies UI subscribers", async () => {
    const e = await fixture(); const listener = vi.fn();
    const unsubscribe = e.subscribeLiveEventTransportState(listener);
    f.setReady(true); f.setReady(false);
    expect(e.isLiveEventTransportReady()).toBe(false);
    expect(listener.mock.calls).toEqual([[true], [false]]);
    for (let i = 0; i < 8; i++) {
      f.now += 1000;
      expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    }
    f.setReady(true);
    expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    unsubscribe(); await e.controller.stop();
  });
  it("expires at ten seconds, duplicate false cannot extend it, recovery resets the next window", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    f.now += 9999; f.setReady(false);
    expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    f.now += 1;
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    f.setReady(true); f.setReady(false);
    expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    await e.controller.stop();
  });
  it("stop cancels grace and restart must succeed again", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    await e.controller.stop();
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    const next = e.startLiveEventTransport({} as Db);
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    f.setReady(true); expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    await next.stop();
  });
  it("wall-clock jumps cannot extend the monotonic reconnect deadline", async () => {
    const e = await fixture(); f.setReady(true); f.setReady(false);
    vi.spyOn(Date, "now").mockReturnValue(-1_000_000);
    f.now = 10000;
    expect(e.isLiveEventTransportReadyForApi()).toBe(false);
    await e.controller.stop();
  });
  it("a stopped handle cannot cancel a replacement transport's grace", async () => {
    const e = await fixture(); f.setReady(true); await e.controller.stop();
    const next = e.startLiveEventTransport({} as Db); f.setReady(true); f.setReady(false);
    await e.controller.stop();
    expect(e.isLiveEventTransportReadyForApi()).toBe(true);
    await next.stop();
  });
  it("logs once per actual boolean transition including stop, never repeated probes", async () => {
    const e = await fixture();
    f.setReady(false); f.setReady(true); f.setReady(true); f.setReady(false); f.setReady(false); f.setReady(true);
    await e.controller.stop(); await e.controller.stop();
    expect(f.info.mock.calls).toEqual([false, true, false, true, false].map(ready => [
      { ready }, "live_event_transport_readiness_changed",
    ]));
  });
});
