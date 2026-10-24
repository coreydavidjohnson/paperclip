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
- Before recovery changes status or a quota monitor, lock the exact
  company/issue and compare the observed version, decision, timestamp,
  assignee and execution owners. Recheck active paths and actual blockers
  under that same lock. Failure escalation, disposition escalation and review
  conversion share this guard. Do not replay observed dependency arrays.
- A consumed source wake is not a new path. Exclude it only through the
  persisted terminal run and its exact wake/company/agent/issue binding under
  the lock. A cleared or changed wake run binding remains protected.
- Reconcile only exact older duplicate execution holds transactionally. Keep
  newer, other-run, workspace, already-delivering and different-owner evidence.
  The selected action alone owns continuation and its durable delivery key.
- Preserve approvals, questions, real blockers, unknown providers and native
  chat continuation ownership. No new controller or recovery endpoint.

## Verification and failed attempts

At original repair commit 85b601b831, the heartbeat file passed 410 tests and
three reconciliation/workspace files passed 149. Those are historical source
results, not qualification of the later integrated candidate.

Further independent PostgreSQL writer-lock tests reproduced stale ordinary
failure escalation clearing a newer owner and stale provider-quota recovery
writing an obsolete monitor. Both fail before their guards and pass afterward.
The disposition race passed before this extension and is retained as a guard,
not claimed as a newly reproduced defect. The consumed-wake regression also
failed before its narrow correction; a requeued wake stays protected.

The expanded heartbeat attempt failed with 355 passing and 57 failing tests.
It exposed a leftover blocker-variable reference and overly broad suppression
of legitimate failure escalation. Those defects were corrected. A subsequent
affected run passed 94 and failed two retained-cleanup timing assertions; all
four retained-cleanup cases passed in isolation. These failures remain retained.

The next full two-file run passed all 415 heartbeat tests, including the
retained-cleanup cases, but failed three recovery-action fixtures that reused
stale issue snapshots. It finished with 509 passing and three failing tests.
The legitimate later-attempt fixtures now read the current source version;
concurrent identical stale observations have exactly one winner and one
attempt. No ownership guard was relaxed to satisfy these fixtures. The entire
recovery-action file then passed 97 tests, including real board-route duplicate
reconciliation, once-only continuation, lost acknowledgement, and preservation
of explicit blockers and approvals. There are no skipped cases in these final
full-file results. Direct server semantic TypeScript checking passes.

The unrelated missing-default fixture inspected the desktop ancestor auth
configuration. It reproduces unchanged on the baseline. Its cwd uses the OS
temporary directory; production authentication checks are unchanged.

Exact-revision full image CI, independent review, real-provider staging,
legacy migration and production verification remain PER-1009 release gates.
Board cancellation/link removal on PER-95 is cleanup, not proof of deployment.
No common cause is asserted for backup, registry or publication symptoms.
