## Task: brain-output-store

Goal:
保存每次 LLM 调用的 input、raw output、parsed output、validation result 和 calls.jsonl 审计记录。

Non-goals:
- 不把 Runtime Server 切到真实 LLM。
- 不生成 Agent Reply。
- 不把 brain output 当成原始 evidence。
- 不修改 run state 或执行工具。
- 不读取完整 evidence。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `packages/file-store/src/store.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/output_utils.py`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `packages/llm-integration`

Acceptance criteria:
- [x] Writes `runs/{run_id}/brain/calls.jsonl`.
- [x] Writes call-scoped input/raw/parsed/validation files.
- [x] Uses safe call id path handling and rejects traversal.
- [x] Stores refs relative to the run directory.
- [x] Does not write evidence refs or mutate evidence index.
- [x] LLM code still does not import runtime-core, adapters, or MCP server.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
