## Task: rule-error-failure-policy

Goal:
让 error 级 `rule_matched` 事件由 Orchestrator 纳入 Plan failure policy，触发后续 `on_failure` 采集并最终失败。

Non-goals:
- 不让 Rule Engine 直接 stop run。
- 不实现 Observer 动态决策。
- 不改变 adapter success / failed 语义。
- 不实现 warning 级规则的停止策略。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` sections 3.7 and 3.13
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` sections 4 and 5
- `docs/02-implementation/tasks/0030-rule-matched-pattern-events.md`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/cancellation.py`

Scope:
- `packages/runtime-core`

Acceptance criteria:
- [x] Error-level `rule_matched` from a step marks that step outcome as fatal for Plan control.
- [x] After an error rule match, subsequent `always` / `on_success` main-path steps are skipped.
- [x] `on_failure` collection steps still execute.
- [x] Final run state is `failed`, while the original adapter step result remains `completed`.
- [x] Warning-level rule matches do not fail the run in this slice.

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
