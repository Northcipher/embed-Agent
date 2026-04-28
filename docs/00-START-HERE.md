# Artifact Validation Agent 先看这个

如果你现在看这堆文档有点乱，先看这页。

## 这东西到底是什么

它不是 coding agent。  
它不读代码，也不改代码。

它是一个“产物真机验证 agent”：

```text
Coding Agent / CI / Human 提供 artifact 和验证背景
-> Artifact Validation Agent 放到真实设备上跑
-> 运行中主动观察
-> 异常时补采集
-> 保存 evidence
-> 生成 Agent Reply / report
-> 回传给 Coding Agent / Human
```

## 为什么这个方向比之前更清楚

之前我们一直在讨论：

- agent 怎么修代码
- runtime 怎么被 coding agent 调用
- LLM 要不要参与
- terminal / serial / MCP 是否已经有人做

这条路越走越虚。

现在收敛成一个更具体的问题：

```text
产物会持续产生，
但真实设备验证没人想反复手工做。
```

所以系统不负责“修”，只负责“验”。

## 典型场景

Coding Agent 修完一个 boot 相关改动：

```text
提交 firmware.img + 验证背景
-> 刷到 board-01
-> 抓 serial boot log
-> 等 ADB
-> 跑 smoke_test
-> 运行中观察 panic / timeout / adb offline
-> 失败时补采集 dmesg / logcat / serial window
-> 生成 Agent Reply
```

或者每次 CI 产出新 artifact：

```text
CI 上传 artifact
-> 触发 validation task
-> 真机验证
-> report 回写到 CI / 通知人
```

## 它的核心对象

- `Validation Request`：artifact、验证背景、target 和约束。
- `Target Profile`：Human 配置的连接方式、刷机方式、安全边界和目标提示。
- `Capability Inference`：系统从 Target Profile 推断可用能力。
- `Target`：哪块板子、串口、ADB、刷机方式。
- `Step Plan`：刷机、观察、等待、命令检查、采日志。
- `Rule Engine`：pattern、timeout、silence、exit code 快速检测。
- `Observer`：根据事件摘要和上下文判断是否继续等、补采集、暂停或停止。
- `Run`：某一次真实验证。
- `Evidence Package`：这次验证留下的原始事实。
- `Validation Report`：这次结果的人话报告和结构化状态。
- `Agent Reply`：回给 Coding Agent 的摘要、关键证据和建议下一步。
- `Alert`：失败、超时、设备异常时通知谁。
- `Validation Task`：定时或长期验证任务，P1 再做。

## 它不做什么

第一版不做：

- 不改代码。
- 不做 coding agent。
- 不让 LLM 直接控制设备。
- 不做更好的终端工具。
- 不做完整 board farm。
- 不做复杂权限系统。
- 不替代 labgrid / LAVA / pytest-embedded。

## 第一版只打一个 demo

第一版最小闭环：

```text
提交一个 firmware 文件和验证背景
-> 刷到一块 board
-> 抓 serial
-> 等 ADB
-> 跑一条 smoke 命令
-> 运行中主动观察和补采集
-> 保存 evidence
-> 输出 Agent Reply / validation report
```

如果这条链都不能明显省事，就不继续扩大。

## 现在看哪些文档

当前正式主线优先看这几份：

1. [01-foundation/ARTIFACT-VALIDATION-AGENT-ROLE-MODEL.md](01-foundation/ARTIFACT-VALIDATION-AGENT-ROLE-MODEL.md)
2. [01-foundation/ARTIFACT-VALIDATION-AGENT-PRODUCT.md](01-foundation/ARTIFACT-VALIDATION-AGENT-PRODUCT.md)
3. [01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md](01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md)
4. [01-foundation/ARTIFACT-VALIDATION-AGENT-ARCHITECTURE.md](01-foundation/ARTIFACT-VALIDATION-AGENT-ARCHITECTURE.md)
5. [01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md](01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md)
6. [01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md](01-foundation/ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md)
7. [01-foundation/ARTIFACT-VALIDATION-AGENT-UI-UX.md](01-foundation/ARTIFACT-VALIDATION-AGENT-UI-UX.md)
8. [01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md](01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md)
9. [01-foundation/ARTIFACT-VALIDATION-AGENT-FIRST-SLICE.md](01-foundation/ARTIFACT-VALIDATION-AGENT-FIRST-SLICE.md)

继续参考：

- [01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-BREAKDOWN.md](01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-BREAKDOWN.md)
- [01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-ANALYSIS.md](01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-ANALYSIS.md)
- [01-foundation/ARTIFACT-VALIDATION-AGENT-PLANNING-MODEL.md](01-foundation/ARTIFACT-VALIDATION-AGENT-PLANNING-MODEL.md)
- [01-foundation/ARTIFACT-VALIDATION-AGENT-SCENARIO-LIBRARY.md](01-foundation/ARTIFACT-VALIDATION-AGENT-SCENARIO-LIBRARY.md)
- [01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md](01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md)
- [02-implementation/IMPLEMENTATION-WORKFLOW.md](02-implementation/IMPLEMENTATION-WORKFLOW.md)

旧的 `Embed Agent / Embedded Runtime / Board Run MCP` 文档和架构比对稿已移动到 [99-archive/](99-archive/)，不再作为当前主线。

## 编码前强制规则

```text
先看 reference-repos/ 和本地 embedclaw 对应实现，再写代码。
```

具体映射见 [01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md](01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md) 和仓库根目录 [../AGENTS.md](../AGENTS.md)。
