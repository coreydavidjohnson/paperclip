# Parked external wake cutover

PER-1011 / design 10.1. Run this only after the combined PER-1009 release gates,
old-controller drain and durable-handle migration. No production sweep was run
as part of the source integration. This is not permission to bypass approval,
question, dependency, Stop, budget, workspace or owner gates.

Use the exact release source, database, secret configuration and external
adapter plugin set. Never put connection strings or credentials in the command
or report. Supply them through the workload's existing secret environment.

From the release source, inspect one bounded page (at most 25 saved wakes):

```sh
pnpm --filter @paperclipai/server exec tsx src/sweep-parked-external-wakes.ts --company <company-uuid>
```

Dry run is the default. It only reads database state and probes the original
provider handle/configuration. It never sends stop, starts an observer, changes
a task, admits a run, or writes recovery evidence. The report contains IDs and
classified states, not task content or credentials. Keep it as cutover evidence.

Apply a reviewed page with `--apply`. Continue with `--after <nextCursor>` until
`nextCursor` is null. Advance the cursor even when a page has unprovable entries;
otherwise older unknown wakes can starve later tickets. A run referenced by
several wakes is probed only once per page.

- Running provider: only the normal worker's confirmed-gone rule can finalize it
  (authoritative gone, or two stored confirmations at least two minutes apart).
  Active, unknown, settled/unharvested and first nonauthoritative gone do not
  release the hold. The normal worker owns further observation/harvest.
- Operator-cancelled provider: only a fresh probe returning gone or settled can
  record stop confirmation. A Paperclip cancellation or a stop ACK alone is not
  evidence. This script does not issue another stop.
- Missing durable handles, unavailable probes, unknown/active providers and other
  terminal failures remain in the report for the release owner/person to inspect.
  Migrate verified legacy receipts through PER-1012; never infer a handle or
  replace unknown outcomes with success. Deadline and unknown endings retain
  manual reconciliation. No automatic replay is authorized.

`applied: true` means the same fenced reconciliation/finalization transaction
committed, not that the task executed. A stale version loses. It records
`providerStopped: true`, `actionOutcome: mixed` and exact turn-scoped evidence,
retires only that run's non-workspace reconciliation hold, and inserts the
existing `liveness:<runId>` outbox intent. The running server consumes it. For an
operator cancellation without saved input, no new work is requested.

The outbox durably admits one fresh outcome-aware wake before normal
release-and-promote. It coalesces other saved input; every ordinary gate remains
active. Duplicate delivery uses the same wake key. Preserve saved human input,
check one run/receipt, verify pending cards/dependencies remain unchanged, and
record all unprovable IDs for a person before declaring the cutover complete.
