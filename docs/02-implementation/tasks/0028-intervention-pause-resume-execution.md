## Task: intervention-pause-resume-execution

Goal:
让 `pause` / `resume` / `cancel` 干预在 Plan 执行边界真实生效，避免暂停后继续执行后续 step。

Non-goals:
- 不强杀正在运行的 adapter / subprocess。
- 不实现 step 级持久化 cursor 或进程重启后恢复。
- 不允许干预注入 shell 命令或修改 Plan。
- 不改 MCP / CLI / TUI 接口形状。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.18
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 2.3
- `docs/02-implementation/tasks/0006-runtime-plan-executor.md`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/cancellation.py`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `packages/runtime-core`
- `packages/file-store`

Acceptance criteria:
- [x] `pause` during a step allows the current step to finish but blocks the next step.
- [x] `resume` continues from the next unexecuted step and does not re-run completed steps.
- [x] `cancel` before the next step stops execution without overwriting the cancelled terminal state.
- [x] Concurrent intervention and step event writes preserve monotonic event sequence and terminal state.
- [x] Existing plan validation, timeout, and evidence behavior remains unchanged.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-core typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-core test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
