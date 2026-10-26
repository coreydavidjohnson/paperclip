# PER-316 composer request recovery

## Cause

Retaining only the request key and editable draft is insufficient after a lost
response. The API cannot reconstruct an immutable comment operation safely
from text that may now include the next draft, changed attachments or a changed
assignee. A later known refusal also cannot disprove an earlier commit.

## Candidate repair

Keep the original request in actor/company/task/request-keyed tab storage before
I/O. Recover that exact snapshot only through the dedicated replay-safe route.
Ordinary assigned-task comments select this path; unsupported initial variants
stay one-shot. After uncertainty there is no legacy downgrade, even if the task
becomes terminal. Storage unavailability fails before sending, including when
selection cannot establish whether a prior safe request exists.

Snapshot the expected identity as well as the payload. The safe server route
rejects a changed expected user or company before comment/control effects.
These headers only restrict an already authenticated request. They never
impersonate another user or grant access. Returned receipts must match the
expected user, company, task and request key.

Both task and classic composers expose the same saved-request recovery control.
It sends only the retained key, never current draft text. Reload alone does not
send. Stop/disabled state hides or disables recovery. Unknown outcomes keep the
fence. A confirmed POST settles the submitted portion immediately, preserves
next-draft text and receipts, and does not become uncertain if refresh fails.
Server-observed same-user receipts retire matching saved requests; optimistic
comments and unrelated authors or bodies do not.

## Retained failures and controls

The original persistence API controls failed eleven tests before implementation.
The first wiring controls failed eleven selected assertions for missing selection
and recovery controls. A missing task-composer prop destructure was then caught
as a real ReferenceError and fixed. The paused task composer intentionally hides
its input, so its regression asserts no recovery control and no extra call while
paused, not a button inside a hidden form.

Supported Node 24 identity controls initially failed both expected-user/company
cases: the server accepted the request despite the restrictive header. The
corrected route rejects those requests before content, audit or wake effects.
The original red log remains evidence, not a successful gate.

A further negative control found two candidate defects: a mutable scope could
change the expected user during retries, and a storage read failure could select
a legacy path for an unsupported task. Both controls fail before their fixes.
Copy expected identity before asynchronous work, and fail closed on storage
selection errors. A failed initial assertion handler was corrected to collect
the promise outcome without an unhandled rejection; the valid red retains both
failures with zero unhandled errors.

Two composer controls also caught the confirmed-write/failed-refresh gap.
Completion now flows from the confirmed POST receipt through the existing draft
settlement logic instead of waiting for a second successful GET. No assertion,
Stop boundary or unknown-outcome fence was removed.

## Delivery boundary

This is a feature-branch candidate, not a live repair. Real HTTP fault injection,
full browser/composer acceptance, new image/publication, independent review,
normal production gates, restart acceptance, p95 and live monitoring remain
required. The earlier intermittent pending-question preflight failure remains
unexplained; later green runs do not establish its root cause.
