## Task: observer-reply-runners

Goal:
补齐 Observer Runner 和 Reply Generator Runner，让运行中判断与最终回复都具备 provider 调用、JSON 解析、输出校验、brain audit 和失败降级。

Non-goals:
- 不接 Runtime 事件触发。
- 不让 Observer 直接执行 requested_actions。
- 不读取完整 evidence。
- 不接真实 provider 配置文件。
- 不改变 Runtime core 状态机。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `packages/llm-integration/src/task-planner-runner.ts`
- `packages/llm-integration/src/validators.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/output_utils.py`

Scope:
- `packages/llm-integration`

Acceptance criteria:
- [x] Observer Runner assembles bounded input, calls provider, parses JSON, validates intent, records brain output.
- [x] Observer Runner rejects unsupported requested actions and returns a safe fallback intent.
- [x] Reply Generator Runner assembles bounded input, validates evidence refs, records brain output.
- [x] Reply Generator Runner falls back to rule-based reply on timeout/parse/validation failure.
- [x] Both runners keep LLM output as structured producer output only.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
