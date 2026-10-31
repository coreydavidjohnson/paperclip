# Paperclip image missing the replay-safe comment route

## Evidence

On October 30, staging for image `20261030.12325` became Synced and Healthy,
but its comment-delivery canary received `404 API route not found` instead
of 201 from `POST /issues/:id/comments/replay-safe`. Production was not
promoted. The failed canary logs were retained before normal stage teardown.

The image source was `4b80d2e29d700c5a29f08acdde074ad317ba11d9`.
That revision does not register this route. The route was introduced by
`5e558ed96a73702d510b6dcf07d537a8567bf197`; its name did not change.
An image tag or successful unrelated checks cannot establish API compatibility.

## Correction and preserved failures

Compose the published replay-safe route lineage with the existing recovery
source, rather than weaken the canary. An attempted composition with later
PER-626 source changed status projection and failed stale-release and exact
Stop-attempt tests. Preserve that patch and failed logs, and reject that
composition for this release. The narrower route lineage passes those tests
without changing their assertions.

Two route-metrics tests then failed because the array registration did not
provide a string route template. Port the already-reviewed separate string
registrations from `2d3b63cee6e29a6d999bd27017340edff0c3ef7b`.
Keep a shared handler and the existing bounded metrics implementation.

A separate red regression confirmed that exhausted pre-dispatch database
setup retries still permitted immediate generic recovery. Retain the existing
retry decision and suppress that immediate recovery only on exhaustion.
The nine-file focused gate now passes all 238 tests, including full comment
routes, metrics, readiness, stale-release, queue and lock-keepalive checks.

## Release gate

Build a new immutable image with the complete typecheck and patch-test stage.
Required infrastructure CI and a fresh owned staging receipt must qualify that
exact image before production. Keep the existing replay-safe canary unchanged.
No production fix or post-rollout acceptance is claimed by this source record.
