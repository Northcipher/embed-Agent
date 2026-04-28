## Task: evidence-key-events

Goal:
让带 `evidence_refs` 的关键事件自动进入 Evidence Index 的 `key_events`，保证 `get_evidence` 和最终 Reply 能稳定引用失败现场。

Non-goals:
- 不实现日志窗口切片。
- 不新增 Evidence 下载 API。
- 不修改 Event schema。
- 不把普通 info 级 evidence_collected 都标成关键事件。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `packages/contracts/src/evidence.ts`
- `packages/file-store/src/store.ts`
- `packages/runtime-core/src/plan-executor.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`
- `reference-repos/github/modelcontextprotocol-servers/src/memory/index.ts`

Scope:
- `packages/file-store`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] `rule_matched` events with `evidence_refs` are added to Evidence Index `key_events`.
- [x] Warning/error events with `evidence_refs` are added to `key_events`.
- [x] Info-only evidence collection events are not promoted to key events.
- [x] Existing explicit `addKeyEvent` uniqueness by sequence remains.
- [x] `get_evidence` sees the updated key events through the existing index read path.

Verification:
- [x] `pnpm --filter @artifact-validation/file-store typecheck`
- [x] `pnpm --filter @artifact-validation/file-store test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
