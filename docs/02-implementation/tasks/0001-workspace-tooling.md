# Task: workspace-tooling

Goal:
建立 TypeScript monorepo 的最小工作区骨架，让后续 contracts / runtime / MCP / TUI 切片有统一的类型检查、测试和构建入口。

Non-goals:
- 不实现 Runtime 状态机。
- 不实现 MCP tool。
- 不实现 TUI。
- 不接真实设备、ADB、fastboot 或 serial。
- 不接真实 LLM provider。

References checked:
- `reference-repos/github/modelcontextprotocol-typescript-sdk`
- `reference-repos/github/modelcontextprotocol-servers`
- `reference-repos/github/fastify`
- `$EMBEDCLAW_MCP_REFERENCE`

Scope:
- root workspace config
- `packages/contracts` placeholder package
- implementation workflow docs
- reference implementation docs

Acceptance criteria:
- [x] pnpm workspace exists.
- [x] root scripts expose `build`, `typecheck`, `test`, and `check`.
- [x] `packages/contracts` builds as a composite TypeScript package.
- [x] generated build outputs and local runtime data are ignored.
- [x] local reference repositories are ignored from git while their index docs remain tracked.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
