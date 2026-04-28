## Task: run-transition-serialization

Goal:
让同一个 run 的状态转换在 RunManager 内串行执行，避免并发干预基于旧状态校验并覆盖终态。

Non-goals:
- 不改 Run State 枚举和转换表。
- 不实现跨进程分布式锁。
- 不改变 MCP / HTTP / CLI 接口结构。
- 不阻止 step event 写入；事件写入仍由 FileStore 串行化。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` sections 2.2 and 2.3
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.18
- `docs/02-implementation/tasks/0028-intervention-pause-resume-execution.md`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/cancellation.py`

Scope:
- `packages/runtime-core`

Acceptance criteria:
- [x] Concurrent transitions for the same run are evaluated against the latest persisted state.
- [x] A later cancel cannot be overwritten by an earlier paused write completing late.
- [x] Invalid second transitions return `accepted=false` instead of silently overwriting state.
- [x] Existing state machine tests still pass.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-core typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-core test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
