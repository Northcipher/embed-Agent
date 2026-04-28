# Task: contracts-foundation

Goal:
把 P0 运行链路需要共享的 JSON 契约落成 Zod schema 和 TypeScript types，供后续 Runtime、MCP、CLI、TUI 复用。

Non-goals:
- 不实现 Runtime 状态机。
- 不实现 Plan / Intent policy 校验。
- 不实现 HTTP API、MCP tool、CLI 或 TUI。
- 不接真实设备或真实 LLM。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/packages/server/src/server/mcp.examples.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`

Scope:
- `packages/contracts/src`
- `packages/contracts/test`

Acceptance criteria:
- [x] Core enum schemas exist for run states, event types, capabilities, severities, and intervention actions.
- [x] P0 API input/output schemas exist for validate, status, watch/events, evidence, result, intervention, cancel, and target capabilities.
- [x] Plan, Observer Intent, Event, Evidence Index, Agent Reply, Capability Definition, and public error schemas export inferred TypeScript types.
- [x] Tests cover representative valid examples and key rejection paths.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
