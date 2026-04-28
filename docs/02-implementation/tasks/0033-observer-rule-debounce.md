## Task: observer-rule-debounce

Goal:
对 `rule_matched` 触发 Observer 增加 P0 默认 debounce（同一 `rule_id` 30s 内只触发一次），减少重复告警导致的重复 Observer 调用。

Non-goals:
- 不实现完整 Rule Engine 配置热更新。
- 不改变 `step_failed` / `step_timeout` 的 Observer 触发策略。
- 不实现跨进程共享 debounce 状态。
- 不执行 Observer requested actions。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.13/3.14
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` sections 4.2 and 4.3
- `apps/runtime-server/src/service.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/cancellation.py`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `apps/runtime-server`

Acceptance criteria:
- [x] Repeated `rule_matched` trigger events with the same `payload.rule_id` within 30 seconds only invoke Observer once.
- [x] Different `rule_id` values can still trigger Observer independently.
- [x] `step_failed`/`step_timeout` triggers are unaffected.
- [x] Existing bounded-trigger behavior remains intact.

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
