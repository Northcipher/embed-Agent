# Embed Agent

## 项目文档

编码前先读：
- `docs/01-foundation/EMBED-AGENT-ARCHITECTURE.md` — 架构（27 Sections）
- `docs/02-design/` — 详细设计（7 份）
- `docs/04-planning/02-coding-standards.md` — 编码规范
- `docs/04-planning/05-feature-checklist.md` — 功能清单

## Commit 规则

- 禁止 `Co-Authored-By` 伪作者
- 禁止 `--no-verify` 绕过 hooks
- 一个 commit 只做一件事
- 格式: `<type>: <简短描述>`

## 边界规则

- Runtime 是唯一状态 owner。MCP/CLI/TUI 是 thin adapter
- Tool 不调 LLM。Agent 不碰设备
- Interface 不持状态。只发 Command、只读 View
- 不暴露 `device_exec` 作为产品接口
- Agent 不直接读 Config。只收 ContextAssembler 组装好的 Context
- DH 不订阅 DecisionMade。Observer Decision 走直接调用
- Observer 不看全量日志
- 先写 Event，再推进状态
- Reply 是 result_ready 唯一发布者
