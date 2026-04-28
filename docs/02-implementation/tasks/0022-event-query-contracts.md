## Task: event-query-contracts

Goal:
补齐 `get_run_events.types` 查询链路，让 Runtime HTTP、Runtime Client、MCP/CLI wrapper 都按共享契约传递事件类型过滤。

Non-goals:
- 不实现 SSE / WebSocket streaming。
- 不实现 `watch_run.wait_sec` 长轮询等待。
- 不改变 Event schema。
- 不改变 MCP tool 名称。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `packages/contracts/src/api.ts`
- `packages/file-store/src/store.ts`
- `apps/runtime-server/src/server.ts`
- `packages/runtime-client/src/index.ts`

Scope:
- `apps/runtime-server`
- `packages/runtime-client`
- `apps/mcp-server`
- `apps/cli`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] Runtime HTTP parses `types` query parameter for `get_run_events`.
- [x] RuntimeService forwards event type filters to FileStore.
- [x] Runtime HTTP rejects invalid event type filters via shared contract parsing.
- [x] RuntimeHttpClient sends `types` query values.
- [x] MCP `watch_run` and `get_run_events` preserve event type filters.
- [x] CLI events/watch commands preserve event type filters if exposed.

Verification:
- [x] `pnpm --filter @artifact-validation/contracts typecheck`
- [x] `pnpm --filter @artifact-validation/contracts test`
- [x] `pnpm --filter @artifact-validation/contracts build`
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm --filter @artifact-validation/runtime-client typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-client test`
- [x] `pnpm --filter @artifact-validation/mcp-server typecheck`
- [x] `pnpm --filter @artifact-validation/mcp-server test`
- [x] `pnpm --filter @artifact-validation/cli typecheck`
- [x] `pnpm --filter @artifact-validation/cli test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
