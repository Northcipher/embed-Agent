## Task: rule-matched-pattern-events

Goal:
把 `watch_serial` adapter 输出的 pattern 命中转换成 Runtime `rule_matched` 事件，进入 Event Stream 和 Evidence Index。

Non-goals:
- 不实现完整 Rule Engine 配置文件。
- 不实现 debounce、silence、connectivity、exit_code 规则。
- 不让 Rule Engine 直接 stop run 或修改 Plan。
- 不改变 adapter 输出契约。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.13
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 5
- `packages/adapters/src/fake-adapter.ts`
- `packages/adapters/src/real-adapters.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `packages/runtime-core`

Acceptance criteria:
- [x] `watch_serial` step with failure-like `output.patterns_matched` writes one `rule_matched` event per relevant pattern.
- [x] `rule_matched` event uses `source=rule_engine`, includes `rule_id`, `pattern`, `step_id`, and evidence refs.
- [x] Panic / oops / fatal-like serial patterns use `severity=error`; other failure-signal matches use `warning`.
- [x] FileStore promotes those `rule_matched` events into Evidence Index `key_events`.
- [x] Existing plan execution behavior remains otherwise unchanged.

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
