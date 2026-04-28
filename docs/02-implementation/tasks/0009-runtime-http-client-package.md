## Task: runtime-http-client-package

Goal:
把 Runtime HTTP 调用逻辑抽成共享 package，供 MCP / CLI / TUI thin adapter 复用。

Non-goals:
- 不新增 CLI / TUI 功能。
- 不改变 Runtime HTTP API。
- 不改变 MCP tool 对外语义。
- 不执行 adb / serial / fastboot / shell。

References checked:
- `apps/mcp-server/src/runtime-client.ts`
- `apps/runtime-server/src/server.ts`
- `packages/contracts/src/api.ts`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md`
- `AGENTS.md`

Scope:
- `packages/runtime-client`
- `apps/mcp-server`
- root TypeScript project references / lockfile

Acceptance criteria:
- [x] Shared package exports `RuntimeHttpClient` and typed `RuntimeClientResult`。
- [x] MCP server imports Runtime HTTP client through the shared package, not app-local implementation。
- [x] Runtime client still validates responses with shared contracts。
- [x] Runtime public errors still become structured client errors without throwing。
- [x] Tests cover POST, GET URL encoding, public errors, and non-contract Runtime responses。

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
