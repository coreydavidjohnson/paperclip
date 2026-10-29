import { afterEach, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { createHeartbeatPreparationTiming } from "./preparation-timing.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([false, true])("logs a slow setup phase without tracing, failed=%s", async failed => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  vi.useFakeTimers();
  const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const failure = new Error("private credential detail");
  const pending = createHeartbeatPreparationTiming("run-id")("workspace_environment_acquire", async () => {
    vi.advanceTimersByTime(31_000);
    if (failed) throw failure;
    return "prepared";
  });
  if (failed) await expect(pending).rejects.toBe(failure);
  else await expect(pending).resolves.toBe("prepared");
  expect(warning).toHaveBeenCalledExactlyOnceWith({
    runId: "run-id", phase: "heartbeat.prepare.workspace_environment_acquire", durationMs: 31_000,
    outcome: failed ? "failed" : "succeeded",
  }, "Run preparation phase exceeded 30 seconds");
});

it("does not log a healthy setup phase", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  await createHeartbeatPreparationTiming("run-id")("workspace_environment_realize", async () => "prepared");
  expect(warning).not.toHaveBeenCalled();
});
