# PER282 live-event fault verification

Synthetic PostgreSQL only; tests refuse URLs without `synthetic-per282`.
Run against a unique disposable namespace and ephemeral DB, never production.
No schema migrations or application data are needed for these event tests.

```sh
LIVE_EVENTS_TEST_DATABASE_URL=<synthetic-url> pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/live-events-transport.integration.test.ts \
  src/__tests__/live-events-faults.integration.test.ts \
  src/__tests__/live-events-transport.test.ts \
  src/__tests__/live-events-ws.test.ts \
  src/services/chat-publication-reconciliation.test.ts --maxWorkers=1
```

`LIVE_EVENTS_TEST_INTEGRATED_HEALTH=1` makes the process fixture use the actual
`healthRoutes(db)` router (requires parent controller/readiness integration).
Tests terminate only synthetic event-session backends and temporarily deny
synthetic-role login; run serially. TCP fault injection is an in-process proxy
which consumes/drops bytes without FIN/RST. Slow-reader injection pauses the
actual native WebSocket TCP client, not a mocked queue. Publisher-pressure
batches stay below the reset threshold to isolate reader pressure.

Verified 2026-10-14 on Node 24.21.0/pnpm 9.15.4, 2 CPU/10Gi runner:
- Runner image: ghcr.io/paperclipai/paperclip:2026.1005.0@sha256:de762433b50d56ed9180fef96a13fa236b37856c5c7a7718e8f19afe3d1e8670
- PostgreSQL: docker.io/library/postgres@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609
- Disposable namespace: per282-faults-78e0d9fb, UID 3daa0b64-d7b7-44c8-9b9b-9fddb269fb0c.
- No PVCs, Secrets or Services created; synthetic DB uses emptyDir and direct pod IP.
- Parent overlay 002c2b55901442a797c8a238d31213390d6a6b65: index, health,
  controller-drain, shutdown, heartbeat, run-admission, native-review-dispatch
  plus its run-history-query/agents baseline dependencies. Parent-owned sources unchanged in this branch.
- Focused server: 5 files / 24 tests passed (30.70s), followed by actual parent health-route fault exercise: 1 test passed (15.70s).
- Actual health route went 200 -> 503 after idle blackhole within 4.5s;
  WebSocket closed/rejected 503; recovery delivered only fresh hints.
- Real slow-reader high-water 901350 bytes, below 1MiB; terminated reader,
  healthy peer continued; no remote business observers ran.
- Pending startup LISTEN cleanup exited 0 within 2s; waited past deadlines to
  prove stopped epoch stayed false. Idempotent stop; no event backends remain.
- Existing cross-pod publisher overflow/oversize reset closed both peers;
  company/global ordering, dedupe and origin-only observers passed.
- Integrated server tsc --noEmit exit 0 was read back from the runner after completing the parent overlay; UI 61 tests passed; token gates exit 0.

This is focused transport/real-health integration evidence, not a complete
`startServer` boot or deployment-image acceptance. Startup cleanup uses the
same lifecycle order in a lean process fixture; parent index integration is
source-reviewed and typechecked. An additional combined integrated rerun was launched, but its output was not recovered before the 3600s runner deadline; the separate completed test receipts above are the evidence. Long-turn controller handover remains its
own worker's acceptance lane.
