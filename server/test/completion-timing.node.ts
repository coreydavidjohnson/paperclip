import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompletionTiming } from "../src/services/completion-timing.ts";

test("completion spans await asynchronous boundaries and never include values or errors", async () => {
  let now = 100;
  const events: unknown[] = [];
  const timing = createCompletionTiming("run-1", event => events.push(event), () => now);
  let release!: (value: string) => void;
  const pending = timing.measure("gateway_token_release", () => new Promise<string>(done => { release = done; }));
  now += 4;
  assert.equal(events.length, 0, "a pending operation has not ended");
  release("PRIVATE response https://secret.test/?token=SECRET");
  assert.equal(await pending, "PRIVATE response https://secret.test/?token=SECRET");
  assert.deepEqual(events, [{ version: 1, runId: "run-1", stage: "gateway_token_release", startMs: 0, durationMs: 4, outcome: "ok" }]);
  const original = new Error("SECRET https://secret.test");
  await assert.rejects(timing.measure("instruction_copy_release", async () => { now += 9; throw original; }), e => e === original);
  assert.deepEqual(events[1], { version: 1, runId: "run-1", stage: "instruction_copy_release", startMs: 4, durationMs: 9, outcome: "error" });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET|https?:/);
});

test("completion spans cannot replace a result or original error when the sink fails", async () => {
  const original = new Error("operation failed");
  const timing = createCompletionTiming("run-1", () => { throw new Error("logger failed"); }, () => 5);
  assert.equal(await timing.measure("run_query", async () => 42), 42);
  await assert.rejects(timing.measure("usage_query", async () => { throw original; }), e => e === original);
  assert.equal(timing.measureSync("final_patch_construction", () => 7), 7);
  assert.throws(() => timing.measureSync("final_patch_construction", () => { throw original; }), e => e === original);
});

test("completion spans preserve concurrent async boundaries and explicit adapter return", async () => {
  let now = 0;
  const events: any[] = [];
  const timing = createCompletionTiming("run-1", event => events.push(event), () => now);
  timing.mark("adapter_return");
  let release!: () => void;
  const first = timing.measure("log_finalize", () => new Promise<void>(done => { release = done; }));
  now = 3;
  await timing.measure("output_progress_flush", async () => { now = 8; });
  now = 12;
  release();
  await first;
  assert.deepEqual(events.map(e => [e.stage, e.startMs, e.durationMs]), [
    ["adapter_return", 0, 0], ["output_progress_flush", 3, 5], ["log_finalize", 0, 12],
  ]);
});

test("legacy heartbeat wires each timing to its actual awaited finalization boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/services/heartbeat.ts", import.meta.url), "utf8");
  const legacy = source.slice(source.indexOf("legacyAdapterEntered = true;"));
  assert.match(legacy, /adapterResult = await guardedDispatch.resultPromise;\s*} finally {\s*completionTiming.mark\("adapter_return"\)/);
  for (const [stage, call] of [
    ["controller_lease_check", "controllerLease.assertOwned"],
    ["gateway_token_release", "revokeHeartbeatRunGatewayTokens"],
    ["instruction_copy_release", "instructionCopies.release"],
    ["run_query", "getRun"], ["usage_query", "resolveNormalizedUsageForSession"],
    ["log_finalize", "runLogStore.finalize"], ["output_progress_flush", "flushOutputProgress"],
  ]) {
    assert.ok(legacy.includes(`completionTiming.measure("${stage}", () => ${call}(`), stage);
  }
  assert.ok(legacy.includes('completionTiming.measureSync("final_patch_construction"'));
  assert.ok(source.includes('logger.info({ completionTiming: event }, "run completion stage")'));
});
