## Task: llm-integration-foundation

Goal:
提供 LLM Integration 的基础包：provider abstraction、prompt registry/assembler、JSON parser、output validator、mock/gateway/sdk provider 骨架。

Non-goals:
- 不把 Runtime Server 切到真实 LLM。
- 不做远程 prompt 热更新。
- 不让 LLM 读取完整 evidence。
- 不让 LLM 直接调用 MCP tools 或 Tool Adapter。
- 不实现多模型自动路由。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `reference-repos/github/openai-node/README.md`
- `reference-repos/github/anthropic-sdk-typescript/README.md`
- `reference-repos/github/openai-node/src/helpers/zod.ts`
- `reference-repos/github/anthropic-sdk-typescript/src/helpers/json-schema.ts`

Scope:
- `packages/contracts`
- `packages/llm-integration`
- root TypeScript references / lockfile

Acceptance criteria:
- [x] LLM provider interface supports Anthropic, OpenAI, custom Gateway, and Mock。
- [x] Prompt Registry stores local versioned prompt definitions for task_planner / observer / reply_generator。
- [x] Prompt Assembler builds bounded text input and marks truncation。
- [x] Output Parser extracts exactly one JSON object and rejects invalid / multiple JSON objects。
- [x] Output Validator rejects unknown capability, unsupported Observer action, missing evidence refs, and shell command invented without test_hint。
- [x] LLM code does not import runtime-core, adapters, MCP server, or execute tools。

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
