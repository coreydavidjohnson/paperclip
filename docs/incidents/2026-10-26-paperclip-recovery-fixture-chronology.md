# PER-316 recovery-authority fixture chronology

## Observed failure

The original isolated image Job ended with 2,366 server tests passing and one
failure at the routing-handback dispatch assertion. Its UI and adapter-utils
gates passed. The original failed log did not capture the competing run rows,
so the exact cause of that original failure is not certified by a later retry.
The image was not published, the wrapper was not launched, and all original
terminal receipts and cleanup evidence are retained on PER-316.

Five complete diagnostic runs of the 55-test authority suite passed. A separate
200-case disk-backed repetition then reproduced the same `existing_execution`
refusal once. The captured rows show that the source run was `succeeded`, the
only repair was `queued`, and their mutual source/wake bindings were correct.
The source creation time was 12:57:18.520Z but the repair creation time was
12:57:17.485Z. Thus the latest-run query selected the source, not the repair.
No claim is made about which clock or database mechanism produced the inversion.
The targeted repetition skipped 54 unrelated tests by design; it was diagnosis,
not product qualification. Both disposable namespaces were verified absent.

## Correction and prevention

The fixture represents previously completed work, but used consecutive database
wall-clock defaults to imply causal order. Give only that historical source an
explicit old creation date. Keep production recovery and its fail-closed
latest-run check unchanged. Do not add sleeps, accept `existing_execution`,
remove assertions, or grant execution authority from unproven chronology.

A new deterministic real-database regression moves the repair creation time ten
seconds behind the current wall clock without changing the host clock. It fails
against the original fixture with the same refusal. With explicit historical
source chronology, the repair remains eligible; an unrelated later succeeded
run must still make dispatch return `existing_execution`. The whole authority
suite continues to enforce Stop, pause, changed owner, pending approval,
exhaustion, persisted removal provenance and restart checks.

This is fixture stabilization, not a production fix for clock discontinuity.
It does not qualify an image, independent review, composer/restart acceptance,
production retry activation or the comment latency target. The ownership-at-copy
proposal remains separate, unimplemented and unqualified. Preserve the original
failed image verdict through subsequent acceptance.
