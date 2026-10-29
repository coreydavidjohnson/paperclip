# Saved user comments stranded after recovery resolves

## Observed failure

PER-316 investigated deferred user comments whose recovery action had already
resolved and whose issue had no execution lock. The board still reported
`execution_recovery`, although no active or escalated action could release it.
A read-only production snapshot at 2026-10-29T02:28:41Z found 14 such wakes
across the 11 reported issues. Eight issues retained separate no-replay evidence;
the snapshot did not authorize clearing those holds or restarting their work.

The stranded-queue sweep re-admitted generic wakes but sent saved comments to
legacy promotion. Native predecessors skipped that promotion entirely. A null
explicit-continuation result also left the generic recovery message unchanged.

## Repair and safety boundary

Re-enter ordinary admission with the original durable receipt, actor and saved
comment IDs when no open recovery action remains. Identify saved work from the
receipt, not its mutable display reason, so a temporary agent pause can clear.
Admission revalidates assignment, undelivered comments and execution authority
under the issue lock. Reuse the existing decision, prerequisite and predecessor
cleanup checks before creating a successor. Persist the actual blocking reason
and next action instead of an unqualified recovery message.

Do not mark recovery complete, clear no-replay evidence, answer a question or
approve work. Chat, Dot, interaction mutation and explicit interrupt receipts
retain their existing admission paths. Native and legacy histories use the same
saved-comment recovery path. Duplicate sweepers must create only one successor.

## Regression evidence

- `86e40e8f1` adds the original native/legacy reproduction. Both cases fail
  against the previous implementation with only the predecessor present.
- `a555e1b5c` passes the complete 20-test real-Postgres module, including both
  successor cases and the existing stranded-work negative controls.
- Review identified missing decision/cleanup checks and a mutable-reason retry
  trap. `f2191f8ec` reproduces pending approval, pending question, cleanup and
  pause-then-resume failures. Its finalization case failed fixture setup because
  the native issue ownership column was missing. Set that ownership before
  inserting the finalizer; keep the foreign key and test assertions intact.
- The first no-replay message assertion was too narrow: the blocker appends its
  normal continuation instruction. Preserve that diagnostic and assert the
  specific inspection instruction remains present; do not remove the hold.
- `heartbeat-stranded-wakes-db.test.ts` is mandatory in the image gate. It
  checks persisted successor context, executor invocation and adopted receipt,
  not just a ticket status or helper call. Deadlines are unchanged.
- The complete 29-test real-Postgres module passes at `b35f1fd72`, including
  finalization after fixture ownership correction. Namespace absence and driver
  exit 0 are independently verified. The final image gate rechecks the final
  source, including the receipt wait-message correction.

Full image qualification, deployed-image canary and the post-release check of
the original saved comment IDs remain distinct from these isolated tests.

Follow-up review retained the existing unused-admission exception: a cancelled,
never-started `execution_reconciliation_required` receipt without provider
process/session identity is not an operator Stop. The saved-comment tests cover
that sequence alongside a genuine previously started Stop. Both still require
normal cleanup and execution-authority checks.

## Dependency cancellation and ordered Stop follow-up

The read-only PER-1061 snapshot confirmed a cancelled
`issue_dependencies_blocked` admission with no start, runtime selection,
controller, process or session identity and a null result. Three automatic
resolved actions incorrectly inferred unknown outcomes for that same row.
The earlier dependency cancellation had the expected bootstrap/no-provider
receipt. Neither observation authorizes rewriting production status or clearing
a genuine outcome hold.

The dependency-wait proof now checks the complete pre-dispatch row and the
retained database evidence. A provider event, coordinator, unsettled allocation,
runtime selection, start, session, unexpected result field or workspace-recovery
receipt keeps reconciliation required. Only the generated unknown-outcome hold
for the verified unused dependency run is excluded from effective admission.
Older genuine holds remain effective. The synchronous classifier stays
conservative; its only production caller uses the database evidence check.

Admission looks past verified unused receipts to the meaningful predecessor,
so a later rejected admission cannot hide an earlier operator Stop. A held
older comment does not consume the per-issue sweep slot. New authenticated
post-Stop direction can authorize one ordinary successor and coalesce both
saved inputs without replaying old effects. An acknowledged run-only native
Stop retains its existing delivery contract after verified process termination.
Unclaimed native startup settlement still uses the existing coordinator proof
and the transactional explicit-continuation fence.

### Retained verification

- `f22d9147b` reproduces four product failures: hidden genuine Stop, older-input
  starvation, historical dependency cancellation and recorded dependency
  cancellation. The first attempt's two dependency cases failed fixture setup
  because `blocked_by` is not a stored relation type. The corrected fixture uses
  the canonical incoming `blocks` relation. No constraint was weakened.
- The first correction passes all but an overly strict coalescing expectation.
  Normal admission intentionally preserves both saved messages after new
  post-Stop authority. The corrected test requires both IDs and both adopted
  receipts; the separate no-new-authority case still forbids execution.
- The broader four-module check then exposed six existing Stop/startup delivery
  paths obstructed by the earlier blanket cancellation/cleanup check. Their
  original assertions remain intact. Explicitly preserve the verified run-only
  Stop and unclaimed coordinator settlement contracts, not generic cancellation.
- Exact runtime source `f30be3d31389222f25393965237ada08e6690bff` passes all
  **361 tests in four modules**, with zero skips and driver exit 0. Scratch
  namespace absence is confirmed. Coverage includes both runtime modes,
  concurrent sweepers, dependency release and contradictory retained evidence,
  pending decisions, cleanup, ownership, pause, real Stop ordering, and native
  saved-direction delivery.
- The bounded Opus follow-up verified the two original queue findings. Its
  conditional workspace concern cannot occur with the inspected implementation:
  `hasUnrestoredRemoteWorkspace` first requires a workspace failure in the run
  result; the dependency-wait proof rejects such results, and action-level
  restore holds take precedence. This is source review, not full-release signoff.

Semantic compilation, the final image gate, deployed-image canary, two-minute
soak and production successor evidence remain required before a live claim.
