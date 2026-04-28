# Embed Agent 方向与原则

> 状态：Draft
> 日期：2026-04-28
> 目的：把当前产品方向压缩成一份正式口径，回答我们到底在做什么、第一版先打什么、实现时必须守住哪些原则。

## 1. 方向一句话

`Embed Agent` 不是另一个通用 coding agent，也不是另一个聊天壳。

它是一个面向嵌入式开发现场的验证 runtime。

一句人话：

```text
Coding Agent 负责读代码、改代码、编译产物。
Embed Agent 负责从产物进入真实设备现场开始，执行、观察、留证据、交接下一轮修复。
```

## 2. 角色故事

第一版按五个角色分工：

| 角色 | 本质 | 负责什么 |
|---|---|---|
| Human | 问题 Owner | 定义问题、看结果、做终局判断、必要时接管设备 |
| Coding Agent | 代码理解者和修改者 | 读代码、改代码、编译产物、发起 run、消费结果继续修 |
| Embed Agent Runtime | 验证现场 Manager | 管 run、target、steps、设备状态、事件、证据 |
| LLM Worker | Evidence 前置过滤器 | 基于事实做去噪、关键事件提炼、摘要、handoff |
| Toolchain / Real World | 物理执行者 | 刷机、ADB、Serial、SSH、probe、电源等真实动作 |

这几个角色不能混：

- Runtime 不改代码。
- Coding Agent 不管设备连接和串口细节。
- LLM Worker 不保管事实，不控制设备。
- Toolchain 不理解业务目标。
- Human 不负责手工拼完整流程。

## 3. 我们真正要解决的问题

嵌入式开发最碎的环节，不是“写代码”，而是代码产物进入真实设备后的现场：

- 刷哪块板。
- 怎么刷。
- 刷完设备有没有回来。
- 串口有没有关键异常。
- ADB 能不能连上。
- 需要采哪些日志。
- 运行中卡住时现场有没有留下。
- 下一轮 coding agent 能不能接着修。

脚本能跑一次，但难复用、难追踪、难交接。  
通用 coding agent 能改代码，但不应该直接管理真实设备现场。

所以第一版要把这条链收成 runtime：

```text
artifact
-> target
-> step plan
-> async run
-> flash / watch / adb / collect
-> evidence package
-> observation summary
-> agent handoff
```

## 4. 产品边界

### 4.1 我们做什么

- 管 `Run / Target / Artifact / Step / Evidence / Filtered Evidence / Observation Summary / Handoff`。
- 提供给外部 Coding Agent 的稳定入口。
- 接收 agent 编译好的产物。
- 执行可组合 step：`flash / watch_serial / wait_adb / adb_shell / collect_logs / sleep`。
- 管长任务状态、事件、取消、partial evidence。
- 留下原始 evidence：刷机日志、串口日志、ADB 状态、命令输出、时间线。
- 生成 observation summary 和 agent handoff。
- 给 Human 提供最小状态入口，让人直接看到 Runtime 正在做什么。
- 让动作可见、可追溯，但第一版不做审批拦截。

### 4.2 我们不做什么

- 不做另一个通用代码助手。
- 不做另一个聊天 UI。
- 第一版不接管编译。
- 第一版不要求 workspace。
- 第一版不强制 case。
- 第一版不要求 recipe。
- 第一版不做权限 / 审批系统。
- 第一版不内置固定 verdict 规则。
- 第一版不做完整共享实验室治理。

## 5. 第一条必须打通的链

第一条链：

```text
Coding Agent 编译产物
-> Embed Agent 接收 artifact
-> flash 到目标设备
-> Serial 持续观察启动现场
-> 等待 ADB 恢复
-> 执行 agent 指定的 ADB shell / collect logs
-> 产出 evidence package
-> 生成 observation summary
-> handoff 给 Coding Agent
```

为什么先打它：

- 它最符合角色边界。
- 它最能证明 Embed Agent 的价值：接住真实设备现场。
- 它能逼出 P0 内核：异步 run、target、artifact、step、events、evidence、summary、handoff。

