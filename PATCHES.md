# Luma Paperclip patches

Base: `v2026.1005.0`, commit `467125fafb47a8520856504fecc48d6e32055db1`.
`upstream` follows `paperclipai/master`; `luma` carries the following separate
commits. There are no upstream issue or PR links by Corey's instruction.

## 1. External adapter composer capabilities

- Why: the built-in adapter allowlist hid task model/effort controls for
  external adapters even when they advertised models.
- Files: `packages/adapter-utils/src/types.ts`, `ui/src/api/agents.ts`,
  `ui/src/components/task-chat/composer-run-settings.ts`,
  `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx`, and their two tests.
- Contract: a nonempty model catalog enables model selection. Optional
  `AdapterModel.reasoningEfforts` declares each model's effort choices.
  External settings use native `issue.assigneeAdapterOverrides.adapterConfig`
  `model` and `effort` keys. Built-in mappings remain compatible.
- Removal condition: upstream ships equivalent capability.
- Test: `pnpm --filter @paperclipai/ui exec vitest run
  src/components/task-chat/composer-run-settings.test.ts
  src/components/task-chat/ComposerRunSettingsPicker.test.tsx`.
  Includes an arbitrarily named external adapter, catalog fetch, effort/model
  selections, reset, unrelated override preservation and built-in regressions.

## 2. Patch tests gate production image builds

- Why: prevent publishing a fork image with a broken carried composer patch.
- Files: `Dockerfile`.
- Removal condition: upstream ships equivalent capability.
- Test: build `Dockerfile` target `production`; the `luma-patch-tests` stage
  must pass both patch test files and `pnpm check:token-gates` before app copy.

## Earlier image modifications inventory

Before this fork, homelab used the unmodified upstream release image and added
its own OmniGenT adapter plus `register-adapter.sh` entrypoint. These remain
homelab-owned integration files, not carried patches to Paperclip source.
The old held `omnigent-task-chat-picker.patch` was never applied or deployed;
it is superseded by patch 1, not part of the fork build.
