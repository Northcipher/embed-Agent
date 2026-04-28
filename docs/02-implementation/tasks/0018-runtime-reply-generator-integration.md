## Task: runtime-reply-generator-integration

Goal:
让 Runtime 在 run 进入终态后优先调用可选 Reply Generator，并在生成失败或未配置时回退到规则版 Agent Reply。

Non-goals:
- 不接真实 Anthropic / OpenAI / Gateway 配置。
- 不让 Reply Generator 修改 run state、Plan、Event 或 Evidence。
- 不改变 MCP / CLI / TUI 接口契约。
- 不做 Observer 运行中闭环。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md`
- `packages/llm-integration/src/reply-generator-runner.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `packages/file-store`
- `apps/runtime-server`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] FileStore can read the persisted validation request for reply-generation context.
- [x] RuntimeService accepts an optional Reply Generator abstraction.
- [x] Terminal reply generation passes bounded run/request/event/evidence context to the generator.
- [x] Generated Agent Reply is schema-validated by FileStore write and returned by `get_run_result`.
- [x] Generator failure falls back to the existing rule-based Agent Reply.
- [x] Rule-based behavior remains unchanged when no generator is configured.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
