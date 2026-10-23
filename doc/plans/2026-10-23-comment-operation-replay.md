# PER-316 normal comment operation replay

Status: investigation with deliberately red regression; not a runtime fix.
The release candidate remains fork 247c4045825114a2417a7295c44743e0922fa738.
Do not merge this test branch as a passing image gate or enable UI retries.

## Observed boundary

The normal comments route cancels the active run before calling addComment.
The service's issue-row lock and user/request-key lookup deduplicate only the
comment insert. They cannot undo an earlier cancellation. The prior mocked
regression is b5799f4d0244f814bf6e9f62a4625a16468f858d; the current real-DB
regression is ac424a4e160e44147903823de7a66f9229d69086.

The real fixture precommits one user/key/body, then presents a successor's
actual disposable Node process. Identical-body replay must return that row;
conflicting-body replay must return 409. Neither may cancel the successor.
An occupied agent slot prevents any model/adapter dispatch.

## Minimal safe implementation boundary

Reuse the existing issue transaction fence and durable wake queue, not a new
in-memory dedup map or retry framework. All authorization and validation must
precede the first effect. Commit the comment, required issue/review transitions,
audit and delivery/interrupt intent together. Record the original target under
that fence. A deduplicated request must not mint new interrupt authority or
repeat a transition, even after reassignment, closure or a newer execution.
The post-commit worker may retry only that saved target, outside database locks,
through the existing cancellation and admission safety gates. Return the saved
comment without waiting for provider cancellation or synchronous dispatch.

Moving cancelRun below addComment or adding an early SELECT alone is insufficient:
concurrent requests and restart between commit and dispatch still need durable
whole-operation intent. Do not preserve intent only in a mutable coalesced queue
that a later interrupt can overwrite. Replays must bind their original request,
including attachments and control flags, rather than interpreting a reused key
as a new action. Keep actor/company/issue scope, exact delivery revisions,
approval gates, discard/edit authority and verified process-stop requirements.

## Proof required before enabling retries

- Identical and conflicting-key real-process controls above.
- Concurrent same-key requests: one comment, one original stop, one successor.
- Crash before commit: no stop and no partial comment/transition.
- Crash after commit before cancellation/dispatch: periodic recovery uses original
  authority, including issueId and taskId context variants, never a successor.
- Reassignment, terminal issue, queue edit/discard and missing process identity
  remain fail-closed at admission.
- Plain/reopen/resume/auto-approval/attachment variants retain native semantics;
  document any still-unqualified variant and keep automatic retry off for it.
- Staging flow, no lost-lease errors and measured comment POST p95 below 300 ms.

The existing queued-comment interrupt restart fix is separate. Its 202 passing
isolated checks do not qualify normal comment POST replay or full staging.
