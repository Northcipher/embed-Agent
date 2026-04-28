# Task: file-store-events

Goal:
实现 P0 本地文件存储骨架，让 `run.json`、`events.jsonl`、`evidence-index.json` 能稳定写入和读取。

Non-goals:
- 不实现 Runtime 状态机。
- 不实现 Tool Adapter。
- 不实现 HTTP / MCP / CLI / TUI。
- 不接真实设备或真实 LLM。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-ARCHITECTURE.md` section 11 and 13.5
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` sections 3.15 and 3.16
- `reference-repos/github/modelcontextprotocol-servers/src/filesystem/lib.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`

Scope:
- `packages/file-store`
- root TypeScript project references

Acceptance criteria:
- [x] A run directory can be initialized with `run.json`, `events.jsonl`, and `evidence-index.json`.
- [x] Events append as JSONL with store-assigned monotonic `seq`.
- [x] Events can be read by `after_seq`, `limit`, and optional event types.
- [x] Evidence refs write content under the run directory before updating `evidence-index.json`.
- [x] Evidence paths reject absolute paths and `..` traversal.
- [x] Atomic JSON writes use temp file + rename.

Known P0 limitations:
- Event append is safe for the P0 single Runtime process model, but it does not implement cross-process locking.
- If a process crashes between `events.jsonl` append and `run.json` update, recovery should rebuild `last_event_seq` from `events.jsonl` in a later recovery slice.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
