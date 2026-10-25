# Guarded exhausted disposition status repair

This is a board-only, source-scoped repair, not an execution recovery override.
It extends `POST /api/issues/:id/recovery-actions/resolve`. Read the current
issue and recovery action first. Do not change status to manufacture a blocker.

## Exact request

```json
{
  "actionId": "<current action UUID>",
  "outcome": "restored",
  "sourceIssueStatus": "todo",
  "resolutionNote": "Continue the existing task normally. Preserve completed work.",
  "statusRepair": {
    "sourceUpdatedAt": "<issue.updatedAt ISO timestamp>",
    "sourceStatus": "in_progress",
    "sourceStatusVersion": 0,
    "assigneeAgentId": "<current original owner UUID>",
    "actionUpdatedAt": "<action.updatedAt ISO timestamp>",
    "actionFingerprint": "<action.fingerprint>"
  }
}
```

`sourceStatus` can be blocked, in_progress or todo. All snapshot fields are
required and exact. `resolutionNote` must be nonempty and at most 2000 characters.
Do not combine this with execution reconciliation or workspace repair.
The actor must be the authenticated board. The action must be active/escalated,
kind deliberate_wait_without_target, board-owned, with board_escalation wake
policy and unchanged_source_state_exhausted terminal evidence. Its return owner
must still own the task. A stopped/finished source, different action, changed
snapshot, pending card/approval, unresolved dependency, unavailable owner or
active execution refuses the entire repair without partial status/action edits.

## Status writes and replay

Ordinary status writes through the common service refuse this exact escalation
with HTTP 409 and code recovery_status_repair_required. Earlier route validation
can still refuse an invalid Blocked request with HTTP 422. Nonstatus writes and
unrelated recovery kinds retain existing behavior.

Success atomically changes the source to todo and resolves the action as
handed_back, preserving assignment, settings and the audit trail. An identical
repair replay is read-only. A newer source snapshot or active action returns
HTTP 409 with code recovery_status_repair_stale. Do not replay an old request
against a new decision; read both records again.

## Native continuation

The committed action contains evidence.guardedStatusRepair with a pending
continuation. Immediate delivery and the independent periodic recovery sweep
share the same intent. The native reason is issue_commented, the idempotency key
is guarded-status-repair:<actionId>, and the context source is issue.comment.
The board note becomes paperclipAgentMessage. No recoveryActionId, recovery
instruction, forceFreshSession or execution reconciliation is attached.
Ordinary admission chooses the saved task session and enforces current access,
budget, pause, dependencies, reviews and execution ownership. The repair does
not grant execution authority. A changed source invalidates undelivered intent.
A committed wake is adopted after a lost acknowledgement, even if its run has
already finished. It must never produce a second provider turn.

Tests use isolated disposable Postgres, not production recovery fixtures.
The current Agent Tools recovery wrapper has not yet exposed statusRepair;
this document specifies the native board API for its owning integration.
