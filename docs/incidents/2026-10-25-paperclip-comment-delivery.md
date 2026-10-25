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
