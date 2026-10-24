import { createCompletionTiming } from "../completion-timing.js";
import { agents, companies, createDb, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./runtime-execution.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";

vi.mock("./run-preparation.js", () => ({
  PAPERCLIP_WAKE_PAYLOAD_KEY: "paperclipWake", configuredPaperclipApiBaseUrl: () => null,
  buildPaperclipRuntimeMcpServers: async () => [], createAdapterRuntimeToolAccess: () => null,
  createAdapterRuntimeMcpAccess: () => null, createManagedMcpRunConfig: async () => null,
  revokeHeartbeatRunGatewayTokens: async () => {},
}));
vi.mock("../usage-receipts.js", () => ({ createRunUsageRecorder: async () => ({
  persistFailure: async () => {}, capture: async () => {}, complete: async () => ({ complete: true }),
}) }));
vi.mock("../native-runtime/index.js", () => ({
  NativeCancellationPendingRecoveryError: class extends Error {}, NativeControllerDetachedForRestartError: class extends Error {},
}));
vi.mock("./run-lifecycle.js", () => ({ isHeartbeatRunTerminalStatus: (s: string) => s !== "running" }));
vi.mock("./run-control.js", () => ({}));
vi.mock("./queue.js", () => ({}));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("external run legacy dispatch integration", () => {
  let db: Db, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("external-dispatch-"); db = createDb(temporary.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Dispatch", issuePrefix: crypto.randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Dispatcher", adapterType: "test" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", observerEpoch: 3 }).returning();
    const adapter = { type: "test", execute: vi.fn(async (_ctx: any) => ({ exitCode: 0, signal: null, timedOut: false })) };
    const input = {
      run, agent, options: {}, task: { context: {}, issueRef: null, issueId: null, taskKey: null },
      runtime: { nativeRuntimeResolution: { kind: "legacy" }, adapter, runtimeForAdapter: {}, runOptions: {} },
      workspace: { executionWorkspace: { cwd: "/tmp", warnings: [] }, workspaceOperationRecorder: { recordOperation: async (op: any) => op.run() } },
      config: { runtimeConfig: {}, resolvedConfig: {}, resolvedInstanceSettings: { experimental: {} }, runtimeEnv: {}, githubSelection: {} },
      session: { sessionConfigMetadata: {}, goalCheckpointSession: { current: null } },
      instructions: { getInstructionSave: () => null, releaseInstructionCopy: async () => {} },
      trace: { completionTiming: createCompletionTiming(run.id, () => {}),}, control: { executionControl: { controller: new AbortController(), phases: { enter: vi.fn() } },
        dispatchResolvedInteractionContinuationWithAtomicGate: async (dispatch: any) => ({ dispatched: true, resultPromise: dispatch(vi.fn()) }) },
      output: { identityRedactor: createAgentIdentityRedactor(), onLog: vi.fn(), onAdapterEvent: vi.fn(), onAdapterMeta: vi.fn(), appendIdentityRedactedLog: vi.fn() },
      services: { recordCurrentHeartbeatRunRuntimeProgress: vi.fn(), persistRunProcessMetadata: vi.fn(), executionWorkspacesSvc: {}, instanceSettings: {} },
      effects: { onLegacyAdapterEntered: vi.fn(), onUsageCaptureReady: vi.fn() },
    } as unknown as HeartbeatRuntimeExecutionInput;
    return { input, adapter, run };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  it("persists the deadline before provider entry, handle callbacks, and real runtime progress", async () => {
    const { input, adapter, run } = await fixture();
    adapter.execute.mockImplementationOnce(async ctx => {
      expect((await read(run.id)).deadlineAt).not.toBeNull();
      expect(ctx.onExternalRunHandle).toBeTypeOf("function");
      await ctx.onExternalRunHandle({ sessionId: "session", dispatch: "prepared" });
      await ctx.onExternalRunHandle({ sessionId: "session", turnRef: "turn", dispatch: "accepted" });
      expect((await read(run.id)).externalRunHandle).toMatchObject({ turnRef: "turn", dispatch: "accepted" });
      await ctx.onRuntimeProgress({ phase: "run_activity", message: "working" });
      expect((await read(run.id)).livenessVersion).toBe(3);
      return { exitCode: 0, signal: null, timedOut: false };
    });
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true });
  });
  it("does not create a deadline if admission rejects dispatch", async () => {
    const { input, adapter, run } = await fixture();
    input.control.dispatchResolvedInteractionContinuationWithAtomicGate = async () => ({ dispatched: false });
    expect(await executeHeartbeatRuntime(db, input)).toEqual({ dispatched: false });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect((await read(run.id)).deadlineAt).toBeNull();
  });
  it("does not extend an existing deadline", async () => {
    const { input, adapter, run } = await fixture();
    const deadline = new Date("2026-01-01");
    await db.update(heartbeatRuns).set({ deadlineAt: deadline }).where(eq(heartbeatRuns.id, run.id));
    adapter.execute.mockImplementationOnce(async () => {
      expect((await read(run.id)).deadlineAt).toEqual(deadline);
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await executeHeartbeatRuntime(db, input);
  });
  it("refuses a stale dispatch and stale handle callbacks after takeover", async () => {
    const { input, adapter, run } = await fixture();
    await db.update(heartbeatRuns).set({ observerEpoch: 4 }).where(eq(heartbeatRuns.id, run.id));
    await expect(executeHeartbeatRuntime(db, input)).rejects.toThrow("external_run_observer_lost");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect((await read(run.id)).deadlineAt).toBeNull();
    const next = await fixture();
    next.adapter.execute.mockImplementationOnce(async ctx => {
      await db.update(heartbeatRuns).set({ observerEpoch: 4 }).where(eq(heartbeatRuns.id, next.run.id));
      const before = await read(next.run.id);
      await ctx.onRuntimeProgress({ phase: "run_activity", message: "stale" });
      expect(next.input.services.recordCurrentHeartbeatRunRuntimeProgress).not.toHaveBeenCalled();
      await expect(ctx.onExternalRunHandle({ sessionId: "stale", dispatch: "accepted" })).rejects.toThrow("external_run_observer_lost");
      expect(await read(next.run.id)).toEqual(before);
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await executeHeartbeatRuntime(db, next.input);
  });
  it("holds the observer fence while runtime progress is published", async () => {
    const { input, adapter, run } = await fixture();
    let takeover: Promise<unknown> | undefined;
    input.services.recordCurrentHeartbeatRunRuntimeProgress = vi.fn(async () => {
      let taken = false;
      takeover = db.update(heartbeatRuns).set({ observerEpoch: 4 }).where(eq(heartbeatRuns.id, run.id)).then(() => { taken = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(taken).toBe(false);
      return null;
    });
    adapter.execute.mockImplementationOnce(async ctx => {
      await ctx.onRuntimeProgress({ phase: "run_activity", message: "current" });
      await takeover;
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await executeHeartbeatRuntime(db, input);
  });
  it("fences process metadata callbacks and runtime cleanup writes after takeover", async () => {
    const { input, adapter, run } = await fixture();
    adapter.execute.mockImplementationOnce(async ctx => {
      await db.update(heartbeatRuns).set({ observerEpoch: 4 }).where(eq(heartbeatRuns.id, run.id));
      await ctx.onSpawn({ pid: 12345, processGroupId: 12345, startedAt: new Date().toISOString() });
      expect(input.services.persistRunProcessMetadata).not.toHaveBeenCalled();
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await executeHeartbeatRuntime(db, input);
    expect((await read(run.id)).processPid).toBeNull();
    expect((await read(run.id)).executionControlDeadlineAt).toBeNull();
  });
});
