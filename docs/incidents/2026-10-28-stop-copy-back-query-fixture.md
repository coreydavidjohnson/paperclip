# Stop copy-back race fixture and fluent query execution

The combined image gate at source b557972046538d1d96a6921d2612f660f4d2c58e
failed one of 3,583 server tests. Stop's copy-back race fixture replaced the
query returned by `where()` with a Promise. The current Stop implementation
calls `returning()` on that query to fence the owner update, so the mock raised
a TypeError before signalling the adapter. The later aborted-signal assertion
failed as a consequence. Authentication warnings were not this failure.

Delay the real query's `execute()` instead. This preserves its fluent methods,
the actual PostgreSQL update and returned ownership proof. Keep every original
copy-back, retained-lease and cancellation assertion and its deadline. The
focused race and adjacent embedded Stop check pass on the corrected source.
This fixture correction changes no production code or authority checks.

Build and patch tests belong in the image CI pipeline before staging. Staging
must deploy the resulting immutable digest and exercise the packaged runtime,
not compile the product or repeat the server suite as an acceptance canary.
Retain the failed image receipt separately from subsequent qualification.
