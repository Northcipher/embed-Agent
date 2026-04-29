# Artifact Validation Agent 实现协作流程

> 状态：Draft  
> 日期：2026-04-28  
> 目的：定义进入编码后的工作方式，包括功能切片、参考代码检查、Codex / Claude Code 分工、commit、review 和验收。  
> 关系：技术栈见 [../01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md](../01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md)；参考实现见 [../01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md](../01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md)；根规则见 [../../AGENTS.md](../../AGENTS.md)。

## 1. 核心原则

实现方式固定为：

```text
contract-first
runtime-first
reference-first
small-slice
test-before-merge
multi-model review
```

解释：

| 原则 | 含义 |
|---|---|
| contract-first | 先定 types / schema / public response，再写实现。 |
| runtime-first | 先手写 Plan 跑通 Runtime-only，再接 TUI / MCP / LLM。 |
| reference-first | 写代码前先看本地参考仓库和 embedclaw 对应实现。 |
| small-slice | 每次只做一个可验证小切片，不堆大改。 |
| test-before-merge | 没有验证结果，不进入 review。 |
| multi-model review | 一个模型写，另一个模型审，Human 做最终取舍。 |

## 2. 每个功能怎么做

每个功能必须走 8 步。

| 步骤 | 动作 | 产物 |
|---:|---|---|
| 1 | 读当前 spec / contracts / reference。 | 明确本次范围和参考路径。 |
| 2 | 写或确认 task card。 | 目标、非目标、验收标准、文件范围。 |
| 3 | 定 contract。 | Zod schema、types、fixtures、错误结构。 |
| 4 | 写最小实现。 | 一个可运行薄切片。 |
| 5 | 写测试。 | 单元 / 集成 / fixture 测试。 |
| 6 | 本地验证。 | `typecheck`、`test`、必要的手动检查。 |
| 7 | 自审并提交。 | 原子 commit，说明看过的 reference。 |
| 8 | 交叉 review。 | Claude Code 或 Codex 复审，Human 决策。 |

不允许：

```text
没有 task card 就开写。
没有 reference check 就开写。
没有 tests 或明确验证理由就提交。
一个 commit 混入多个独立功能。
一边重构一边加功能，除非 task 明确要求。
```

## 3. Task Card 模板

每个实现任务使用这个模板。

```markdown
## Task: <short-name>

Goal:
<一句话说明要完成什么。>

Non-goals:
- <明确不做什么。>

References checked:
- <本地 reference path>
- <本地 embedclaw path if relevant>

Scope:
- <会改哪些 package / app>

Acceptance criteria:
- [ ] <可验证条件 1>
- [ ] <可验证条件 2>
- [ ] <可验证条件 3>

Verification:
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] <必要时的手动检查>

Owner:
<Codex | Claude Code | Human>

Reviewer:
<Codex | Claude Code | Human>
```

Task 必须小到一个 focused session 能完成。  
如果一个 task 预计改动超过 300 行，先拆。

## 4. Codex / Claude Code 分工

### 4.1 推荐职责

| 角色 | 主要负责 | 不建议负责 |
|---|---|---|
| Codex | 代码落地、文件编辑、测试运行、集成、修 review feedback、维护文档和任务状态。 | 独自决定产品方向。 |
| Claude Code | 方案复核、边界审查、接口契约审查、第二视角 code review、发现遗漏和不一致。 | 在同一文件上和 Codex 并行改。 |
| Human | 产品取舍、风险接受、最终 merge 决策、硬件现场判断。 | 手工维护重复状态。 |

### 4.2 协作模式

默认模式：

```text
Claude Code 拆解 / review
-> Codex 实现 / 测试 / 整理 commit
-> Claude Code review diff
-> Codex 修复
-> Human 确认
```

复杂实现模式：

```text
Codex 先做 contract + skeleton
Claude Code review contract
Codex 做 runtime implementation
Claude Code review correctness / boundary
Codex 做 integration tests
Human 决策是否进入下一 slice
```

并行模式只用于写集不冲突的任务。

| 可以并行 | 不可以并行 |
|---|---|
| Codex 做 `contracts`，Claude Code review docs / task card。 | 两边同时改 `runtime-core` 状态机。 |
| Codex 做 implementation，Claude Code 读 reference 提 review checklist。 | 两边同时改同一个 schema。 |
| Codex 做 tests，Claude Code 做 review。 | 两边同时改同一个 package 的核心类型。 |

## 5. 谁更适合做什么

Codex 优先做：

```text
落文件结构。
批量创建 TypeScript package。
写 tests / fixtures。
跑命令验证。
修 lint / type errors。
整合多个模块。
保持文档和代码同步。
```

Claude Code 优先做：

```text
读大段设计文档后找矛盾。
从调用方视角审 MCP / CLI / TUI 接口。
审 Runtime-first 边界有没有被破坏。
审 LLM 是否越权。
审失败语义和状态转换。
给出 review findings。
```

Human 优先做：

```text
确认产品边界。
确认硬件安全策略。
确认是否接受依赖和技术债。
决定是否 merge。
决定何时接真机。
```

