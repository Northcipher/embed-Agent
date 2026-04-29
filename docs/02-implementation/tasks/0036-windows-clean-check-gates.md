# Task: windows-clean-check-gates

Goal:
Make `pnpm typecheck`, `pnpm test`, and `pnpm build` pass on a clean Windows checkout before any generated `dist` files exist.

Non-goals:
- Do not change runtime behavior or public contracts.
- Do not package a Windows installer.
- Do not add platform-specific source code.

References checked:
- Windows tester report from 2026-04-29.
- `tsconfig.base.json`
- `vitest.config.ts`
- workspace package `package.json` scripts.

Scope:
- TypeScript / Vitest workspace configuration.
- Package scripts.
- Release runbook version note.

Acceptance criteria:
- [x] `pnpm typecheck` works after deleting all ignored `dist` directories.
- [x] `pnpm test` works after deleting all ignored `dist` directories.
- [x] `pnpm build` still works.
- [x] Package-level `pnpm --filter <package> test` does not rely on shell glob expansion.
- [x] Windows runbook points testers to the fixed alpha tag.

Verification:
- [x] Delete generated `apps/**/dist` and `packages/**/dist`.
- [x] `pnpm typecheck`
- [x] Delete generated `apps/**/dist` and `packages/**/dist`.
- [x] `pnpm test`
- [x] `pnpm --filter @artifact-validation/runtime-client test`
- [x] `pnpm --filter @artifact-validation/tui test`
- [x] `pnpm --filter @artifact-validation/llm-integration test`
- [x] `pnpm build`
- [x] `pnpm -r --if-present test`
- [x] `pnpm audit --audit-level high`
- [x] Fresh Claude Code review returned no P0/P1/P2 findings.

Owner:
Codex

Reviewer:
Claude Code
