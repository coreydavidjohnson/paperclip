# Completion timing callbacks lost handle narrowing

Parent actual-diff review found TS2345 at both new log-finalization callbacks in
57f517ff0f3db16c4b1dd11abdabe0f96152cc4e. Helper tests and syntax-only checking
passed but did not check semantic nullability in heartbeat.ts. The mutable outer
RunLogHandle could not remain narrowed inside the callback. Capture it as a const
inside each existing guard. No run-nullability error was reproduced; no speculative
run changes were made.

Prevention: server/test/completion-timing-semantic.node.cjs extracts and strictly
checks both actual blocks. It reproduced both errors before the fix; all five
focused tests pass after. Syntax/transpile checks are not semantic gates.

The documented full checker was attempted against correction 0d14e07. DB passed;
server ended 137 without a semantic result. At least one attempt was explicitly
preempted. Increasing the bounded disposable limit to 24Gi did not produce a
server result; do not infer OOM from exit 137 alone. All five namespaces were
verified absent. PER-809 owns independent checker recovery; PER-800 remains
blocked until the exact candidate receives the full check. No deployment,
acceptance/probe, polling, vendor or credential changes occurred.