## 6. Git 工作流

### 6.1 分支

默认使用短分支：

```text
dev/<slice-name>
```

示例：

```text
dev/contracts-foundation
dev/file-store-events
dev/runtime-state-machine
dev/mcp-thin-adapter
```

规则：

```text
一个分支只做一个 slice。
分支生命周期 1 到 3 天。
分支必须可回滚。
不要在 main 上直接实现功能。
```

### 6.2 Commit

每个 commit 必须是一个逻辑单元。

格式：

```text
<type>: <short description>

<why / verification / references if useful>
```

类型：

```text
feat
fix
refactor
test
docs
chore
```

推荐粒度：

| Commit | 示例 |
|---|---|
| contract | `feat: add run and event schemas` |
| store | `feat: append events with monotonic sequence` |
| test | `test: cover invalid run state transitions` |
| docs | `docs: record implementation workflow` |

提交前检查：

```text
git diff
pnpm typecheck
pnpm test
确认没有 secrets / API key / device id。
确认没有 reference-repos/github/* 被加入 commit。
```

### 6.3 不提交什么

不提交：

```text
.DS_Store
.quickdep/
reference-repos/github/*
真实设备日志
真实 API key
真实 serial / adb / fastboot 连接参数
```

如果 evidence fixture 需要路径，使用假路径：

```text
/tmp/artifact-agent-fixtures/board-01
```

## 7. Review 流程

### 7.1 Review 前必须满足

提交 review 前必须有：

```text
task card。
reference checked 清单。
测试结果。
变更范围说明。
已知风险。
```

没有这些，先不 review。

### 7.2 Review 关注点

Review 顺序固定：

| 顺序 | 检查 |
|---:|---|
| 1 | 是否符合 spec / task card。 |
| 2 | 是否破坏 Runtime-first。 |
| 3 | 是否破坏 thin adapter 边界。 |
| 4 | schema / errors / events 是否稳定。 |
| 5 | 是否有测试覆盖失败路径。 |
| 6 | 是否泄露连接参数或 secrets。 |
| 7 | 是否过度抽象或写太大。 |

### 7.3 Review severity

| 级别 | 含义 | 处理 |
|---|---|---|
| P0 | 会导致安全、数据丢失、无法运行。 | 必须修。 |
| P1 | 会导致行为错误、契约不稳定、边界破坏。 | 必须修。 |
| P2 | 可维护性、测试缺口、实现风险。 | 通常修，或记录后续 task。 |
| P3 | 样式、命名、轻微优化。 | 可选。 |

### 7.4 多模型 review

默认：

```text
Codex 写代码 -> Claude Code review。
Claude Code 写代码 -> Codex review。
```

同一个模型不能既做主要实现者又做最终 reviewer。

## 8. Definition of Ready / Done

### 8.1 Ready

一个 task 可以开始实现，必须满足：

```text
目标明确。
非目标明确。
涉及 contracts 已知。
参考路径明确。
验收标准可测试。
写集不和其他进行中任务冲突。
```

### 8.2 Done

一个 task 完成，必须满足：

```text
实现完成。
测试覆盖 happy path 和至少一个 failure path。
typecheck 通过。
相关文档更新。
reference checked 已记录。
review findings 已处理或明确接受。
commit 原子且可回滚。
```

## 9. 第一阶段任务队列

当前最小实现顺序：

| 顺序 | Task | Owner 建议 | Reviewer 建议 |
|---:|---|---|---|
| 1 | workspace + tooling skeleton | Codex | Claude Code |
| 2 | contracts: core schemas + public response | Codex | Claude Code |
| 3 | file-store: run / event / evidence index | Codex | Claude Code |
| 4 | runtime-core: state machine + plan validation skeleton | Codex | Claude Code |
| 5 | fake target + fake adapters | Codex | Claude Code |
| 6 | runtime-server local HTTP API | Codex | Claude Code |
| 7 | MCP thin adapter | Codex | Claude Code |
| 8 | CLI thin adapter | Codex | Claude Code |
| 9 | Ink TUI fixture Run Cockpit | Codex | Claude Code |
| 10 | real serial / adb / fastboot adapters | Codex | Human + Claude Code |
| 11 | LLM Provider Abstraction + MockProvider | Codex | Claude Code |
| 12 | Anthropic / OpenAI / Gateway providers | Codex | Claude Code |

真机相关任务必须 Human 明确确认后开始。

## 10. 每次开工 checklist

```text
1. 选一个 task。
2. 确认 branch：dev/<slice-name>。
3. 读 AGENTS.md。
4. 读对应 reference-repos 和 embedclaw 文件。
5. 写 task card。
6. 实现最小切片。
7. 跑验证。
8. commit。
9. 交叉 review。
10. 修复或记录后续 task。
```

## 11. 收口

实现协作的核心不是“谁写得快”。

核心是：

```text
每次只做一个清楚的切片。
每次都能验证。
每次都有另一双眼睛 review。
每次都不破坏 Runtime-first 边界。
```

如果某个任务做不小，就先拆，不要硬写。
