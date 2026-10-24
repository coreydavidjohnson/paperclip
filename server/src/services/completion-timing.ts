// Instance-local diagnostics, not first-party telemetry. Closed content-free fields.
type CompletionStage = "adapter_return" | "controller_lease_check" | "gateway_token_release"
  | "instruction_reservation_release" | "instruction_copy_release" | "run_query" | "usage_query"
  | "log_finalize" | "output_progress_flush" | "final_patch_construction";
type CompletionSpan = { version: 1; runId: string; stage: CompletionStage; startMs: number;
  durationMs: number; outcome: "ok" | "error" };

export function createCompletionTiming(runId: string, emit: (event: CompletionSpan) => unknown,
  now = () => performance.now()) {
  const origin = now();
  const record = (stage: CompletionStage, start: number, outcome: "ok" | "error") => {
    // A diagnostic sink must not change a return value or mask the original error.
    try { emit({ version: 1, runId, stage, startMs: start - origin, durationMs: now() - start, outcome }); }
    catch { /* diagnostics are best effort */ }
  };
  return {
    mark: (stage: CompletionStage) => record(stage, now(), "ok"),
    async measure<T>(stage: CompletionStage, work: () => Promise<T>): Promise<T> {
      const start = now();
      let outcome: "ok" | "error" = "error";
      try { const value = await work(); outcome = "ok"; return value; }
      finally { record(stage, start, outcome); }
    },
    measureSync<T>(stage: CompletionStage, work: () => T): T {
      const start = now();
      let outcome: "ok" | "error" = "error";
      try { const value = work(); outcome = "ok"; return value; }
      finally { record(stage, start, outcome); }
    },
  };
}
