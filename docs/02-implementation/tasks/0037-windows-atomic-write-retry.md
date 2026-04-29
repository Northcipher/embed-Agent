# Task: windows-atomic-write-retry

Goal:
Fix Windows `EPERM` failures during FileStore atomic replacement so runtime tests do not leave `run.json` missing.

Non-goals:
- Do not change Run / Event / Evidence contracts.
- Do not change PlanExecutor pause/resume semantics.
- Do not make Windows real-device certification part of this task.

References checked:
- Windows tester report from 2026-04-29.
- `packages/file-store/src/store.ts`
- `packages/runtime-core/test/plan-executor.test.ts`
- `apps/runtime-server/test/runtime-server.test.ts`

Scope:
- `packages/file-store`
- release notes / Windows runbook version.

Acceptance criteria:
- [x] File replacement retries transient Windows `EPERM` / `EACCES` / `EBUSY` rename failures.
- [x] Persistent Windows replace lock errors fall back to copy-overwrite and temp cleanup when a target file exists.
- [x] Regression tests cover transient retry and fallback without relying on a Windows host.
- [x] Full quality gates pass.
- [x] Windows runbook points testers to the fixed alpha tag.

Verification:
- [x] `pnpm --filter @artifact-validation/file-store test`
- [x] `pnpm --filter @artifact-validation/runtime-core test`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm test`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm audit --audit-level high`
- [x] Fresh Claude Code re-review returned no P0/P1/P2 findings.

Owner:
Codex

Reviewer:
Claude Code
