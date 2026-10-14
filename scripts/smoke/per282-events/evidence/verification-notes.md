# Tool-backed verification and limits

- `actual-health.log` / `.exit`: real parent health route plus TCP-blackhole,
  native paused-reader, startup-in-flight cleanup; completed, exit 0.
- `final-server.log` / `.exit`: focused 24-test suite; completed, exit 0.
- UI/token receipts: completed, exit 0.
- `real-integrated-tsc.log` / `.exit` retained here is the INITIAL incomplete
  overlay diagnostic, not the final result. Its missing shutdown/run-history
  dependencies and mismatched baseline agents route were resolved by copying
  the exact parent files from 002c2b55901442a797c8a238d31213390d6a6b65.
- The final runner read-back returned exactly `launched` then `0` when reading
  `/tmp/real-integrated-tsc.exit /tmp/real-integrated-tsc.log`; no compiler
  diagnostics. Final full log file was not retrieved before runner expiry.
- A large base64 transfer was initially truncated by bounded desktop stdout.
  Replaced with 32768-byte chunks; restored parent heartbeat SHA256 was
  verified on both ends:
  49a9858ae4aa34a3d2e6582eb54cef2a37db5e5a9ebd2f5a12714e372fe1e4a2.
- Runner later reached its activeDeadlineSeconds=3600 cap (DeadlineExceeded),
  after the completed separate fault/typecheck results. An extra combined
  integrated suite's result was not recovered; do not claim it passed.
- Cleanup used exact namespace UID 3daa0b64-d7b7-44c8-9b9b-9fddb269fb0c
  read-back before deleting only per282-faults-78e0d9fb. Final resource GET:
  `failed to get resource: namespaces "per282-faults-78e0d9fb" not found`.
- No production database, PVC, Secret or Service was created or modified.
