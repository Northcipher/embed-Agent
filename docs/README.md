# Embed Agent 文档入口

## 核心文档

```
01-foundation/
  EMBED-AGENT-REQUIREMENTS.md          需求（做什么、谁用、场景、命令清单）
  EMBED-AGENT-ARCHITECTURE.md          架构（27 Sections，完整设计）
  EMBED-AGENT-DESIGN-INSIGHTS.md       设计洞见（为什么这么设计）
  EMBED-AGENT-ARCHITECTURE-CHECKLIST.md 架构检查清单（24 维度，给下次用）
```

## 详细设计

```
02-design/
  01-runtime.md          Run Manager, Step Executor, Decision Handler,
                          Event Bus, Task Manager, Context Assembler, HookManager
  02-tool.md             Connection, OutputPipe, Rule Detector, Aggregator,
                          Connection Manager, Target Manager
  03-agent.md            Planner, Observer, Reply, Memory, Skill Registry
  04-store.md            Event, Evidence, Run, Target, Memory, Skill Store
  05-observation.md      六层观测, Rule Detector, Aggregator 时序/跨源/基线
  06-hook.md             Hook 系统（8 事件点，shell 脚本扩展）
  07-circuit-breaker.md  熔断系统（4 熔断器）
```

## 规划文档

```
04-planning/
  01-interface-spec.md     接口规范（CLI签名、MCP Schema、Event Payload、Zod Schema）
  02-coding-standards.md   编码规范（TS、错误处理、日志、测试、Git、安全）
  03-implementation-plan.md 实现计划（依赖图、6 Phase、M1/M2/M3）
  04-test-plan.md          测试计划（三层策略、80+单元、10集成、7系统）
  05-feature-checklist.md  功能清单（164 项，可逐项验证）
  08-benchmark-design.md   Benchmark 设计（场景、case contract、评分、私有数据治理）
```

## 归档

```
99-archive/              历史设计文档。理解历史决策用，不作为实现依据。
.archive/                旧代码原型（2026-04-29-prototype）
```
