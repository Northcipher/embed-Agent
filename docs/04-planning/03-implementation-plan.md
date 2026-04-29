# 实现计划

> 状态：Draft / 日期：2026-04-29

## 1. 依赖图

```mermaid
flowchart TD
    Contracts["packages/contracts"] --> Stores["packages/stores"]
    Contracts --> Tools["packages/tools"]
    Contracts --> Agent["packages/agent"]
    Contracts --> Runtime["packages/runtime"]
    Contracts --> Views["packages/views"]

    Stores --> Tools
    Stores --> Agent
    Stores --> Runtime

    Tools --> Runtime

    Views --> Stores
    Views --> Contracts

    Runtime --> CLI["apps/cli"]
    Runtime --> MCP["apps/mcp-server"]
    Views --> CLI
    Views --> MCP
    Views --> TUI["apps/tui"]

    Note: Views 只依赖 Store + Contracts。是只读投影。
    Runtime/Agent 不直接依赖对方。通过 contracts 共享接口。
    CLI/MCP 依赖 Runtime(发Command) + Views(读状态)。
    TUI 只依赖 Views（不直接接触 EventBus）。
```

## 2. 构建顺序

```
Phase 1: 地基 (contracts → stores)
  ├─ 1.1 contracts/src/
  │     类型定义、Zod schema、公共错误码。零依赖。
  │     产出: 所有 .ts type 文件
  ├─ 1.2 stores/src/
  │     EventStore, EvidenceStore(+Index), RunStore, TargetStore, MemoryStore, SkillStore
  │     依赖: contracts
  │     产出: 6 个 Store。纯文件 I/O。可单独测试。

Phase 2: 设备层 (tools)
  ├─ 2.1 Connection 接口 + Local/Serial/ADB/Fastboot 实现
  │     依赖: contracts
  │     产出: 5 个 Connection。可单独用真实设备测试。
  ├─ 2.2 OutputPipe + RingBuffer
  │     依赖: Connection, contracts
  │     产出: feedStream/feedExec
  ├─ 2.3 RuleDetector
  │     依赖: OutputPipe, contracts
  │     产出: 6 种检测。可单独用 mock 数据测试。
  ├─ 2.4 Aggregator
  │     依赖: OutputPipe, EvidenceStore, MemoryStore
  │     产出: 阶段识别/输出模式/跨源关联/基线对比/主动采样
  ├─ 2.5 ConnectionManager + TargetManager
  │     依赖: Connection, TargetStore
  │     产出: 连接池化 + Pre-flight + 环境恢复

Phase 3: 运行时 (runtime)
  ├─ 3.1 EventBus
  │     依赖: contracts
  │     产出: 发布/订阅。同 Run 分区。
  ├─ 3.2 StepQueue + StepExecutor
  │     依赖: EventBus, ConnectionManager, OutputPipe
  │     产出: Step 执行 + 中断 + 重试 + CB2
  ├─ 3.3 DecisionHandler
  │     依赖: EventBus, ContextAssembler(先 stub), Observer(先 stub)
  │     产出: Rule routing + Observer 触发 + CB1/CB3
  ├─ 3.4 RunManager
  │     依赖: EventBus, StepQueue, DecisionHandler, Planner(先 stub), Reply(先 stub), TargetManager
  │     产出: 完整 Run 生命周期
  ├─ 3.5 ContextAssembler
  │     依赖: TargetStore, MemoryStore, SkillStore, Config
  │     产出: StaticPrompt + DynamicContext
  ├─ 3.6 TaskManager
  │     依赖: RunManager, RunStore
  │     产出: Cron/Event/Continuous 触发
  ├─ 3.7 HookManager
  │     依赖: contracts
  │     产出: 8 事件点 Hook 执行

Phase 4: 智能 (agent)
  ├─ 4.1 LLMCallManager + CB4
  │     依赖: LLMConfig
  │     产出: Provider 抽象 + LLM 降级
  ├─ 4.2 Planner
  │     依赖: LLMCallManager, SkillRegistry, Memory, contracts(PlannerContext类型)
  │     产出: Plan 生成
  │     (不依赖 ContextAssembler。Context 由 Runtime 组装好后传入)
  ├─ 4.3 Observer
  │     依赖: LLMCallManager, Memory, contracts(ObserverInput类型)
  │     产出: Decision 生成
  │     (不依赖 ContextAssembler。Input 由 Runtime 组装好后传入)
  ├─ 4.4 ReplyGenerator
  │     依赖: LLMCallManager, Memory, EventStore, EvidenceStore
  │     产出: AgentReply + Episode + RunProfile
  ├─ 4.5 Memory
  │     依赖: MemoryStore
  │     产出: WM/Episode/Fact/Profile CRUD
  ├─ 4.6 SkillRegistry
  │     依赖: SkillStore
  │     产出: Skill 加载/匹配

Phase 5: 辅助 (notify + views)
  ├─ 5.1 NotificationFilter
  │     依赖: EventBus, SystemConfig
  │     产出: Slack/Email 通知
  ├─ 5.2 Views (Run/Target/Evidence)
  │     依赖: EventStore, EvidenceStore, RunStore, TargetStore
  │     产出: 只读投影

Phase 6: 入口 (apps)
  ├─ 6.1 CommandHandler (thin facade for all command dispatch)
  │     依赖: RunManager, TaskManager, Memory, SkillRegistry, HookManager
  │     产出: 统一命令入口。CLI/MCP 只通过它发 Command。
  ├─ 6.2 CLI
  │     依赖: CommandHandler, Views
  ├─ 6.3 MCP Server
  │     依赖: CommandHandler, Views
  ├─ 6.4 TUI
  │     依赖: Views (SSE 通过 View 层暴露，不直接接触 EventBus)
```

## 3. 里程碑

```
M1: 手写 Plan 跑通 (Phase 1-3, Agent 用 stub)
    contracts + stores + tools + runtime (Planner/Observer/Reply 用 stub)
    → 手写 Plan → flash → stream → exec → finalizing → result_ready → completed/failed
    stub Reply: 规则摘要。不调 LLM。但走完整的 finalizing → result_ready 闭环。
    stub Planner: 返回硬编码 Plan。
    stub Observer: 返回 continue。
    验收: FakeConnection + 硬编码 Plan → 完整状态机到终态 → evidence 不丢

M2: 智能接入 (Phase 4)
    Planner + Observer + Reply + Memory + SkillRegistry 接入
    → 人一句话 → 自动生成 Plan → 自动决策 → 自动出结果
    验收: 真实 LLM + FakeConnection → 完整闭环

M3: 生产就绪 (Phase 5-6)
    Hook + Circuit Breaker + Notification + CLI + MCP + TUI
    → 定时跑 + 持续跑 + 自动通知 + 熔断保护
    验收: 真实设备 + 完整配置 → 长期运行不崩溃
```
