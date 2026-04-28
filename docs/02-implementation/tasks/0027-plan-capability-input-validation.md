## Task: plan-capability-input-validation

Goal:
让 Plan Executor 在执行前校验 P0 capability 的最小输入结构和 timeout 上限，避免无效 Plan 进入 Tool Adapter。

Non-goals:
- 不实现完整 policy engine。
- 不实现 target profile 级动态 limit 合并。
- 不修改 Plan schema。
- 不校验真实设备连接参数；连接事实仍只来自 Target Profile。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md`
- `packages/runtime-core/src/plan-executor.ts`
- `packages/contracts/src/capabilities.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/response.py`

Scope:
- `packages/runtime-core`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] Invalid capability inputs are rejected before execution.
- [x] Step timeout above P0 capability limit is rejected before execution.
- [x] Existing valid demo plans still execute.
- [x] Rejection returns `plan_rejected` through existing PlanExecutor path.
- [x] No Tool Adapter is called for rejected plans.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-core typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-core test`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