## 6. 关键产品原则

### 原则 1：Runtime First

系统中心是 runtime。  
CLI、MCP、Console 都只是入口。

### 原则 2：Agent First

第一版主要服务外部 Coding Agent。  
调用模型先按 `create_run / get_run / get_run_events / get_partial_evidence / get_run_result` 设计。

### 原则 3：Artifact First

第一版从 agent 编译好的 artifact 开始。  
源码、workspace、build host 都不是 P0 前提。

### 原则 4：Step Plan First

Runtime 提供能力，不替 agent 固定验证流程。  
P0 用 agent 传入的 steps 执行；recipe 是后续沉淀。

### 原则 5：长任务不能失明

run 不是同步函数。  
创建后立即返回 `run_id`，运行中必须能查状态、事件和 partial evidence。

### 原则 6：Evidence 是事实，Filtered Evidence 是默认入口

Evidence Package 只保存事实。  
Filtered Evidence / Observation Summary / Handoff 是 LLM Worker 或规则生成的过滤和解释，必须能回溯到 evidence。

Coding Agent 默认读过滤后的 evidence，不直接吃完整原始日志。

### 原则 7：看得到，不挡路

第一版不做权限系统，不做逐次确认。  
`action_summary` 和 audit 用来说明会做什么、正在做什么、做过什么。

Human 可以通过最小 Console 状态视图直接看 Runtime，不需要每次问 Coding Agent。

### 原则 8：Evidence Before Recovery

设备卡死、无响应、ADB 不回来时，先保存 failure snapshot。  
恢复动作应该显式触发，不能先把现场覆盖掉。

### 原则 9：不内置固定通过规则

什么叫通过，由 Human、Coding Agent 或 CI 的任务目标决定。  
Embed Agent 只提供事实、摘要和可解释候选观察。

## 7. 三个核心场景

### 场景 A：普通代码修复闭环

```text
Human 定义问题
-> Coding Agent 改代码并编译产物
-> Coding Agent 调 create_run
-> Runtime 执行 flash / watch / adb / collect
-> Runtime 留 evidence
-> LLM Worker 过滤 evidence，生成 key events / summary / handoff
-> Coding Agent 继续修或结束
-> Human 做终局判断
```

### 场景 B：黑卡死 / 无响应现场抓取

```text
Run 正在执行
-> Runtime 检测基础异常
-> Runtime 保存 failure snapshot
-> Agent / Human 读取 partial evidence
-> Human 或 Agent 显式触发恢复
```

### 场景 C：CI / 非交互验证

CI 不是 P0，但要预留：

```text
CI 提供 artifact、target、steps
-> Runtime 执行 run
-> 输出 evidence、summary、candidate observation
-> CI 按自己的 gate 规则判断
-> 失败后交给 Human / Coding Agent
```

## 8. 实施原则

- 先定外部调用模型，再定内部对象。
- 先做单 target，再谈 reservation 和多设备。
- 先做 steps，再沉淀 recipe。
- 先做 evidence，再做 recovery。
- 先做 action visibility，再做 approval。
- 先做 filtered evidence 和 observation summary，再讨论更复杂的候选判断。
- 不让 CLI、MCP、Console 各自保存一套状态。

## 9. 当前评审焦点

下一轮最应该评审：

- `create_run` 输入 schema 是否足够小。
- `steps` schema 怎么定义。
- 第一版 `flash` step 支持哪种工具。
- `watch_serial` 是否从刷机前就开始。
- `get_run_events` 第一版轮询还是 streaming。
- Evidence Package 目录结构。
- Observation Summary 是 LLM 生成还是规则摘要先行。

## 10. 收口

第一版不是“全能嵌入式平台”。

第一版只证明一件事：

```text
Coding Agent 编译好产物以后，
Embed Agent 能稳定接管真实设备现场，
把执行过程、故障现场和证据交回修复闭环。
```
