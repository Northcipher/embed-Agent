## Task: observer-evidence-windows

Goal:
Observer 触发时把 trigger event 关联的 evidence refs 读取成受限 evidence windows，避免 Observer 只能看事件摘要。

Non-goals:
- 不实现完整 Context Budget 策略。
- 不读取整个 run 的所有 evidence。
- 不提供远程 evidence 下载 API。
- 不执行 Observer requested actions。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.14
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 4
- `packages/file-store/src/store.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `apps/runtime-server`

Acceptance criteria:
- [x] Observer input includes evidence windows for trigger event `evidence_refs`.
- [x] Evidence window text is read from local Evidence Index paths under the run directory.
- [x] Missing/unavailable evidence refs are skipped instead of failing Observer processing.
- [x] Window text is bounded to a small P0 limit.
- [x] Existing Observer event behavior remains unchanged.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
