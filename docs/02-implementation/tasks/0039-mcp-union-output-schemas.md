# Task: mcp-union-output-schemas

Goal:
Fix MCP tool output schemas for union-shaped Runtime responses so `tools/list` keeps `outputSchema` and `tools/call` does not fail output validation.

Non-goals:
- Do not change Runtime HTTP responses or shared Runtime contracts.
- Do not change tool names or add MCP-only behavior beyond schema compatibility.
- Do not patch the upstream MCP SDK inside `node_modules`.

References checked:
- Windows tester report from 2026-04-29.
- `apps/mcp-server/src/tools.ts`
- `packages/contracts/src/api.ts`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/packages/server/src/server/mcp.ts`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/packages/client/src/client/client.ts`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/docs/server.md`

Scope:
- `apps/mcp-server`

Acceptance criteria:
- [x] MCP `tools/list` includes `outputSchema` for union-response tools.
- [x] MCP `validate_artifact`, `get_evidence`, and `get_run_result` succeed through a real SDK client/server integration path.
- [x] Regression tests cover both list and call behavior for the affected tools.
- [x] Package tests and root quality gates still pass.

Verification:
- [x] `pnpm --filter @artifact-validation/mcp-server test`
- [x] `pnpm test`
- [x] `pnpm typecheck`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
