## Task: runtime-llm-config-wiring

Goal:
用 `configs/llm.yaml` 配置创建 Task Planner 和 Reply Generator runner，并让 Runtime Server 可以通过配置启用 LLM 增强路径。

Non-goals:
- 不让 Runtime core 依赖 LLM SDK。
- 不接 Observer 运行中闭环。
- 不改变 MCP / CLI / TUI 对外接口。
- 不在仓库写入真实 API key。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md`
- `packages/llm-integration/src/providers.ts`
- `packages/llm-integration/src/task-planner-runner.ts`
- `packages/llm-integration/src/reply-generator-runner.ts`
- `reference-repos/github/openai-node/examples`
- `reference-repos/github/anthropic-sdk-typescript/examples`

Scope:
- `packages/llm-integration`
- `apps/runtime-server`
- `configs`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] `configs/llm.yaml` exists as a safe example with no secrets.
- [x] LLM config loader validates `anthropic` / `openai` / `gateway` / `mock` providers.
- [x] Missing provider or missing required env var fails with a clear error.
- [x] Runtime Server can build Task Planner and Reply Generator from config without changing RuntimeService contracts.
- [x] Mock config path can run a full inline validation without real LLM.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
