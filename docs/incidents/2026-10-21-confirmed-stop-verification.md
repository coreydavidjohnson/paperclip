# Confirmed-stop verification boundaries

## Result

During PER-1011 source integration, a focused test initially reported success
while an assertion thrown inside the fake adapter had been caught and logged
by normal heartbeat failure handling. No candidate was deployed on this evidence.

## Correction and prevention

- Adapter fakes record data and return a result. Assert the delivered context
  from the test thread after draining execution; require a persisted succeeded
  successor, not only an adapter call count.
- Produce saved user wakes with the real heartbeat wake writer and its canonical
  `issue_commented` reason. An ad-hoc `issue_comment` fixture did not represent
  the queue's comment-adoption contract and was correctly excluded.
- The corrected real-PostgreSQL/queue test proves both saved comment IDs reach
  one outcome-aware successor. Pending question, approval and dependency rows
  stay pending and no adapter is invoked for those cases.
- A separate red test reproduced repeated stop delivery after the confirmed
  reconciliation committed but its outbox ACK was lost (two stop calls instead
  of one). The consumer now reuses the exact stored handle/probe/operator-stop
  proof, without stopping or probing a potentially reused session again.

Runnable prevention: `heartbeat-confirmed-stop-db.test.ts` and
`heartbeat-confirmed-stop-integration.test.ts`, both registered in Dockerfile's
`luma-patch-tests` gate. The 16 focused cases passed on 2026-10-21. The full
exact-revision image gate and real-provider release gates remain separate.
