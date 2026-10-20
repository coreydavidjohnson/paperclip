import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

// Execute the complete production module with inert import stubs, not a copied
// handler. Node 24's native TypeScript stripping needs no application packages.
const source = stripTypeScriptTypes(readFileSync(
  new URL("../server/src/routes/health.ts", import.meta.url), "utf8",
));
const importedNames = [...source.matchAll(/import\s*\{([^}]+)\}\s*from/g)]
  .flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean));

async function fixture({ execute = () => Promise.resolve([]), missingDb = false, authReady = true, realTimers = false } = {}) {
  const state = { transport: true, draining: false, phase: "ready" };
  const logs = [];
  const routes = new Map();
  const timers = new Map();
  let timerId = 0;
  let queries = 0;
  const context = vm.createContext({
    Buffer,
    process: { env: {} },
    setTimeout(callback, delay) {
      const id = ++timerId;
      const nativeTimer = realTimers ? setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay) : undefined;
      timers.set(id, { callback, delay, nativeTimer });
      return id;
    },
    clearTimeout(id) {
      clearTimeout(timers.get(id)?.nativeTimer);
      timers.delete(id);
    },
  });
  const logger = Object.fromEntries(["warn", "error", "info"].map((level) => [
    level, (...args) => logs.push({ level, args }),
  ]));
  const stubs = Object.fromEntries(importedNames.map((name) => [name, () => {
    throw new Error(`Unexpected dependency call: ${name}`);
  }]));
  Object.assign(stubs, {
    isLiveEventTransportReady: () => state.transport,
    isControllerDraining: () => state.draining,
    getStartupRecoveryState: () => ({ phase: state.phase }),
    Router: () => ({
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
    }),
    logger,
    sql: () => "select 1",
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => new vm.SyntheticModule(Object.keys(stubs), function () {
    for (const [name, value] of Object.entries(stubs)) this.setExport(name, value);
  }, { context }));
  await module.evaluate();
  module.namespace.healthRoutes(missingDb ? undefined : {
    execute(sql) { queries++; return execute(sql); },
  }, { deploymentMode: "local_trusted", deploymentExposure: "private", authReady, companyDeletionEnabled: true });
  return {
    state, logs, timers,
    get queries() { return queries; },
    async request() {
      const response = { statusCode: 200, body: undefined };
      await routes.get("GET /ready")({}, {
        status(code) { response.statusCode = code; return this; },
        json(body) { response.body = JSON.parse(JSON.stringify(body)); },
      });
      return response;
    },
    expireTimers() {
      assert.ok(timers.size > 0, "a deadline must be scheduled");
      for (const [id, timer] of timers) {
        assert.equal(timer.delay, 2000, "production deadline must remain 2 seconds");
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function expectFailure(f, response, reasons, stage) {
  assert.deepEqual(response, { statusCode: 503, body: { ready: false } });
  assert.equal(f.logs.length, 1, "exactly one reason-coded log per 503");
  assert.deepEqual(JSON.parse(JSON.stringify(f.logs[0])), {
    level: "warn",
    args: [{ event: "readiness_failed", reasons, stage }, "Readiness check failed"],
  });
  assert.equal(f.timers.size, 0, "request timer must be cleared");
}

for (const [key, value, reason] of [
  ["transport", false, "transport_not_ready"],
  ["draining", true, "controller_draining"],
  ["phase", "recovering", "startup_not_ready"],
]) {
  test(`preflight: ${reason}`, async () => {
    const f = await fixture();
    f.state[key] = value;
    expectFailure(f, await f.request(), [reason], "preflight");
    assert.equal(f.queries, 0);
  });
  test(`post-probe state flip: ${reason}`, async () => {
    const f = await fixture({ execute: () => { f.state[key] = value; return Promise.resolve([]); } });
    expectFailure(f, await f.request(), [reason], "post_probe");
    assert.equal(f.queries, 1);
  });
}

for (const [options, reason] of [
  [{ authReady: false }, "auth_not_ready"],
  [{ missingDb: true }, "database_missing"],
]) {
  test(`preflight: ${reason}`, async () => {
    const f = await fixture(options);
    expectFailure(f, await f.request(), [reason], "preflight");
    assert.equal(f.queries, 0);
  });
}

test("preflight: all blockers are logged in stable order", async () => {
  const f = await fixture({ authReady: false, missingDb: true });
  Object.assign(f.state, { transport: false, draining: true, phase: "recovering" });
  expectFailure(f, await f.request(), [
    "transport_not_ready", "controller_draining", "startup_not_ready", "auth_not_ready", "database_missing",
  ], "preflight");
});

for (const synchronous of [false, true]) {
  test(`database error (${synchronous ? "synchronous" : "rejected"}) is sanitized`, async () => {
    const f = await fixture({ execute: () => {
      const error = new Error("postgres://user:DO_NOT_LOG@example.invalid/db");
      if (synchronous) throw error;
      return Promise.reject(error);
    } });
    expectFailure(f, await f.request(), ["database_probe_error"], "database_probe");
    assert.equal(f.queries, 1);
  });
}

test("a database error named like the timeout is still a probe error", async () => {
  const f = await fixture({ execute: () => Promise.reject(new Error("readiness_database_timeout")) });
  expectFailure(f, await f.request(), ["database_probe_error"], "database_probe");
});

test("timeout at 2s fails closed, shares one pending query, and recovers after settlement", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const f = await fixture({ execute: () => pending });
  const requests = [f.request(), f.request()];
  assert.equal(f.queries, 1);
  assert.equal(f.timers.size, 2);
  f.expireTimers();
  const responses = await Promise.all(requests);
  assert.deepEqual(responses, Array(2).fill({ statusCode: 503, body: { ready: false } }));
  assert.equal(f.logs.length, 2);
  for (const log of f.logs) {
    expectFailure({ logs: [log], timers: f.timers }, responses[0], ["database_probe_timeout"], "database_probe");
  }
  f.logs.length = 0;
  const retry = f.request();
  assert.equal(f.queries, 1, "timed-out query must not be replaced while pending");
  settle([]);
  assert.deepEqual(await retry, { statusCode: 200, body: { ready: true } });
  assert.equal(f.logs.length, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(await f.request(), { statusCode: 200, body: { ready: true } });
  assert.equal(f.queries, 2, "settled query must release the single-flight slot");
});

test("a late rejected timed-out probe is handled and releases the single-flight slot", async () => {
  let reject;
  let calls = 0;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const f = await fixture({ execute: () => ++calls === 1 ? pending : Promise.resolve([]) });
  const request = f.request();
  f.expireTimers();
  expectFailure(f, await request, ["database_probe_timeout"], "database_probe");
  reject(new Error("DO_NOT_LOG late failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.logs.length, 1, "no extra log for a request already answered");
  f.logs.length = 0;
  assert.deepEqual(await f.request(), { statusCode: 200, body: { ready: true } });
  assert.equal(f.queries, 2);
  assert.equal(f.logs.length, 0);
});

test("ready response remains unchanged and emits no failure logs", async () => {
  const f = await fixture();
  assert.deepEqual(await f.request(), { statusCode: 200, body: { ready: true } });
  assert.equal(f.queries, 1);
  assert.equal(f.logs.length, 0);
  assert.equal(f.timers.size, 0);
});

test("post-probe: simultaneous state flips retain every reason", async () => {
  const f = await fixture({ execute: () => {
    Object.assign(f.state, { transport: false, draining: true, phase: "recovering" });
    return Promise.resolve([]);
  } });
  expectFailure(f, await f.request(), [
    "transport_not_ready", "controller_draining", "startup_not_ready",
  ], "post_probe");
});

test("real 2-second deadline logs timeout without waiting for a hung database", { timeout: 5000 }, async () => {
  const f = await fixture({ execute: () => new Promise(() => {}), realTimers: true });
  const started = performance.now();
  expectFailure(f, await f.request(), ["database_probe_timeout"], "database_probe");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1900 && elapsed < 4500, `unexpected deadline: ${elapsed}ms`);
  assert.equal(f.queries, 1);
});
