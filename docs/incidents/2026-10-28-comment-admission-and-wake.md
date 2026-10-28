# Initial comment admission and durable wake delivery

## Confirmed failures

The composer selected the replay-safe endpoint for a new ordinary comment on a
blocked assigned task. The server correctly refused its implicit status-control
transition before saving anything. The staging refusal and zero saved rows are
retained in the PER-316 acceptance report. A source regression reproduced the
admission mismatch.

A second regression forced reference synchronization to fail after the actual
comment transaction committed. The HTTP response failed, but same-key replay
returned the original saved comment without reaching the later best-effort wake
block. No durable ordinary assignee wake existed. A fast-response acknowledgement
did not prove eventual agent execution.

## Prevention

New blocked-task comments use the existing one-shot control route directly.
There is no refusal-based endpoint fallback. Retained safe requests stay safe,
even if the task later changes status. One-shot requests snapshot their actor,
company, task, body and attachments, send expected-identity headers and validate
the returned author and request identity. Unknown one-shot outcomes do not gain
automatic resend permission.

Supported ordinary keyed comments commit their deferred wake with the comment,
operation receipt and audit. The payload carries the saved comment IDs and
original requesting user. Immediate delivery and the bounded, rotating scheduler
scan reuse normal queue admission and its issue-row fence. Reassignment or a
terminal/review transition settles the original intent instead of reviving it
later. Pause, scheduling suppression, deleted input, recovery authority and
approval controls still apply. The optional direct goal-steering optimization
does not also deliver a transaction-bound ordinary comment.

## Evidence and limits

- The initial UI regression failed before the route-selection repair. An interim
  refusal-based fallback was rejected in review and removed, rather than enlarged
  into another retry protocol. The final UI/API checks pass 71 tests.
- The first isolated server fault test found zero durable ordinary wakes after
  commit and replay. The final focused server selection passes 18 tests. The
  stronger recovery test drives two scheduler instances and
  a disposable local process, checking one delivery of the saved comment and a
  linked durable wake receipt. This does not prove a real external provider.
- An initial total-run assertion counted unrelated fixture queue messages, then
  a separate liveness setup failure. Exact saved contexts showed different input
  IDs, not duplicate delivery of the new comment. The regression now checks the
  new immutable comment's delivery, not unrelated task-wide activity.
- A paused-agent test initially rejected with the expected admission 409 rather
  than resolving. Its assertion now explicitly checks that refusal, no new run
  and retention of the saved wake. No product pause gate was weakened.
- Database, server and UI semantic checks passed on the dirty source overlay
  based on Stop handback `2b8ce80b298d724975fd2942f4a8c782ffbf7b18`.
- The broader route run remains failed: 154 passed and six failed. Two failures
  were the new fixture assertions described above. Four Stop/handoff integration
  cases exceeded their existing deadlines. A committed-base comparison reproduces
  all four timeouts on the unchanged Stop handback (three other selected checks
  pass). This isolates them from the comment repair. PER-1108 subsequently proved
  that the fixtures registered local controls or processes while stamping a foreign
  controller as owner. Stop correctly refused those local controls. Follow-up
  `2f89fbeec544884fb9a278a2b384f51b8d1f216b` corrects only the fixture ownership stamps;
  `b7dbed2430080d03276f9871f44a8639260cef9e` adds its ledger and incident record.
  Deadlines, original assertions and foreign-owner negative controls remain intact.
- Independent review returned findings, not approval. The source is not a
  committed release, full-image receipt, deployed fix or new staging acceptance.
  The earlier successful image and staging receipts remain valid only for their
  original bytes. No real client retry or production mutation ran here.

The final bounded source-review response withdrew its hypothetical reopen-wake
finding after the support and transition guards were supplied. Its remaining
payload questions are excluded by those same guards: board resume/reopen uses the
retry-disabled control path; an actual interrupt target uses the existing
interrupt outbox; review-path recovery requires in_review, which operation mode
excludes. The ordinary wake preserves the normal issue/comment/mutation, actor,
source and optional external-conversation taskKey fields. This is a static parity
assessment, not live Slack, Stop or final-release approval.

## Composed source handback

The full Stop range through `b7dbed2430080d03276f9871f44a8639260cef9e` is integrated
with the retained comment candidate. The combined complete route module passes
162 tests, and the UI/API selection passes 71 tests. Database, server and UI
semantic checks pass. The disposable test namespaces are absent. These are dirty
overlay receipts, not an exact committed-image result. The previous failed
receipts remain failed and retained.

Independent Opus review found no concrete source blockers in the supplied
composition. It did not grant runtime, restart, real-provider or latency approval.
Its conditional context checks and acceptance limits are retained with the review.
In particular, process-backed Stop acknowledgement is written only after process
termination settles; queued-wake consumption remains serialized under the issue
lock. Real-provider behavior and composed image qualification still need their
normal release checks.

PER-1108's narrow fixture prerequisite is delivered, not a wait for its whole
availability project. PER-626 owns the one combined image, release and live
qualification after receiving this source/test patch. Its previous image receipts
qualify only their original bytes. No new image build or production mutation ran
as part of this source handback.

Retained logs, overlay hashes, review findings and the candidate patch are in
`sessions:20261028T0845Z-per316`. Final release qualification must preserve the
original failures, not replace them with a focused green result.
