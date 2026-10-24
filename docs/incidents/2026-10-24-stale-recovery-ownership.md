# Stale recovery recreated dependencies and cleared newer ownership

## Evidence and cause

PER-95 removed an obsolete PER-127 dependency at 2026-10-24 15:42:31Z.
Recovery recreated it at 15:43:45Z and resolved action
`d36f9278-b5a9-49fb-b413-cb1b15881635` as
`durable_path_restored:healthy_child` at 15:43:46Z. A correctly identified
accepted follow-up then lost its live ownership binding.

Recovery inferred dependencies from healthy open children even when a newer
source path existed. Its blocked-status update cleared execution ownership.
This is not a missing wake or an authentication defect. Do not weaken run
authentication or use reassignment as the general repair.

A related board-resolution defect cleared only the selected action while
older resolved duplicate actions retained no-replay holds. Resolved status
alone is not proof that an execution or its effects are safe to repeat.

## Source repair and prevention

- Never infer dependencies from child membership. Preserve explicit links.
- A newer accepted path retires only obsolete recovery bookkeeping.
- Before a recovery status mutation, lock the exact company/issue and compare
  the observed version, decision, timestamp, assignee and execution owners.
  Recheck active paths and actual blockers under that same lock.
- Reconcile only exact older duplicate execution holds transactionally. Keep
  newer, other-run, workspace, already-delivering and different-owner evidence.
  The selected action alone owns continuation and its durable delivery key.
- Preserve approvals, questions, real blockers, unknown providers and native
  chat continuation ownership. No new controller or recovery endpoint.

## Verification

The new PER-95 running-owner, accepted-wake and independent PostgreSQL
lock-wait tests failed before the repair. The final heartbeat recovery file
passes all 410 tests. Real board-route duplicate cases failed before repair;
149 reconciliation, native-workspace and workspace-restore tests pass, including
once-only continuation and a lost postcommit wake acknowledgement. Server
typechecking passes. These are local source results, not release qualification.

The unrelated missing-default fixture inspected the desktop ancestor auth
configuration. It reproduces unchanged on the baseline. Its cwd now uses the
OS temporary directory; production authentication checks are unchanged.

Exact-revision full image CI, independent review, real-provider staging,
legacy migration and production verification remain PER-1009 release gates.
Board cancellation/link removal on PER-95 is cleanup, not proof of deployment.
No common cause is asserted for backup, registry or publication symptoms.
