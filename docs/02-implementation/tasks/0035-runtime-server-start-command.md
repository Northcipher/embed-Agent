# Task: runtime-server-start-command

Goal:
Add a safe local Runtime Server start command so release testers can run the HTTP API from a fresh checkout.

Non-goals:
- Do not change RuntimeService ownership or execution semantics.
- Do not make real hardware execution the default.
- Do not add Web UI or packaging for external distribution.

References checked:
- `reference-repos/github/fastify/examples/simple.js`
- `reference-repos/github/fastify/examples/typescript-server.ts`
- `apps/runtime-server/src/server.ts`
- `apps/runtime-server/test/runtime-server.test.ts`

Scope:
- `apps/runtime-server`
- root package scripts
- release / Windows test documentation

Acceptance criteria:
- [x] Runtime Server package exposes a CLI bin that can listen on a local host/port.
- [x] Default startup path uses fake adapters unless real adapters are explicitly requested.
- [x] Demo plan mode does not invent an adb smoke command when `context.test_hint` is absent.
- [x] Tests cover CLI option parsing and fake demo plan execution through the HTTP API.
- [x] Windows test hand-runbook documents prerequisites, build/test gates, startup, smoke validation, evidence inspection, and known limits.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm audit --audit-level high`
- [x] Built Runtime Server startup smoke: fake demo validation completed with `flash:log`, `serial:full`, `adb:step-smoke`, `log:dmesg`.
- [x] Fresh Claude Code review returned no P0/P1/P2 findings.

Owner:
Codex

Reviewer:
Codex self-review before release; external Claude Code review unavailable from this runtime unless the user runs it separately.
