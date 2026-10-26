# PER-316 replay-safe comment admission

## Gap and contract

A fetched comment can confirm a prior save. An absent comment or operation
receipt cannot prove a request never committed or is no longer in flight.
The existing legacy comment route also accepts variants that cannot safely
replay all control effects. Do not enable automatic resends on that route.

Use an explicit `POST /api/issues/{id}/comments/replay-safe` endpoint for
qualification. A new optional body field is insufficient: an older server
can strip it and execute the legacy operation. An older server has no handler
for the new endpoint. There is no fallback from a failed or unknown safe
attempt to the legacy endpoint.

The new endpoint requires an authenticated board user and a request key. It
reuses the existing company/access, pause, approval, input and issue-row
transaction fences. Existing fingerprinted operation receipts can replay
without new effects. A legacy content-only receipt cannot certify the control
operation. Unsupported unassigned, transition, review, closed-workspace,
conversation and active Paperclip Runner interrupt variants must refuse before
comment/control effects. Preserve ordinary first-request compatibility on the
legacy route. Do not change stopped-task reassignment behavior owned by PER-626.

## Bounded client and activation limit

The explicit `issuesApi.addReplaySafeComment` qualification method snapshots
all request fields once and sends only to the safe endpoint. It permits at
most three attempts, each with a ten-second abort deadline, with 250 and 750
millisecond gaps. Network, parsing, 5xx and invalid/mismatched receipts are
unknown outcomes, not evidence that a new key is safe. Reuse the exact key and
body. A later known refusal after an unknown attempt must preserve uncertainty
because the first attempt may have committed. Never fall back to a legacy
write or infer resend safety from a GET miss.

This method is not wired into any production composer. The existing default
`addComment` remains one-shot. Candidate implementation and unit tests do not
authorize activation: complete real HTTP fault injection, image gates,
isolated comment/answer/follow-up/interrupt/restart acceptance, independent
review and latency qualification first. Unsupported state recovery and safe
composer selection remain unfinished. No production repair is claimed.

## Tests and retained failures

Real PostgreSQL route regressions cover the unsupported variants, board/key
binding, same-key concurrency, audit-trigger rollback followed by the same
request, fresh-router receipt replay after an issue changes state, original
run identity and a real live successor. Client tests cover lost-before-save,
lost-after-save, 5xx, hanging requests, immutable payloads, mismatched receipts,
known refusals, bounded exhaustion and no fallback. These are qualification
controls, not a complete staged browser journey.

The initial focused route run had eleven missing-route failures and a malformed
conversation fixture rejected by the existing database constraint. Correct the
fixture to include its required conversation state, not the constraint. The
corrected missing-route control fails all thirteen selected cases as expected.
An initial launcher passed a short SHA and failed before cluster creation;
retain that invocation failure separately from the exact-source product red.


The first implementation passed thirteen focused operation controls but failed
two new real-router metric assertions. Registering an Express path array hid
both route templates from the existing metrics recorder. Share the handler,
but register each string template separately. Keep both attribution controls;
do not loosen labels or expand metric cardinality to raw URLs. The failed
implementation and its original result remain part of the release evidence.
