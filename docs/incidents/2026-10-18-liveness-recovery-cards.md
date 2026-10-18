# Recovery wakes must retain pending decisions

A real PostgreSQL integration test reproduced confirmed-gone recovery
starting execution while a question or approval was pending. New liveness
admission omitted the card checks that stranded-wake admission used.

Fix: under the issue lock, liveness admission stores one deferred receipt.
Redelivery adopts it. Normal stranded-wake recovery rechecks current gates
before admitting it after the card is resolved. Provider-stop evidence does
not answer questions or approve work.

Regression: heartbeat-external-observer-integration.test.ts proves pending
question and approval gates, one receipt, and one execution after resolution.
Concurrent outbox delivery/redelivery retains the outcomes-unknown prompt.
The integration, queue, and stranded-wake suites passed all 44 tests.
Server TypeScript also passed before this documentation update.

Separate release blocker: BuildKit was OOMKilled (137) twice before the
full gate could finish. Focused tests do not imply a full gate pass.
No image publication or deployment occurred.
