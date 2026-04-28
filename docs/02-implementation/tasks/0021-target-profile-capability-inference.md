## Task: target-profile-capability-inference

Goal:
把 Target Profile 和 Capability Inference 接入 Runtime，让 target 存在性、连接事实、安全开关影响可用能力和 Plan 校验。

Non-goals:
- 不实现 target profile 热加载或编辑接口。
- 不实现多 target scheduler / queue。
- 不接真实设备自动发现。
- 不改变 MCP / CLI / TUI 对外接口名称。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `apps/runtime-server/src/service.ts`
- `packages/adapters/src/real-adapters.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/config.py`

Scope:
- `packages/contracts`
- `packages/runtime-core`
- `apps/runtime-server`
- `configs/targets`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] Target Profile schema and TypeScript type exist.
- [x] Example `configs/targets/board-01.json` exists without secrets.
- [x] Runtime can be configured with target profiles and returns `target_not_found` for unknown validate targets.
- [x] `get_target_capabilities` derives available capabilities from profile connections, safety, request constraints, and adapter coverage.
- [x] Plan execution rejects capabilities not inferred for the selected target/request.
- [x] Artifact type mismatch against target flash profile returns `artifact_invalid`.

Verification:
- [x] `pnpm --filter @artifact-validation/contracts typecheck`
- [x] `pnpm --filter @artifact-validation/contracts test`
- [x] `pnpm --filter @artifact-validation/contracts build`
- [x] `pnpm --filter @artifact-validation/runtime-core typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-core test`
- [x] `pnpm --filter @artifact-validation/runtime-core build`
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm --filter @artifact-validation/runtime-server build`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
