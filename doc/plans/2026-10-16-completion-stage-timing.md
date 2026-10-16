# Completion-stage timing candidate (PER-800)

Source-only candidate against 710551e553870ef2810b689a091bef37e09dddab.
The paired external adapter change is in luma-homelab task/per800-completion-timings.
No release/polling/default/idle-streak/lifecycle or runtime change is authorized here.

## Diagnostic contract

The instance logger emits `run completion stage` with `completionTiming` containing
only version=1, runId, a closed stage name, monotonic startMs/durationMs and ok/error.
Origin is controller executeRun entry after scheduling suppression; offsets are
process-local, never wall timestamps. Adapter metadata has a separate origin.
Correlate by runId; do not subtract offsets across the two origins/processes.
The logger's normal timestamp anchors controller events, not server idle transition.
No URL, credential, payload, response, error message or stack is copied into timing.
This is instance-local logging, not first-party telemetry or an OTLP exporter.

Legacy adapter return is observed on resolution or rejection. Awaited boundaries:
controller ownership check, gateway-token revoke, optional instruction reservation
release, instruction-copy release, run read, normalized-session-usage resolution,
log finalize, output-progress flush and synchronous final patch construction.
The existing error-handler log finalize/flush are timed too. Normal catch/rethrow
and best-effort cleanup behavior remain where they were. Diagnostic-sink throws
cannot mask an operation error. No new remote call or awaited log write is added.

The span `usage_query` is the whole source-owned resolver (which can contain
multiple queries), not a per-statement PostgreSQL trace. `final_patch_construction`
covers the final patch object, not preceding usage/result calculation. Optional
log finalization has no span when no handle exists. Setup before adapter entry,
native runner execution/finalization and outer-finally environment cleanup are
not covered by this legacy completion candidate. The post-patch status write and
later presentation/liveness actions remain outside the finishedAt envelope.
OmniGenT server idle-transition/internal processing and Hermes are outside the
owned-code boundary; no vendor modifications are proposed. These timings cannot
retroactively attribute PER-791's retained 3.990-second gap.

## Verification / parent delivery plan

Focused deterministic checks (Node 24.11+):

    node --test --experimental-strip-types server/test/completion-timing.node.ts

Tests await controlled promises; check error identity, concurrent end boundaries,
sink failure, closed-field privacy, and static wiring to the actual legacy path.
The static wiring check is not a database-backed heartbeat integration test.
The paired adapter suite uses its in-memory fake client, fake monotonic and wall
clocks; verifies two idle observations/default 2000 ms polling, error classification,
128-span retention and omissions. No new live probe or acceptance measurement.

Before any parent promotion, review both exact diffs against then-current pinned
source; rebase on overlapping changes and rerun focused checks. Run required
homelab exact-SHA cluster CI, the fork's normal semantic typecheck/build recipe,
and the command above on the exact fork candidate. Full fork semantic check and
packaged controller runtime tests were not run in this child. No CI receipt is
claimed. This child does not update fork.lock.json, main, any image, configuration,
reconciler or service. PER-731 owns actual-diff review and later normal delivery,
the failed <10s criterion and the existing single-probe constraint.

## Review correction: captured finalization handles

Both success/error log-finalization callbacks now capture the narrowed handle in
an immutable local before entering the timing closure. No non-null assertions,
run-nullability edits, error handling changes or lifecycle changes are needed.
The new semantic regression extracts both actual source blocks and the handle
interface, then checks them with the installed TypeScript compiler in strict mode.
Its fixture models the mutable outer handle; both TS2345 diagnostics were observed
before the fix, and neither remains after it.

    node --test --experimental-strip-types server/test/completion-timing.node.ts server/test/completion-timing-semantic.node.cjs

Run the homelab script scripts/typecheck-paperclip-fork-candidate.sh on VM103
against the exact corrected commit. It uses a disposable, digest-pinned dependency
image and overlays owned source; record all diagnostics and cleanup, not only
completion-timing lines. It is not a packaged-runtime acceptance test.
