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

Full image qualification, deployed-image canary and the post-release check of
the original saved comment IDs remain distinct from these isolated tests.
