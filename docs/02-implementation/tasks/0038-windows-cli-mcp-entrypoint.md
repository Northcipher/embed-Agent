# Task: windows-cli-mcp-entrypoint

Goal:
Fix Windows direct invocation for the CLI and MCP server so `node .../dist/index.js` actually runs `main()`.

Non-goals:
- Do not change Runtime Server HTTP behavior or public contracts.
- Do not add new MCP tools or CLI commands.
- Do not change TUI behavior.

References checked:
- Windows tester report from 2026-04-29.
- `apps/runtime-server/src/cli.ts`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/README.md`
- `reference-repos/github/modelcontextprotocol-servers/src/everything/index.ts`
- `reference-repos/github/modelcontextprotocol-servers/src/everything/transports/stdio.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/__main__.py`

Scope:
- `apps/cli`
- `apps/mcp-server`

Acceptance criteria:
- [x] CLI direct entrypoint detection works with Windows script paths.
- [x] MCP server direct entrypoint detection works with Windows script paths.
- [x] Regression tests cover the Windows path conversion without requiring a Windows host.
- [x] Package tests and root quality gates still pass.

Verification:
- [x] `pnpm --filter @artifact-validation/cli test`
- [x] `pnpm --filter @artifact-validation/mcp-server test`
- [x] `pnpm test`
- [x] `pnpm typecheck`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
