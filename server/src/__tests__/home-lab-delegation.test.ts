import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeHomeLabChild } from "../services/home-lab-delegation.js";

function fixture() {
  const callerId = randomUUID(), targetId = randomUUID(), companyId = randomUUID();
  const parentId = randomUUID(), runId = randomUUID();
  const actor: Express.Request["actor"] = { type: "agent", source: "agent_jwt",
    agentId: callerId, companyId, runId, onBehalfOfUserId: "board-user", keyScope: { kind: "standard" } };
  const caller = { id: callerId, companyId, name: "Client", status: "idle" };
  const target = { id: targetId, companyId, name: "Home Lab", status: "idle" };
  const parent = { id: parentId, companyId, assigneeAgentId: callerId,
    assigneeUserId: null, status: "in_progress", createdByAgentId: targetId };
  const run = { id: runId, companyId, agentId: callerId, status: "running",
    responsibleUserId: "board-user", contextSnapshot: { issueId: parentId }, resultJson: null,
    nativeIssueId: null, activeIdentityContextId: null };
  const body = { assigneeAgentId: targetId, status: "todo", blockParentUntilDone: true };
  const rows: unknown[][] = [[target], [caller, target], [parent], [run]];
  const locks: string[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => {
      const values = rows.shift()!;
      return { then: (resolve: (value: unknown) => unknown) => Promise.resolve(values).then(resolve),
        for: (mode: string) => { locks.push(mode); return Promise.resolve(values); } };
    } }) }),
    execute: async () => { locks.push("identity-table"); },
  };
  return { actor, parentId, caller, target, parent, run, body, rows, locks, db: db as any };
}

describe("bounded native Home Lab child delegation", () => {
  it.each(["North Labs", "Personal", "Huron", "Client"])("accepts %s beneath a Home Lab-created parent", async (name) => {
    const f = fixture(); f.caller.name = name;
    expect(await authorizeHomeLabChild(f.db, f.parentId, f.actor, f.body, true)).toBe(true);
    expect(f.locks).toEqual(["identity-table", "update", "share"]);
  });
  it("accepts the existing MCP agent key plus exact run binding", async () => {
    const f = fixture(); f.actor.source = "agent_key";
    expect(await authorizeHomeLabChild(f.db, f.parentId, f.actor, f.body, true)).toBe(true);
  });
  it("leaves other targets on ordinary authorization", async () => {
    const f = fixture(); f.target.name = "Other";
    expect(await authorizeHomeLabChild(f.db, f.parentId, f.actor, f.body)).toBe(false);
  });
  it("does not grant board actors or standalone writes", async () => {
    const f = fixture(); f.actor.type = "board";
    expect(await authorizeHomeLabChild(f.db, f.parentId, f.actor, f.body)).toBe(false);
  });
  const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["no run", f => { delete f.actor.runId; }],
    ["unauthenticated source", f => { f.actor.source = "none"; }],
    ["scoped key", f => { f.actor.keyScope = { kind: "skill_test", issueId: f.parentId } as any; }],
    ["wrong status", f => { f.body.status = "in_progress"; }],
    ["no parent blocker", f => { f.body.blockParentUntilDone = false; }],
    ["additional prerequisites", f => { Object.assign(f.body, { blockedByIssueIds: [randomUUID()] }); }],
    ["user assignment", f => { Object.assign(f.body, { assigneeUserId: "board" }); }],
    ["owner changed", f => { f.parent.assigneeAgentId = randomUUID(); }],
    ["terminal parent", f => { f.parent.status = "done"; }],
    ["wrong issue run", f => { f.run.contextSnapshot.issueId = randomUUID(); }],
    ["native issue mismatch", f => { Object.assign(f.run, { nativeIssueId: randomUUID() }); }],
    ["stopped run", f => { f.run.status = "cancelled"; }],
    ["stop requested before executor settles", f => { Object.assign(f.run, { resultJson: { executionCancellation: { state: "requested" } } }); }],
    ["responsible identity changed", f => { f.run.responsibleUserId = "another-user"; }],
    ["identity changed", f => { Object.assign(f.run, { activeIdentityContextId: randomUUID() }); }],
    ["target paused", f => { f.target.status = "paused"; }],
    ["target unknown", f => { f.target.status = "unknown"; }],
    ["caller paused", f => { f.caller.status = "paused"; }],
    ["duplicate target", f => { (f.rows[1] as unknown[]).push({ ...f.target, id: randomUUID() }); }],
    ["missing caller", f => { f.rows[1] = [f.target]; }],
    ["foreign-company target", f => { f.rows[1] = [f.caller]; }],
    ["foreign-company parent", f => { f.rows[2] = []; }],
    ["wrong-company or wrong-agent run", f => { f.rows[3] = []; }],
  ];
  it.each(mutations)("rejects %s", async (_label, mutate) => {
    const f = fixture(); mutate(f);
    await expect(authorizeHomeLabChild(f.db, f.parentId, f.actor, f.body, true)).rejects.toThrow();
  });
});
