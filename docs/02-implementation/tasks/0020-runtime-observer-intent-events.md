## Task: runtime-observer-intent-events

Goal:
让 Runtime 在失败/异常触发事件后调用可选 Observer，并把 Observer 输出写入 Event Stream。

Non-goals:
- 不执行 Observer requested_actions。
- 不做定时 Observer loop。
- 不读取完整 evidence 日志给 Observer。
- 不改变 MCP / CLI / TUI 接口。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `packages/llm-integration/src/observer-runner.ts`
- `apps/runtime-server/src/service.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `apps/runtime-server`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] RuntimeService accepts an optional Observer abstraction.
- [x] Runtime invokes Observer after trigger events from plan execution.
- [x] Accepted `intermediate_observation` writes `intermediate_observation` event.
- [x] Accepted non-observation intent writes `observer_intent` event.
- [x] Rejected Observer output writes `observer_intent` event with rejection reasons.
- [x] Runtime does not execute Observer requested actions in this slice.

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
