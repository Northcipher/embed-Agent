## Task: target-runtime-state-phase

Goal:
让 `get_run_status` 在 run 非终态时根据当前 step capability 推导更具体的 target runtime state（`flashing`/`booting`/`adb_ready`）。

Non-goals:
- 不实现独立心跳线程。
- 不引入新的持久化 target state store。
- 不修改 `get_target_capabilities` 的 busy/idle 锁语义。
- 不实现 `offline` / `unknown` 的连接探活。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.10
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 2
- `packages/contracts/src/api.ts`
- `apps/runtime-server/src/service.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/connection_manager.py`

Scope:
- `apps/runtime-server`

Acceptance criteria:
- [x] `get_run_status` returns `target.state=flashing` when current step capability is `flash`.
- [x] `get_run_status` returns `target.state=booting` when current step capability is `watch_serial` or `wait_adb`.
- [x] `get_run_status` returns `target.state=adb_ready` when current step capability is `push`/`shell_exec`/`check_process`.
- [x] Terminal runs still return `target.state=idle`; unknown/unsupported active-step capability falls back to `busy`.

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
