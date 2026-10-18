import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterInvocationMeta, AdapterRuntimeEvent } from "../../adapters/index.js";
import { redactCurrentUserText, redactCurrentUserValue, type CurrentUserRedactionOptions } from "../../log-redaction.js";
import type { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { setHeartbeatRunRuntimeStatus, touchHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { publishLiveEvent } from "../live-events.js";
import type { RunLogHandle, RunLogStore } from "../run-log-store.js";
import { appendExcerpt, compactRunLogChunk, boundHeartbeatRunEventPayloadForStorage } from "./run-log.js";
import { buildRunEventRuntimeProgress, isHeartbeatRunRuntimeStatusActive, publishHeartbeatRunRuntimeProgress, type createHeartbeatLifecycle } from "./run-lifecycle.js";
import { externalObserverCondition, recordExternalRunProgress } from "./external-run-state.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { redactEventPayload, redactSensitiveText } from "../../redaction.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
export const ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS = 60 * 1000;
export const ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS = 5 * 1000;

type Run = typeof heartbeatRuns.$inferSelect;

export interface HeartbeatRunOutputInput {
  run: Run;
  runId: string;
  issueId: string | null;
  runLogStore: Pick<RunLogStore, "begin" | "append">;
  identityRedactor: Pick<ReturnType<typeof createAgentIdentityRedactor>, "chunk" | "redact">;
  secretKeys: Set<string>;
  appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
}

/** One recorder per execution attempt; the log store itself stays service-scoped. */
export function createHeartbeatRunOutput(db: Db, input: HeartbeatRunOutputInput) {
  const { run, issueId, runLogStore, identityRedactor, secretKeys, getCurrentUserRedactionOptions } = input;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";
  let outputSeq = Number(run.lastOutputSeq ?? 0);
  let lastOutputFlushAt: Date | null = run.lastOutputAt ?? null;
  let lastLogRuntimeStatusTouchMs = 0;
  const outputProgressState: {
    pending: {
      at: Date;
      seq: number;
      stream: "stdout" | "stderr";
      bytes: number;
    } | null;
  } = { pending: null };
  let persistedLogBytes = Number(run.logBytes ?? 0);
  // Keep non-transactional log I/O and publication inside the row lock, so
  // takeover cannot commit midway through an old observer's output effect.
  const outputTransaction = new AsyncLocalStorage<Db>();
  const withObserver = async <T>(effect: (tx: Db) => Promise<T>) => {
    const transaction = outputTransaction.getStore();
    if (transaction) {
      const [current] = await transaction.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(externalObserverCondition(run)).limit(1);
      if (current) return effect(transaction);
      return;
    }
    return db.transaction(async tx => {
    const [current] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(externalObserverCondition(run)).for("update").limit(1);
    if (!current) return;
    return effect(tx as unknown as Db);
    });
  };
  const persistOutputProgress = async (tx: Db, opts?: { force?: boolean }) => {
    const pendingOutputProgress = outputProgressState.pending;
    if (!pendingOutputProgress) return;
    const shouldFlush =
      opts?.force === true ||
      !lastOutputFlushAt ||
      pendingOutputProgress.at.getTime() - lastOutputFlushAt.getTime() >=
        ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS;
    if (!shouldFlush) return;
    await tx
      .update(heartbeatRuns)
      .set({
        lastOutputAt: pendingOutputProgress.at,
        lastOutputSeq: pendingOutputProgress.seq,
        lastOutputStream: pendingOutputProgress.stream,
        lastOutputBytes: pendingOutputProgress.bytes,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(externalObserverCondition(run));
    lastOutputFlushAt = pendingOutputProgress.at;
    outputProgressState.pending = null;
  };
  const flushOutputProgress = (opts?: { force?: boolean }) =>
    withObserver(tx => persistOutputProgress(tx, opts));
  async function begin(_currentRun: Run) {
    await withObserver(async tx => {
      handle = await runLogStore.begin({ companyId: run.companyId, agentId: run.agentId, runId: run.id });
      await tx.update(heartbeatRuns).set({ logStore: handle.store, logRef: handle.logRef,
        updatedAt: sql`clock_timestamp()`,
      }).where(externalObserverCondition(run));
    });

    const currentUserRedactionOptions =
      await getCurrentUserRedactionOptions();
    const appendIdentityRedactedLog = (stream: "stdout" | "stderr", chunk: string) => withObserver(async tx => {
      const sanitizedChunk = compactRunLogChunk(
        redactCurrentUserText(chunk, currentUserRedactionOptions),
      );
      if (stream === "stdout")
        stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
      if (stream === "stderr")
        stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
      const [clock] = await tx.execute<{ at: string }>(sql`select clock_timestamp() as at`);
      const ts = new Date(clock!.at).toISOString();

      outputSeq += 1;
      const chunkSeq = outputSeq;
      let appendedBytes = 0;
      if (handle) {
        appendedBytes = await runLogStore.append(handle, {
          stream,
          chunk: sanitizedChunk,
          ts,
          seq: chunkSeq,
        });
        persistedLogBytes += appendedBytes;
      }
      outputProgressState.pending = {
        at: new Date(ts),
        seq: chunkSeq,
        stream,
        bytes: persistedLogBytes,
      };
      await recordExternalRunProgress(tx, run);
      await persistOutputProgress(tx);

      // Streamed CLI output is real run activity: keep the in-memory
      // runtime status ("Working... / X ago") fresh between structured
      // events so sandbox runs with mid-run log streaming never show a
      // minutes-stale timestamp. Throttled to avoid churning the live
      // event stream on every 250ms tail chunk.
      const logActivityAt = new Date(ts);
      if (
        isHeartbeatRunRuntimeStatusActive(run.status) &&
        logActivityAt.getTime() - lastLogRuntimeStatusTouchMs >=
          ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS
      ) {
        lastLogRuntimeStatusTouchMs = logActivityAt.getTime();
        const touchedStatus = touchHeartbeatRunRuntimeStatus({
          companyId: run.companyId,
          issueId,
          agentId: run.agentId,
          runId: run.id,
          at: logActivityAt,
        });
        if (touchedStatus)
          publishHeartbeatRunRuntimeProgress(touchedStatus);
      }

      const payloadChunk =
        sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
          ? sanitizedChunk.slice(
              sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES,
            )
          : sanitizedChunk;

      publishLiveEvent({
        companyId: run.companyId,
        type: "heartbeat.run.log",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          issueId,
          ts,
          seq: chunkSeq,
          stream,
          chunk: payloadChunk,
          truncated: payloadChunk.length !== sanitizedChunk.length,
        },
      });
    });
    const onLog = (stream: "stdout" | "stderr", chunk: string) =>
      appendIdentityRedactedLog(stream, identityRedactor.chunk(stream, chunk));
    const appendOutputEvent = (event: AdapterRuntimeEvent) => withObserver(async tx => {
      const eventType = event.eventType.trim().slice(0, 120);
      if (!eventType) return;
      const message = event.message
        ? redactSensitiveText(redactCurrentUserText(event.message, currentUserRedactionOptions)) : event.message;
      const payload = event.payload
        ? redactCurrentUserValue(redactEventPayload(boundHeartbeatRunEventPayloadForStorage(event.payload)), currentUserRedactionOptions)
        : event.payload;
      const persisted = await appendHeartbeatRunEvent(tx, { companyId: run.companyId,
        runId: run.id, agentId: run.agentId, ...event, eventType, message, payload });
      await recordExternalRunProgress(tx, run);
      publishLiveEvent({ companyId: run.companyId, type: "heartbeat.run.event", payload: {
        runId: run.id, agentId: run.agentId, issueId, seq: persisted.row.seq,
        eventType, stream: event.stream ?? null, level: event.level ?? null, color: event.color ?? null,
        message: message ?? null, payload: payload ?? null,
        lastEventAt: persisted.row.createdAt.toISOString(),
      } });
      const progress = buildRunEventRuntimeProgress({ eventType, message: message ?? null,
        payload: payload ?? null, at: persisted.row.createdAt });
      if (progress && isHeartbeatRunRuntimeStatusActive(run.status)) {
        const status = setHeartbeatRunRuntimeStatus({ companyId: run.companyId,
          issueId, agentId: run.agentId, runId: run.id, ...progress, updatedAt: persisted.row.createdAt });
        if (status) publishHeartbeatRunRuntimeProgress(status);
      }
    });
    const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
      meta = identityRedactor.redact(meta);
      if (meta.env && secretKeys.size > 0) {
        for (const key of secretKeys) {
          if (key in meta.env) meta.env[key] = "***REDACTED***";
        }
      }
      await appendOutputEvent({ eventType: "adapter.invoke", stream: "system", level: "info",
        message: "adapter invocation", payload: meta as unknown as Record<string, unknown> });
    };
    const onAdapterEvent = (event: AdapterRuntimeEvent) => appendOutputEvent(identityRedactor.redact(event));

    return { currentUserRedactionOptions, appendIdentityRedactedLog, onLog, onAdapterMeta, onAdapterEvent };
  }

  return {
    begin,
    get handle() { return handle; },
    outputProgressState,
    withObserverFinalization: async (effect: () => Promise<void>) => db.transaction(async tx => {
      const [current] = await tx.select().from(heartbeatRuns)
        .where(sql`${heartbeatRuns.id} = ${run.id} and ${heartbeatRuns.companyId} = ${run.companyId}`).for("update");
      const receipt = current?.runnerProfileJson?.externalSettlement as Record<string, unknown> | undefined;
      const ownsSettlement = current?.status === "cancelled" && receipt?.runId === run.id &&
        receipt.status === "cancelled" && receipt.observerEpoch === run.observerEpoch &&
        receipt.terminalEpoch === current.observerEpoch && current.observerEpoch === run.observerEpoch + 1;
      if (!current || (current.observerEpoch !== run.observerEpoch && !ownsSettlement)) return false;
      await outputTransaction.run(tx as unknown as Db, effect);
      return true;
    }),
    flushOutputProgress,
    // Finalization awaits I/O and can receive more output before persisting excerpts.
    get stdoutExcerpt() { return stdoutExcerpt; },
    get stderrExcerpt() { return stderrExcerpt; },
  };
}
