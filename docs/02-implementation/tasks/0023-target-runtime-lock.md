## Task: target-runtime-lock

Goal:
实现 P0 单进程 target runtime lock，让同一 target 的非终态 run 占用设备并让后续 `validate_artifact` 返回 `busy`。

Non-goals:
- 不实现多 target scheduler。
- 不实现持久化 lease 恢复。
- 不实现跨进程锁。
- 不实现 queue。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `apps/runtime-server/src/service.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/config.py`

Scope:
- `apps/runtime-server`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] Runtime rejects a second run for a busy target with `status=busy` and no run creation.
- [x] Runtime releases target lock when run reaches terminal state.
- [x] `get_run_status` includes target id, runtime state, and current run id.
- [x] `get_target_capabilities` reports busy/idle runtime state from the lock.
- [x] Existing no-profile backward compatibility remains.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
