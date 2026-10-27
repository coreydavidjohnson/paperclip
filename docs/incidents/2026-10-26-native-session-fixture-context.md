# Native session test fixture omitted from the image context

## Evidence

PER-626 added the native-session-resume suite to the production image gate.
A diagnostic on 3464c66c48 reported 652 passed, one failed and one pending.
The failure was MODULE_NOT_FOUND for the unchanged credential-free provider
fake-final-burst-codex-app-server.mjs, not a session-continuity assertion.
The damaged-epoch test also required that fixture and was not exercised.

The production .dockerignore excluded the same fixture. An actual BuildKit
COPY of that exact path reproduced the exclusion. Adding its one exact
exception made the same context check pass. No assertion, provider boundary,
identity check or timeout was weakened.

## Prevention and limits

Register native-session-resume.test.ts in the real image gate and retain the
exact provider fixture through context slimming. Include unchanged fixture
inputs in source-overlay diagnostics; changed files alone are not closure.
Check requested suite paths and actual test arguments before reporting counts.
A shell/SSH argument split reduced one later diagnostic to a single suite;
that invocation is not evidence for all seven requested suites.

These packaging checks do not qualify the complete native image, deployment,
production stopped-handoff recovery or the agreed observation windows.
