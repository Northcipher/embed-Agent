## Task: runtime-agent-reply-result

Goal:
让 Runtime 在 run 结束后写入最小 Agent Reply，并让 `get_run_result` 返回稳定结果。

Non-goals:
- 不接 LLM Reply Generator。
- 不做长篇报告文件。
- 不声称代码根因。
- 不改变 Evidence 原始事实。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md`
- `packages/file-store/src/store.ts`
- `apps/runtime-server/src/service.ts`

Scope:
- `packages/file-store`
- `apps/runtime-server`

Acceptance criteria:
- [x] FileStore can write/read `reply.json` with AgentReply schema validation.
- [x] Inline plan execution writes rule-based Agent Reply when run reaches terminal state.
- [x] Background plan execution writes rule-based Agent Reply when run reaches terminal state.
- [x] `get_run_result` returns AgentReply when available and unavailable shape while run is non-terminal/no reply.
- [x] Reply summary does not claim code root cause or patch instructions.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
