# PER-316 current-fork fixture and restart regression

## Failure and cause

The saved PER-316 work used the former October 5 dependency tree. Production
advanced to the October 17 upstream base and the PER-1009 recovery release.
Running old source or publishing its old candidate would not qualify that
runtime and could roll back delivered recovery changes.

The first current-base fixture never started its container before its 420-second
Job deadline. This was a cold-image startup failure, not a failing product test.
Retained Pod state showed the immutable production image was still starting.
The test's own 300-second deadline was not reached or increased.

## Correction and guard

Use an archive of the exact current fork commit with the immutable production
image's dependencies. Keep fixture startup and test execution deadlines separate:
1200 seconds for the isolated Job, 300 seconds for Vitest. The wrapper records
Pod UID, node and every changed container state before readiness, plus namespace
events on failure. All fixtures deny network access and have no service account.
Only disposable database and Node-process test data is created.

Read retained process status and target state before replaying. Unknown image
publication is resolved with bounded reads of the correct repository and tags,
not by rebuilding or repushing. The original candidate tags returned 404 after
registry recovery. No production build or deployment ran for this investigation.

## Product evidence and limits

On current production fork 04e5c81e7c6cc7cce7a4dec472d6cc223e90809f,
two real-process normal comment replay controls failed: an identical saved key
returned 201 and a conflicting body returned 409, but both stopped a successor.
That deliberately red regression remains separate from the release branch.

The queued-interrupt crash-before-cancel suite initially failed six controls,
including indexed issue identity and historical taskId identity. After retaining
the original target and restoring native cancellation recovery, the complete
queue route suite passed 105 tests on b44867c30e012ae0d0817efd32c5d3c0d40fe2da.
Both normal-replay and queue fixture namespaces were independently absent after
cleanup. A conflicting-indexed-identity negative control was then added.

These results do not prove semantic typecheck, an image build, independent
review, staging behavior, measured request p95 or the normal POST repair.
Automatic UI resend stays disabled. Historical failures remain failures.

The first indexed-conflict control used a nonexistent UUID in the indexed issue
column and correctly failed its foreign key before exercising recovery. The
fixture now inserts a real second task, so the control tests a valid conflicting
binding rather than impossible database state. That 105-pass/one-fail receipt
remains failed; the successful semantic typecheck on that commit is separate.
