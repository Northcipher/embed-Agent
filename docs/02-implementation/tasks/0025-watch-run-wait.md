## Task: watch-run-wait

Goal:
让 `watch_run.wait_sec` 生效：在没有新事件时低频轮询到超时或出现新事件，而不是解析后忽略。

Non-goals:
- 不实现真正 streaming。
- 不新增 Runtime Server 长连接接口。
- 不让 MCP Server 保存 run 状态。
- 不修改 Event Stream 存储结构。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `packages/contracts/src/api.ts`
- `apps/mcp-server/src/tools.ts`
- `apps/cli/src/index.ts`
- `reference-repos/github/modelcontextprotocol-servers/src/everything/tools/trigger-long-running-operation.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/server.py`

Scope:
- `packages/runtime-client`
- `apps/mcp-server`
- `apps/cli`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] `RuntimeHttpClient.watchRun` returns status plus events using the shared watch_run contract.
- [x] `wait_sec=0` performs a single poll.
- [x] `wait_sec>0` polls until events arrive or deadline expires.
- [x] MCP `watch_run` uses the shared client method and preserves `wait_sec`.
- [x] CLI watch uses the shared client method without redefining watch semantics.

Verification:
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
