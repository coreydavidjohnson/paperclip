# Blocked-wait validation races and pending review stages

Recorded at 2026-10-26T12:08Z. Private task PER-626.

## Reproduced failures

The first exact-source PostgreSQL diagnostic on 8627ec7bb8 collected 37 tests:
33 passed and four failed. The executor suite did not collect because of a
new test-cast syntax error. That parse error was not a product verdict.

The four genuine failures were:

* A supported revision_requested approval did not count as an unresolved wait.
* A blocked create could validate a blocker before its concurrent completion,
  wait for the blocker lock, then commit an already-completed dependency.
* A blocked update had the same stale-read race.
* Native finalization projected a pending execution review stage to todo.

The next three-suite diagnostic on 9b21925b1d collected all 782 tests. It passed
781 and failed only the executor pending-stage case: expected in_review, got
todo. Both PostgreSQL races, the real approval lifecycle and finalization
pending-stage regression passed. A separate handoff-text test on d3ba4bfa9a
passed 32 and failed one because recovery still advised a descriptor-only wait.

## Root causes and changes

Lock same-company proposed or existing dependency rows in deterministic ID
order before validating their current state. The real PostgreSQL regressions
use pg_blocking_pids to establish contention before releasing completion, and
check that rejection leaves no partial create even if the outer transaction
catches it. Keep the shared producer predicate read-only.

Treat pending and revision_requested approvals as unresolved, matching the
existing governance contract. Approval cancellation must still invalidate a
blocked reassertion when no other first-class wait remains.

When native failure has no real blocked wait, preserve a pending execution
stage as in_review rather than making it ordinary todo work. A real wait still
wins as blocked. The source-scoped recovery action and original owner remain
unchanged; no replacement execution is admitted by this projection.

Recovery instructions must name a linked blocker or pending question/approval
card, not describe a named owner/action as sufficient. Its regression is in
the real image gate along with the strict invariant and session suites.

## Verification boundary

These are diagnostic regression receipts, not an image qualification or live
repair. The full compiler/test/image gate, normal release and live checks are
still required. Production PER-1193 was not replayed, reconciled or reassigned
for this test. Unknown outcomes, approvals and execution holds stay protected.

## Integrated diagnostic receipt

Exact source 3e4e66fb0d49c0542eabbf0b0eafa2e988799393 completed all 13 named
suites with 1,511 passed, zero failed and zero pending, exit 0. This includes
both pending-stage producers, the strict PostgreSQL invariant, full restored
provider-session fixtures, recovery actions, queued-comment handoff, status
arbitration, liveness recovery, list metadata and both UI test modules.
Execution: 0dc8a494ab0743a88b9ebda78f67c406.
Retained log: oct26-integrated-thirteen.log in the task workspace.

This overlay diagnostic uses the digest-pinned running b47/2095 image, the
candidate diff and unchanged provider fixtures. It is not the official fresh
compiler/test/image gate. That gate must qualify the final committed source.
