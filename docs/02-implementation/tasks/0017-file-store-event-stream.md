# Task: file-store-event-stream

Goal:
让 `events.jsonl` 的读取更接近“event stream”语义：在事件文件变大时避免整文件读入，并且在并发 append 时对末尾的半行 JSON 保持容错（返回已解析的事件，不因为最后一行没写完而整体失败）。

Non-goals:
- 不实现 SSE / WebSocket streaming。
- 不改变 `events.jsonl` 的落盘格式（仍然是 append-only JSONL）。
- 不实现跨进程锁或 run 恢复重建逻辑（仍按 P0 单 Runtime 进程假设）。
- 不修改 Runtime HTTP API 的 contract。

References checked:
- `reference-repos/github/modelcontextprotocol-servers/src/filesystem/lib.ts` (atomic write patterns)
- `$EMBEDCLAW_MCP_REFERENCE/mcp-server/embedclaw_mcp/response.py` (unified response conventions)
- `$EMBEDCLAW_MCP_REFERENCE/mcp-server/embedclaw_mcp/errors.py` (sanitization patterns)
- `packages/file-store/src/store.ts` (current JSONL append/read behavior)

Scope:
- `packages/file-store`
- root TypeScript project references

Acceptance criteria:
- [x] `FileStore.readEvents()` uses a streaming/line-based reader and can early-exit once `limit` is reached.
- [x] If `events.jsonl` does not end with `\\n` and the final line is not valid JSON, `readEvents()` treats it as an incomplete trailing write and returns previously parsed events (no throw).
- [x] If `events.jsonl` ends with `\\n` and a non-empty line is invalid JSON, `readEvents()` throws a clear error (corruption signal).
- [x] Tests cover the incomplete-trailing-line tolerance case.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
