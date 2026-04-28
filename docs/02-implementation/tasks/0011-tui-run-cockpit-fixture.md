## Task: tui-run-cockpit-fixture

Goal:
提供 Ink TUI 的 Run Cockpit 静态 fixture 视图，让 Human 能快速看懂一次 run 的状态、事件和证据。

Non-goals:
- 不接 Runtime HTTP 轮询。
- 不实现输入交互 / pause / cancel 快捷键。
- 不保存 run / target 状态。
- 不读取 `.artifact-agent` 文件。
- 不执行 adb / serial / fastboot / shell。

References checked:
- `reference-repos/github/ink/readme.md`
- `reference-repos/github/ink/test/render-to-string.tsx`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-UI-UX.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.21

Scope:
- `apps/tui`
- root TypeScript project references / lockfile

Acceptance criteria:
- [x] TUI app renders an Ink Run Cockpit fixture without reading Runtime files。
- [x] View shows run id, status, target state, elapsed time, event cursor, timeline, evidence refs, and result availability。
- [x] Component is presentational and receives all data via props。
- [x] Tests use Ink `renderToString` and fixture data。
- [x] No generic `device_exec` or raw shell command is exposed。

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
