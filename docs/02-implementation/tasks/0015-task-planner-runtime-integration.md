## Task: task-planner-runtime-integration

Goal:
让 RuntimeService 能使用受控 Task Planner 输出生成 Plan，并保持 LLM 只生产结构化 JSON、Orchestrator 负责执行校验。

Non-goals:
- 不接真实 provider 配置文件。
- 不接 Observer 或 Reply Generator。
- 不让 LLM 直接执行工具。
- 不让 Runtime core 依赖具体 LLM SDK。
- 不实现 prompt 热更新或模型路由。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `packages/runtime-core/src/plan-executor.ts`
- `apps/runtime-server/src/service.ts`
- `reference-repos/github/openai-node/README.md`
- `reference-repos/github/anthropic-sdk-typescript/README.md`

Scope:
- `packages/llm-integration`
- `apps/runtime-server`

Acceptance criteria:
- [x] Task Planner runner assembles bounded prompt input.
- [x] Task Planner runner calls provider, parses output, validates policy, and records brain output.
- [x] RuntimeService can use Task Planner result when no hand-written Plan is supplied.
- [x] `clarification_needed` / `plan_rejected` return stable validate_artifact rejection structures.
- [x] RuntimeService transitions created planning runs to failed when planner rejects after run creation.
- [x] Runtime core still does not import LLM provider SDKs.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
