# A user wake beat native recovery and reused a dead conversation

## Evidence

The board reported PER-1182 run `6c27ea43-c12f-44bd-b179-605028e7a233`
and PER-1131 run `33d31e7b-98f4-4c42-a14a-d228f5ff1d95` failing after
120 seconds as `omnigent_session_not_recovered`, without sending a prompt.
Saved conversations were `7a78e671acfa45ed9861e84121b9bb2e` and
`06db70fa608e41c082e235657c34a8ae`. Provider resource evidence was offline
and non-resumable. These are not permissions to stop a live provider or to
replay earlier actions.

Fresh authorized recovery reads on October 24 show the preceding exact
reconciliations still marked `continuationDelivery=pending`. In particular,
PER-1182 action `809f00ab-8e3a-4e48-a65b-63561dfdd9a7` targets run
`463e479c-fb1b-4575-bca0-b9b2b6d74179`, and PER-1131 action
`faa3e5e3-3a43-41b8-bd0b-d3b3f6633dab` targets run
`36c034e6-03d0-41d1-80fc-abf2d2431307`. Both retain mixed historical
outcomes and operator evidence. The initial no-continuation hypothesis was
incorrect for these records.

## Reproduced boundary and source repair

The real board route persists a pending reconciliation. A subsequent ordinary
saved user comment could create a run before the outbox wins admission,
without fresh-session intent or the exact recovery linkage. That regression
fails before this repair. It reproduces the native control-plane gap, not a
completed diagnosis of every production provider transition.

Existing native queue admission now adopts that exact pending decision under
the issue lock and in the successor transaction. It verifies persisted comment
author, company, issue, owner, source run, terminal/provider/environment proofs,
source recency and current gates. It records the existing explicit-user
continuation authorization, consumes the existing outbox once, and carries
fresh-session intent plus the exact original conversation through session
preparation. No recovery envelope is inferred from comment text. No active
ownership is cleared and no second controller or endpoint is introduced.

A second regression reproduced action-ID delivery replaying an older source
after newer work succeeded. Native admission now invalidates only the obsolete
delivery marker under the issue lock, preserving its operator decision and
all newer execution history. The older test expecting replay after unrelated
newer work was changed to the required newer-accepted-path-wins contract.
Exact action lost-ACK handling remains ahead of the stale-source guard.

A decision with no continuation requested stays no-dispatch. Real approvals,
questions, linked dependencies, running processes, workspace repair and chat
provenance keep their separate gates. The affected live issues were not woken,
reconciled again, reassigned or interrupted.

## Verification and limitations

The final five complete source suites pass 816 tests, with no skips:
heartbeat-process-recovery 415, issue-recovery-actions 108,
heartbeat-session-preparation 5, explicit-native-continuation 255 and
execution-continuation 33. Direct server semantic TypeScript exits 0.
The mandatory image patch stage includes these regressions.

Failed evidence remains preserved. The new board-route test first failed on
missing fresh-session fields. Its next failure was a count assertion that also
counted the seeded source run; it now counts actual successors. The initial
two-file run passed 110 and failed two new fixtures: a foreign-key-invalid
owner and an old source superseded by the fixture's actual corrective turn.
Both fixtures now use persisted identities; the recency guard was not relaxed.
A four-file run passed 400 and failed the old replay contract, subsequently
updated as described above. The final 816-test run is green.

These are source and fake-adapter dispatch results, not real OmniGenT staging
or proof that the affected production issues now work. Independent review,
exact image qualification, native runner/model/effort and authorized follow-up
verification, the real-provider matrix, image/lock delivery and live checks
remain required. No image, production pin, migration or legacy deletion occurs
in this repair.
