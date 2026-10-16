import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryRunContext, recoveryRunContextFingerprint, recoveryRunSelect, retryAccountingRunSelect } from "../services/recovery-run-query.js";
import { executionRetryAccounting } from "../services/execution-recovery-attempt.js";

describe("recovery run projections", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("luma-recovery-query-"); db = createDb(fixture.connectionString); }, 90_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it("keeps JSON types and nested nulls without returning prompts or history", async () => {
    for (const value of [null, [], "text", 42, true, {}, {
      issueId: "i", retryReason: 1, wakeCommentIds: ["x", null],
      paperclipWorkspace: { mode: "shared_workspace", nested: null },
      legacyDispositionEpisode: { id: "episode", attempt: 2, maxAttempts: 2 },
      paperclipWake: { externalInteractionContinuation: true },
      prompt: "x".repeat(1_000_000), continuationSnapshot: { history: ["secret"] },
    }]) {
      const [row] = await db.execute(sql`with heartbeat_runs as (
        select ${JSON.stringify(value)}::jsonb as context_snapshot)
        select ${recoveryRunContext} as context from heartbeat_runs`);
      const actual = row.context as Record<string, unknown>;
      expect(actual).not.toHaveProperty("prompt");
      expect(actual).not.toHaveProperty("continuationSnapshot");
      for (const key of ["issueId", "retryReason", "wakeCommentIds", "paperclipWorkspace", "legacyDispositionEpisode", "paperclipWake"]) {
        const expected = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : null;
        expect(actual[key]).toEqual(expected ?? null);
      }
      expect(JSON.stringify(actual).length).toBeLessThan(2000);
    }
  });

  it("detects changes outside the projection for the existing locked race check", async () => {
    const fingerprints = [];
    for (const prompt of ["old", "new"]) {
      const [row] = await db.execute(sql`with heartbeat_runs as (
        select ${JSON.stringify({ issueId: "same", prompt })}::jsonb as context_snapshot)
        select ${recoveryRunContextFingerprint} as fingerprint from heartbeat_runs`);
      fingerprints.push(row.fingerprint);
    }
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it("preserves failure evidence and retry accounting but excludes successful output and usage", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Projection", issuePrefix: "PQ" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Projection", role: "engineer", adapterType: "codex_local" });
    for (const errorCode of [null, "adapter_failed", "provider_quota", "configuration_incomplete"]) {
      const id = randomUUID();
      const resultJson = { finalizationReasonCode: "conversation_turn_finished", provider: { customError: "rate limit", nullable: null }, stdout: "x".repeat(100_000) };
      const run = { id, companyId, agentId, errorCode, status: errorCode ? "failed" : "succeeded",
        resultJson, usageJson: { private: "usage" }, scheduledRetryAttempt: 3, scheduledRetryReason: "workspace_busy",
        contextSnapshot: { issueId: "issue", prompt: "do not return", failureRetriesBeforeWorkspaceWait: 2,
          executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 4 } } };
      await db.insert(heartbeatRuns).values(run);
      const [projected] = await db.select(recoveryRunSelect).from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      expect(projected).not.toHaveProperty("usageJson");
      expect(projected.contextSnapshot).not.toHaveProperty("prompt");
      if (errorCode) expect(projected.resultJson).toEqual(resultJson);
      else { expect(projected.resultJson).not.toHaveProperty("stdout"); expect(projected.resultJson).toHaveProperty("finalizationReasonCode", resultJson.finalizationReasonCode); }
      const [accounting] = await db.select(retryAccountingRunSelect).from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      expect(executionRetryAccounting(accounting)).toEqual(executionRetryAccounting(run));
      expect(accounting.contextSnapshot).not.toHaveProperty("prompt");
    }
  });
});
