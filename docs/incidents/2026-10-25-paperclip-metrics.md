# Current-base delivery telemetry (PER-316)

## Cause and change

The current release does not export the measurements required for the comment
p95 target or control-failure diagnosis. Reuse the prior bounded metric
implementation, adapting its hooks to the current lifecycle module. Do not
restore the removed OmniGenT attachment finalizer or count benign observer CAS
refusals as disposition failures.

Middleware measures the whole API response from before idle admission. It
exports only fixed method, registered route template and response status, plus
bounded overflow, process start time and two fixed failure reasons. It excludes
the scrape itself. Lease failure increments after the existing abort guard;
disposition failure increments only after a committed nonterminal-to-failed
transition bearing the adapter error code.

## Reproduction

Exact red control `307407a98869c9f918718686d6e273a1e24293bb` ran all four
focused suites in a digest-pinned disposable cluster fixture. The lease-loss
and disposition-failure count regressions failed as expected; the other 140
tests passed, with no skipped tests. Fixture cleanup reported namespace absent.
The original lease/process-identity and native terminalization fences remain.

## Verification boundary

Exact product candidate `8153eaa36939d3842cda385aa04ccf961e88af3d` passed
all 142 checks in the four complete focused suites, with no skips, in 39.96
seconds. Both database and server semantic typechecks passed at the same exact
commit. Both disposable fixture namespaces were independently absent afterward.
Receipts are retained under the task continuation; no running fixture remains.

This is feature-branch source, not a deployed monitoring surface or a live latency
claim. Private scrape/ingress, collectors and dashboards remain infrastructure
release gates. Their current-source carry separately passes 73 source checks,
including promtool firing and recovery fixtures; exact-commit cluster CI remains
pending. Do not activate the infrastructure scrape against an older application.
