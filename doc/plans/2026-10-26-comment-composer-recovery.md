# Actor-bound composer recovery

## Decision

Reuse the dedicated replay-safe endpoint and the existing draft fences. Do not
retry the legacy route globally and do not add a second server delivery queue.
A GET miss never proves that a POST did not commit.

Ordinary assigned-task comments select the replay-safe route. Transition,
review, unassigned, conversation and explicit interrupt submissions retain
one-shot compatibility. The server remains authoritative and can refuse a
locally selected variant before effects. There is no fallback after a safe
attempt, including after task status changes.

Bind ordinary identifier routes to the verified loaded canonical task, not a
stale navigation seed. Before network I/O, retain the exact body, uploaded receipt IDs and request key
in tab storage under company, user, task and request identity. Refuse before I/O
if storage cannot preserve the snapshot. Do not copy next-draft text into the
saved request. Scope changes and malformed records cannot select another
actor's request. Expected-user and expected-company headers are restrictive
server fences, not authentication or permission.

Both composers reuse one recovery control. Reload restores the existing draft
fence without an automatic send. Manual recovery passes only the old request
key to the API. The API uses its saved immutable snapshot, the same safe
endpoint and bounded attempts. A later refusal remains uncertain and cannot
mint a new key or downgrade to the legacy route. A confirmed POST settles only
that submission, preserving the next draft and attachments even if a refresh
fails. Existing Stop, approval, input, owner and original-target guards stay.

## Qualification

1. Red controls for missing persistence/selection, both composers and identity
   changes. Include scope mutation, storage failure and no-fallback controls.
2. Complete affected UI suites, database/server/UI semantic checks and mandatory
   image registration. Preserve failure receipts rather than replacing them.
3. Real HTTP lost-before-save and lost-after-commit injection, complete composer
   journey, new immutable image, independent review and isolated restart tests.
4. Only the normal exact-source gate and reconciler can activate production.
   Comment POST p95 below 300 ms and private live monitoring remain required.

The client and fixture changes alone do not qualify production delivery.
