# PER-316 current-base comment delivery and question guard

## Verified failure

On the current production dependency tree plus the queued-restart fix, exact
red commit b5ea250d563d16dc37adb8eea36ee030af941124 delivered the queued
comments successfully through the real authenticated delivery route. The
subsequent question still returned HTTP 409 `newer_comment_not_delivered`.
The full queue suite recorded one failure and 106 passes in 69.53 seconds.
The disposable namespace paperclip-tsc-fc1964afe45b4933 was independently absent
when cleanup completed. This reproduces PER-1180 without touching its issue.

## Cause and minimal correction

The question guard used the source run's launch snapshot and ignored later
server-owned delivery receipts. Mutating the launch snapshot would erase the
original context; treating any acknowledgement timestamp as current would
trust clock order instead of delivered content. Reuse the existing receipt
map, reading it under the same issue/run lock order as comment delivery, and
bind acknowledgements to the native current revision field `updatedAt`.

Delivery and ordered native steering save that revision. A fresh delivery can
refresh a versionless historical receipt only after returning the current
comment. Question creation cannot upgrade a receipt. Pending, failed, missing,
invalid, stale and other-run receipts remain insufficient. Later or edited
unread direction still rejects the question. The launch snapshot stays intact,
and a saved pending question is not an approval.

## Guard and release limits

Retain the real delivery/repeated-read/question regression and the entire
interaction service suite in the fork's existing production image gate. Port
only the receipt behavior, preserving current upstream authorization, origin
filtering, wrapped unique-error handling and queued-interrupt safety.

The earlier October 23 receipt fix is not proof of this current candidate.
Current-base green runtime tests, semantic checks, independent review, full
image publication and staged user-flow acceptance remain to be collected.
The optional build definition still points at the separate immutable queue-only
candidate. This port does not silently replace its source archive or tag.
Normal comment POST replay is a separate unresolved bug; automatic retries
stay disabled and no production reliability release is claimed.

## Normal comment POST replay and interrupt authority

The normal comments route previously performed the interrupt before its
`clientRequestId` lookup in `addComment`. A replay could therefore stop a
successor, including when the request returned a conflict for a changed body.

The current branch adds an issue-row-locked receipt for keyed human comments.
The supported plain and attachment path commits the comment, request
fingerprint, audit, and either the fast-response request or exact-target
interrupt outbox in one transaction. The fingerprint covers company, issue, user,
request key, body, attachments, presentation/metadata, and control flags.
The outbox keeps the original run ID and is processed through the existing
run-control identity and admission checks. A replay returns the saved comment;
it does not get authority over a newer run.

Legacy comments without a receipt can return the saved comment only when the
body and attachment set match. The legacy path does not replay control flags.
Requests that use reopen/resume, implicit state transitions, review
confirmation/auto-approval, a closed execution workspace, or the Paperclip
Runner's queued-message interrupt protocol retain their first-request behavior
but are retry-disabled. Their fingerprint is saved before route side effects;
a completed receipt returns the saved comment, while an uncertain `started`
receipt rejects replay. Unassigned issues cannot use the existing wake-receipt
storage and remain unqualified. Automatic client retries remain disabled.

Focused real-process verification is pending on this branch. Do not claim a
runtime reliability release or staging acceptance from source changes alone.

## Integration caught an untracked interrupt prologue

The first integrated seven-suite run at `fa3a5326256e1a02188ecc612c15c51ccbfe5f28`
recorded 374 passes and two failures. Its first failure was a teardown deadlock:
`TRUNCATE companies CASCADE` raced background database work. The following
case then encountered the company prefix left behind by that failed cleanup.
The supported route deliberately returns after durable commit, before its
interrupt delivery finishes. That recovery prologue must join the existing
heartbeat promise registry so shutdown and deterministic fixture teardown can
observe it. No production retry, timeout increase or truncate retry is an
acceptable repair. The disposable namespace was removed.

The exact same product candidate passed both database and server semantic
checks, and its separate typecheck namespace was independently absent. Those
checks do not turn the failed seven-suite receipt into a passing one.

The worker's earlier `993d39ed` run remains failed, with 111 passes and three
fixture assertion/input failures. Parent review also corrected escaped fixture
quotes and nullable result assertions before the integrated run. The real
comment-router metrics test is now explicitly in the image test gate, not only
a separate telemetry observation.

The deterministic drain regression at `bc9406cc05add34f111c7c4dfe268b441b3ab278`
then failed exactly once: the pending interrupt reported zero pending wakes.
The other 376 tests passed, and cleanup was independently verified. Register
the recovery promise in the existing wake set and remove it on settlement.
Fixture teardown now awaits the existing drain rather than racing a truncate.
The original-target test also checks an exact receipt replay after a real
successor process starts. The replay must return the original comment without
stopping that successor or inserting another operation receipt.
