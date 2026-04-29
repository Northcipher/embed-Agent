# 开发流程

> 状态：Draft / 日期：2026-04-29

## 1. 工作单元

```
一个工作单元 = 功能清单里的一项（□ xxx）
≈ 一个文件或一个文件的增量
≈ 一个 commit
```

## 2. 实现顺序

按 `05-feature-checklist.md` 的 Phase 1 → 6 执行。每 Phase 内部按依赖顺序。

**Phase 1 内部顺序：**
```
1. contracts/src/*.ts          类型先行。零依赖。
2. stores/src/*.ts             纯文件 I/O。依赖 contracts。
3. infra (ConfigLoader/Logger) 依赖 contracts。
```

**后续 Phase：** 见 `05-feature-checklist.md` 的"实现顺序与依赖"节。

## 3. 每个工作单元的流程

```
1. 写代码
   └─ 对照 02-design/ 对应章节的接口定义
   └─ 对照 04-planning/01-interface-spec.md 的契约
   └─ 对照 04-planning/02-coding-standards.md 的规范

2. 写测试
   └─ 对照 05-feature-checklist.md 该模块的 🧪 测试项
   └─ 测试文件: 同目录 <name>.test.ts

3. 本地验证
   └─ pnpm check              ← typecheck + test 必须通过
   └─ 手动跑一下 (如果可运行)

4. Commit
   └─ feat: <简短描述>
   └─ 一个工作单元一个 commit

5. Codex Review
   └─ /codex:review
   └─ 发现问题 → 修复 → commit → 再次 review → 直到通过
```

## 4. Commit 前检查清单

```
□ typecheck 通过               pnpm typecheck 零错误
□ 测试通过                     pnpm test 零失败
□ 本项对应的 🧪 测试项已写      对照 checklist 对应模块的测试块
□ 没有 any                     grep -r ": any" src/ 无新增
□ 没有 console.log             grep -r "console.log" src/ 无新增(用 Logger)
□ 错误信息可读                 "无法连接 ADB 设备 ABC123: device offline" 而不是 "Connection failed"
□ 关键路径有 log               [INFO] 级别记录状态变化
□ 对照接口规范                 输入输出符合 01-interface-spec.md
□ Co-Authored-By 不存在        禁止伪作者
□ commit message 是 feat/fix/refactor 格式
```

## 5. Review 流程

### 5.1 自 Review（写完后自己先过一遍）

```
□ 这个 PR 只做了一件事吗？
□ 对照架构文档：组件边界没被破坏吗？
  - Tool 不调 LLM
  - Agent 不碰设备
  - Interface 不持状态
  - DH 不订阅 DecisionMade
  - Reply 是 result_ready 唯一发布者
□ 对照详细设计：接口签名和设计稿一致吗？
□ 有新 Event 吗 → 确认 EventType 已注册 + 生产者明确
□ 有新 CLI 命令吗 → 确认 CommandHandler 路由已加
```

### 5.2 Codex Review（每个功能完成后必须执行）

```bash
/codex:review
```

Codex 自动检查:
  - 实现和 02-design/ 设计一致吗
  - 实现和 01-foundation/ 架构一致吗
  - 有边界破坏吗（Tool 不调 LLM / Agent 不碰设备 / ...）
  - 有时序问题吗
  - 有未处理的异常路径吗
  - 有新增 Event 吗 → EventType 已注册吗
  - 有新增 CLI 命令吗 → CommandHandler 路由已加吗

工作区干净时才执行（commit 之后）。
如果 review 发现问题 → 修复 → commit → 再次 review → 直到通过。
```

### 5.3 人 Review（关键模块）

```
以下模块必须人 Review:
  - RunManager (状态机核心)
  - DecisionHandler (决策路由)
  - StepExecutor (设备执行)
  - RuleDetector (检测正确性)
  - LLMCallManager (LLM 调用安全)
  - HookManager (子进程安全)
```

## 6. 每 Phase 验收门

### M1 门 (Phase 1-3 完成)

```
□ pnpm typecheck 全仓库通过
□ pnpm test 全仓库通过
□ FakeConnection + 手写 Plan → 完整 Run 到终态
□ RuleDetector 正确检测 kernel panic → stop
□ Evidence 完整保留
□ 状态机: planning → running → collecting_evidence → finalizing → completed/failed
□ Host 崩溃恢复: running Run → 重启 → failed(crashed)
```

### M2 门 (Phase 4 完成)

```
□ 人一句话 → Planner → Plan → 执行 → Observer → Reply → 结果
□ Memory: Episode 自动保存 → 下一 Run Planner 查到
□ Skill: --skill validate-boot → 跳过 Planner
□ CB: override 3次 → 只 suggest
□ CB4: LLM 失败 3次 → fallback
□ 早期失败 → result_ready → RunProfile 存
```

### M3 门 (Phase 5-6 完成)

```
□ CLI 全部命令可用
□ MCP 全部 tool 可用
□ TUI 实时
□ Hook block → Run paused
□ 通知: result_ready → Slack
□ Cron 触发 + 重叠跳过
□ Continuous 长期运行 + checkpoint
□ 崩溃恢复诚实
```

## 7. 禁止事项

```
❌ 跳过测试直接 commit
❌ typecheck 不通过就 commit
❌ 一个 PR 改 10 个不相关的文件
❌ Co-Authored-By
❌ --no-verify
❌ 照抄参考实现的变量名
❌ any 类型
❌ "先写状态再发 Event" (必须先 Event 后状态)
```
