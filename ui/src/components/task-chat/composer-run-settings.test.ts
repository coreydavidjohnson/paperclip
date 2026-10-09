import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  composerCatalogProvider, composerEfforts, composerFastAvailable, mergeComposerRunSettings,
  readComposerRunSettings, supportsComposerModel,
} from "./composer-run-settings";

const agent = (adapterType: Agent["adapterType"], provider?: string) => ({
  adapterType, adapterConfig: provider ? { provider } : {},
}) as Agent;

describe("composer run settings", () => {
  it("shows only effort levels known for the selected harness and model", () => {
    expect(composerEfforts(agent("codex_local"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "codex"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "opencode"), "gpt-6-astra", [])).toEqual([]);
    expect(composerEfforts(agent("codex_local"), "custom-private-model", [])).toEqual([]);
    expect(composerEfforts(agent("opencode_local"), "openrouter/x/y", ["openrouter/x/y"])).toEqual([]);
    expect(composerEfforts(agent("claude_local"), "claude-sonnet-5", ["claude-sonnet-5"])).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(composerEfforts(agent("claude_local"), "claude-haiku-4-5", ["claude-haiku-4-5"])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", ["grok-4.7"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", [])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "", ["grok-build"])).toEqual(["low", "medium", "high"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/k3", ["kimi-code/k3"])).toEqual([]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: "cli" } }, "kimi-code/k3", ["kimi-code/k3"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: " CLI " } }, "", ["kimi-code/kimi-for-coding"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/kimi-for-coding-highspeed", ["kimi-code/kimi-for-coding-highspeed"])).toEqual([]);
    expect(composerFastAvailable(agent("codex_local"), "gpt-6-astra")).toBe(true);
    expect(composerFastAvailable(agent("codex_local"), "custom-private-model")).toBe(false);
    expect(supportsComposerModel(agent("process"))).toBe(false);
    expect(composerCatalogProvider({ ...agent("opencode_local"), adapterConfig: { model: "openrouter/qwen/qwen3-coder-next" } })).toBe("openrouter");
  });

  it("uses declared capabilities for any external adapter", () => {
    const external = agent("external_test" as Agent["adapterType"]);
    const catalog = [{ id: "provider/sonnet", label: "Sonnet", reasoningEfforts: ["low", "high"] }];
    expect(supportsComposerModel(external, catalog)).toBe(true);
    expect(supportsComposerModel(external, [])).toBe(false);
    expect(composerEfforts(external, "provider/sonnet", ["provider/sonnet"], catalog)).toEqual(["low", "high"]);
    expect(composerEfforts(external, "unknown", ["provider/sonnet"], catalog)).toEqual([]);
    expect(composerEfforts(external, "provider/sonnet", ["provider/sonnet"], [{ id: "provider/sonnet", label: "Sonnet" }])).toEqual([]);
  });

  it("round-trips native external model and effort keys without losing unrelated overrides", () => {
    const previous = { adapterConfig: { chrome: true, model: "old", effort: "low" }, useProjectWorkspace: true };
    const selected = { model: "provider/sonnet", effort: "high", fast: false };
    const merged = mergeComposerRunSettings(previous, "external_test", selected);
    expect(merged).toEqual({ adapterConfig: { chrome: true, model: "provider/sonnet", effort: "high" }, useProjectWorkspace: true });
    expect(readComposerRunSettings(merged, "external_test")).toEqual(selected);
    const reset = mergeComposerRunSettings(merged, "external_test", { model: null, effort: null, fast: false });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "external_test")).toEqual({ model: null, effort: null, fast: false });
  });

  it("preserves unrelated task overrides while changing or resetting run settings", () => {
    const previous = { adapterConfig: { chrome: true, model: "old", effort: "low" }, useProjectWorkspace: true };
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-opus", effort: "high", fast: false }))
      .toEqual({ adapterConfig: { chrome: true, model: "claude-opus", effort: "high" }, useProjectWorkspace: true });
    const reset = mergeComposerRunSettings(previous, "claude_local", { model: null, effort: null, fast: false });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "claude_local")).toEqual({ model: null, effort: null, fast: false });
    expect(readComposerRunSettings({ adapterConfig: { reasoningEffort: "xhigh" } }, "codex_local").effort).toBe("xhigh");
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } });
    const runner = mergeComposerRunSettings(null, "paperclip_runner", { model: "gpt-6-astra", effort: "ultra", fast: false });
    expect(runner).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra" } });
    expect(readComposerRunSettings(runner, "paperclip_runner").effort).toBe("ultra");
    const grok = mergeComposerRunSettings(null, "grok_local", { model: "grok-4.7", effort: "xhigh", fast: false });
    expect(grok).toEqual({ adapterConfig: { model: "grok-4.7", reasoningEffort: "xhigh" } });
    expect(readComposerRunSettings(grok, "grok_local").effort).toBe("xhigh");
  });
});
