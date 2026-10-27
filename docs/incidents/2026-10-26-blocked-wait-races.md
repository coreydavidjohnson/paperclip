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

## Later review: Stop authority and deletion contention

A native Stop durably records an audited intent before executor acknowledgement
and terminal run status. The write-authority helper previously inspected only
executionCancellation and cancelled status. A real PostgreSQL authentication
projection and transactional check reproduced four missing fences; JWT and
API-key middleware each admitted a new write. The corrected RED diagnostic had
31 passes and six genuine failures. An initial middleware fixture reached the
unrelated responsible-user membership gate, so it was corrected before counting
those two failures.

The shared predicate now recognizes a same-company, same-run native intent with
its exact schema, audit reference, scope and pending/acknowledged dispatch state.
The authentication query projects only those needed fields rather than copying
provider payloads. Exact request-local self-handoff authority remains unchanged;
foreign/malformed receipts are not authority. A follow-up array-shaped scope test
caught implicit String coercion, which was removed. Do not coerce marker fields
into valid receipt values.

Four complete suites on fd01290c08 passed 160 tests with zero failures or pending
cases, including native cancellation and admitted authenticated self-handoff.
This was an overlay diagnostic, not a fresh compiler or image verdict.

A deterministic two-transaction regression also reproduced PostgreSQL 40P01:
update locked the dependent before its blocker while deletion locked the blocker
before the dependent. Deletion now takes its source, dependent and remaining
blocker locks with NOWAIT. Contention rolls back and returns HTTP 409
issue_blocker_busy rather than waiting in the inverted order. Existing blocked
create/update contention still waits and revalidates the blocker after completion.
No company/global serialization or automatic mutation replay was added.

The next three-suite diagnostic passed 98 cases and failed the deadlock case plus
two more pending-stage projections, in wake-queue terminal recovery and heartbeat
workspace preflight. Both keep real waits first, otherwise retain a pending
execution stage as in_review. Source recovery actions and original owners stay
unchanged. Full integrated validation and image qualification remain separate.

The first eight-suite post-review diagnostic on 1b7d7832e1 passed 396 of 397
cases, with zero pending. Only workspace preflight still lost its pending review:
its issue projection omitted executionState, so the new fallback never saw it.
Add that column to the existing locked admission query; do not add another read
or weaken the pending-stage regression. The other seven suites passed, including
both native Stop fences, malformed receipt controls, the deletion conflict and
complete issue-service coverage. This is not an integrated qualification pass.


## Reserved-image compiler qualification

The exact bc220c11e0 full image build reached the server compiler and failed
with two TS2345 errors and one TS2322 error. The Board-todo proof helper took
the narrower serialized shared action type, but both actual callers pass raw
Drizzle rows whose enum-valued columns are strings. Derive the helper input
from the persisted row type, as the sibling issue input already does. Keep
every runtime action kind, owner, source and receipt check unchanged.

Drizzle lock configuration accepts literal noWait:true, not a boolean. Supply
that option only for the existing nonblocking deletion path and the ordinary
empty configuration otherwise. Do not change contention behavior or use a
cast to hide either compiler refusal. The full compiler gate caught these
errors after the earlier runtime diagnostics; neither diagnostic test passes
nor runner preparation imply compiler or image qualification.

The corrected server passed compilation in the next reserved build. The full
recursive gate then found TS2322 in the blocker-display test fixture: its
unannotated object widened status and priority to string. Type that existing
fixture as IssueRelationIssueSummary; retain both row variants and all exact
link assertions. This changes no product behavior and does not weaken the
full typecheck gate. Native test and image qualification still remain open.
