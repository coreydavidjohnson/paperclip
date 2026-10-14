# Parent-owned index integration required

Do not ship adapter-only or heartbeat-only. In `server/src/index.ts`:

1. Beside `drainHeartbeatExecutionFinalizers`, declare
   `let checkpointOmnigentRunsForShutdown: (() => Promise<unknown>) | null = null;`
2. Where the heartbeat service assigns `drainHeartbeatExecutionFinalizers`, assign
   `checkpointOmnigentRunsForShutdown = () => heartbeat.checkpointOmnigentRunsForShutdown();`
3. In signal `completeControllerTurnsForShutdown` arguments add
   `checkpoint: checkpointOmnigentRunsForShutdown ?? undefined`.
4. Treat `checkpointed` as a settled shutdown alongside `drained`.
5. If the coordinator returns `timed_out` (no checkpoint available), do NOT run
   normal DB teardown over unfinished finalizers. Leave HTTP/DB alive until the
   existing force-exit deadline; process death + expired boot lease supplies the
   safe fallback. A thrown checkpoint failure likewise must not close DB.

The isolated fixture uses this exact coordinator/checkpoint contract and the
production auth, agents and issues routers on both independent API controllers.
Parent owns index changes to avoid conflict with cross-pod event integration.
