# Artifact Validation Agent 功能分析清单

> 状态：Draft  
> 日期：2026-04-28  
> 目的：拆清楚“真实功能分析”要做什么。  
> 边界：功能分析回答“该验证什么”，编排模型回答“怎么用设备能力去验证”。

## 1. 一句话

功能分析不是让 Agent 去读代码和修代码。

它要做的是：

```text
把“这次改了什么功能”
翻译成
“真机上应该验证哪些现象、怎么判断过没过、失败时该抓什么证据”。
```

P0 里它可以是 Task Planner 的内部阶段，不一定要单独做成一个独立角色。

`Validation Intent` 仍然有价值：它可以作为 Planner 的中间产物，也可以给 Coding Agent / Human 预览“这次准备验证什么”。

## 2. 功能分析在链路里的位置

```text
Coding Agent / CI / Human
-> 提供 artifact + 改动背景 + 预期功能
-> Task Planner 先做 Function Analysis
-> 产出 Validation Intent
-> Task Planner 再根据 Intent + 能力 + 约束生成 Plan
-> Orchestrator 校验执行
```

这里不强制拆成两个 LLM 调用。

第一版可以是一次 Task Planner 调用里完成两段工作：

```text
先分析该验证什么
再编排怎么验证
```

后续如果需要复用、预览或人工确认，再把 Function Analysis 拆成独立模块。

功能分析阶段不直接决定：

- 用哪个串口。
- 执行哪条 adb 命令。
- 是否真的重启设备。
- 是否允许断电。
- 怎么保存 evidence 文件。

这些属于 Target Profile、Planning Model、Orchestrator 和 Tool Adapter。

## 3. 输入清单

### 3.1 必需输入

| 输入 | 内容 | 来源 |
|---|---|---|
| `task` | 这次要验证什么 | Coding Agent / Human / CI |
| `what_changed` | 改了什么功能或模块 | Coding Agent |
| `artifact` | 要验证的产物 | Coding Agent / CI |
| `target` | 要在哪块板子上验证 | 调用方 |
| `expected` | 期望看到什么结果 | 调用方 |
| `constraints` | 时间、危险动作、安全边界 | 调用方 / 系统默认 |

示例：

```json
{
  "task": "验证网络重连修复是否生效",
  "what_changed": "修改了 reconnect backoff 和 socket 重建逻辑",
  "artifact": {
    "path": "/builds/app.apk",
    "type": "app_package"
  },
  "target": "board-01",
  "expected": "断网恢复后服务能在 60 秒内重连",
  "constraints": {
    "max_duration_sec": 600,
    "allow_network_change": true,
    "allow_power_cycle": false
  }
}
```

### 3.2 最好有的输入

| 输入 | 为什么有用 |
|---|---|
| `concerns` | 调用方最担心什么，例如 crash、timeout、黑屏、数据丢失。 |
| `changed_files` | 帮助判断影响面，但 P0 可以不读代码。 |
| `component` | 明确是 boot、network、IPC、UI、driver、OTA 等。 |
| `test_hint` | 调用方知道的测试命令、接口、脚本。 |
| `success_threshold` | 错误率、延迟、恢复时间、资源增长阈值。 |
| `known_failure` | 之前失败的日志、现象或 issue 描述。 |
| `priority` | 验证优先级，影响是否选更快或更完整的验证方式。 |
| `reproduce_hint` | 如果是复现问题，说明原始触发条件和复现步骤。 |
| `related_issues` | 相关 issue、bug ID、历史验证记录。 |
| `environment` | 特殊环境要求，例如温度、电压、网络、负载、外设连接。 |

### 3.3 缺失输入的处理

| 缺什么 | 处理 |
|---|---|
| 没有 `expected` | 根据 task 推断一个保守默认，并在结果中标明是假设。 |
| 没有 `concerns` | 从场景库找常见风险，例如 crash、timeout、panic、ADB offline。 |
| 没有 `test_hint` | 只规划通用观察，不编造不存在的测试脚本。 |
| 没有阈值 | 使用保守默认值，并在 `inferred_values` 里标记“建议确认”。 |
| 需求太模糊 | 生成低置信度 intent，必要时要求补充信息。 |

## 4. 功能分析要回答的 8 个问题

| 问题 | 说明 |
|---|---|
| 这是什么功能 | boot、进程服务、IPC、网络、UI、外设、OTA、资源、低功耗等。 |
| 这个功能在板子上怎么表现 | 进程启动、接口返回、画面刷新、网络重连、外设响应、资源变化。 |
| 正常应该看到什么 | ready marker、请求成功、错误率低、无 crash、指标稳定。 |
| 失败通常长什么样 | panic、timeout、crash、黑屏、重启、无响应、资源泄漏。 |
| 要做什么动作才能暴露问题 | 重启、断网、压测、反复调用、kill 服务、插拔外设、长跑。 |
| 要观察什么 | 日志、进程、心跳、接口耗时、画面、资源、重启原因。 |
| 失败时要抓什么 | serial、logcat、dmesg、线程栈、core、截图、trace、状态 dump。 |
| 怎么判断过没过 | 明确 pass/fail 条件，最好带阈值。 |

## 5. 输出：Validation Intent

功能分析的输出不是 Plan，而是 `Validation Intent`。

它描述“该验证什么”，不描述“具体怎么调用工具”。

示例：

```json
{
  "intent_id": "intent-001",
  "feature_area": "network_reconnect",
  "summary": "验证断网恢复后服务能否自动重连",
  "confidence": 0.85,
  "confidence_reason": "需求明确，场景库中有网络断连恢复参考，且给出了 60 秒重连阈值",
  "matched_scenarios": [
    {
      "name": "网络断连恢复",
      "reason": "需求明确要求断网恢复后自动重连"
    }
  ],
  "expected_behavior": [
    "服务断网期间不 crash",
    "网络恢复后 60 秒内重连成功",
    "重连后业务请求恢复正常"
  ],
  "risk_focus": [
    "reconnect timeout",
    "service crash",
    "socket not recreated",
    "network state mismatch"
  ],
  "suggested_actions": [
    "make sure service is running",
    "cut network for a bounded duration",
    "restore network",
    "send business request after restore"
  ],
  "observe": [
    "network state",
    "service process state",
    "reconnect log",
    "request latency",
    "crash signal"
  ],
  "evidence_need": [
    "service log",
    "network status timeline",
    "request result",
    "dmesg/logcat on failure"
  ],
  "pass_fail": [
    "network restores successfully",
    "service reconnects within 60 seconds",
    "service does not crash",
    "post-reconnect request succeeds"
  ],
  "assumptions": [
    "target can control network state",
    "service exposes a way to check reconnect status"
  ],
  "missing_info": [],
  "inferred_values": {
    "network_cut_duration_sec": {
      "value": 30,
      "source": "default",
      "recommend_confirm": true
    }
  }
}
```

Task Planner 再根据这个 intent 和 target capabilities 生成 Plan。

注意：`suggested_actions` 是“建议做什么动作暴露问题”，不是能力调用。  
Task Planner 需要把它翻译成 target 可用能力；Orchestrator 再校验是否允许执行。

## 6. 功能分类

### 6.1 Boot / 启动功能

要分析：

- 是验证整个系统启动，还是某个服务启动。
- 是否改了 init、systemd、rc、kernel、driver。
- 正常启动完成的 marker 是什么。
- 失败可能是 panic、卡住、循环重启、ADB 不回来。

输出关注点：

- boot marker。
- panic / oops。
- service start order。
- ADB online。
- boot duration。

典型证据：

- serial full log。
- last serial window。
- boot timeline。
- dmesg/logcat。
- reset reason。

### 6.2 进程 / 服务功能

要分析：

- 进程是自动启动还是手动启动。
- 进程 ready 怎么判断。
- 服务挂了是否应该自动拉起。
- 服务是否有健康检查接口。

输出关注点：

- process alive。
- ready marker。
- crash signal。
- restart count。
- health check。

典型证据：

- process list。
- service log。
- crash stack / tombstone / core。
- thread stack。
- service manager 状态。

### 6.3 IPC / RPC / 进程间通讯

要分析：

- 哪两个组件通信。
- 通信方式是 binder、dbus、socket、message queue 还是自定义协议。
- 期望的错误率、延迟、恢复行为。
- 是否需要中途重启一端。

输出关注点：

- request success rate。
- latency distribution。
- timeout count。
- peer crash。
- thread blocked。

典型证据：

- request log。
- 双方服务日志。
- thread stack。
- protocol error。
- dmesg/logcat。

### 6.4 网络功能

要分析：

- 是联网、断网恢复、弱网、DNS/TLS 还是长连接。
- 网络恢复后多长时间内必须恢复业务。
- 是否允许改网络环境。

输出关注点：

- network state。
- reconnect timing。
- request success。
- service crash。
- DNS/TLS/socket error。

典型证据：

- network timeline。
- service log。
- request result。
- packet/log trace。
- dmesg/logcat。

### 6.5 UI / 显示 / 输入功能

要分析：

- 验证的是画面出现、刷新、输入响应，还是黑屏恢复。
- 是否需要截图、拍屏或输入注入。
- 正常画面怎么判断。

输出关注点：

- screen visible。
- frame update。
- input response。
- app crash。
- display service state。

典型证据：

- screenshot / camera capture。
- display log。
- input log。
- app log。
- surface/window 状态。

### 6.6 外设 / Driver 功能

要分析：

- 外设类型是什么。
- 访问方式是什么。
- 是否要测试异常恢复、热插拔、总线错误。
- 是否有总线或驱动状态可读。

输出关注点：

- device present。
- command response。
- bus error。
- driver recovery。
- hotplug event。

典型证据：

- driver log。
- bus status。
- device enumeration。
- peripheral command result。
- kernel log。

### 6.7 OTA / 升级 / 回滚

要分析：

- 升级对象是什么。
- 成功标志是什么。
- 中断时是否应该回滚。
- 是否允许断电或重启。

输出关注点：

- upgrade progress。
- boot slot / version。
- rollback state。
- first boot health。
- data migration result。

典型证据：

- upgrade log。
- rollback log。
- version / slot status。
- boot log。
- data integrity result。

### 6.8 资源 / 稳定性

要分析：

- 关注内存、CPU、fd、存储、温度还是延迟。
- 要跑多久。
- 阈值是什么。
- 是否要长跑或压测。

输出关注点：

- metric trend。
- leak pattern。
- threshold violation。
- crash / reboot。
- performance degradation。

典型证据：

- periodic metric samples。
- process resource distribution。
- error log。
- long-run timeline。
- final snapshot。

### 6.9 低功耗 / 电源

要分析：

- 是 sleep、wake、suspend/resume、唤醒源还是异常断电。
- 唤醒方式是什么。
- 是否允许 power cycle。

输出关注点：

- sleep entered。
- wake success。
- wake reason。
- service recovery。
- unexpected reboot。

典型证据：

- power log。
- wake reason。
- serial log。
- dmesg。
- post-wake health check。

### 6.10 权限 / 配置 / 版本

要分析：

- 是权限变更、配置兼容、数据迁移还是组件版本不匹配。
- 正常失败是否应该明确报错。
- 是否要保留旧数据或旧配置。

输出关注点：

- permission deny。
- config parse error。
- migration result。
- version mismatch。
- graceful degradation。

典型证据：

- config snapshot。
- service log。
- audit/security log。
- version list。
- migration log。

### 6.11 并发 / 多线程

要分析：

- 是否涉及多进程或多线程访问共享资源。
- 是否有锁、临界区、队列、缓存或异步回调。
- 是否要测试竞态、死锁、顺序错乱或数据不一致。

输出关注点：

- lock contention。
- deadlock。
- data race。
- thread crash。
- timing sequence。

典型证据：

- thread stack。
- lock status。
- crash log。
- timing trace。
- 双方或多方日志。

### 6.12 实时性 / 调度

要分析：

- 是否有响应延迟、调度延迟、周期任务或 deadline 要求。
- 阈值是什么。
- 是否要在高负载下验证。

输出关注点：

- response latency。
- scheduling latency。
- jitter。
- deadline miss。
- task starvation。

典型证据：

- latency samples。
- scheduling log。
- interrupt log。
- timing trace。
- priority status。

### 6.13 状态机 / 状态切换

要分析：

- 功能是否由状态机驱动。
- 哪些状态和状态切换是关键路径。
- 是否有非法状态、重复事件、乱序事件或恢复路径。

输出关注点：

- state transition。
- invalid state。
- missing transition。
- repeated event。
- recovery state。

典型证据：

- state timeline。
- event log。
- transition result。
- error code。
- recovery log。

### 6.14 多设备协同

要分析：

- 是否涉及多块板子、主从角色、网关和节点、控制端和被控端。
- 同步、切换或故障转移条件是什么。
- 是否要同时收集多设备证据。

输出关注点：

- inter-device communication。
- role assignment。
- failover success。
- sync status。
- network partition behavior。

典型证据：

- all device logs。
- role change timeline。
- sync result。
- communication trace。
- failover log。

### 6.15 安全 / 加密 / 认证

要分析：

- 是否涉及证书、密钥、签名、权限、认证、加密通道。
- 正常失败是否应该明确拒绝，而不是 crash 或 silent fail。
- 是否有时间、版本或证书链依赖。

输出关注点：

- authentication result。
- signature verification。
- TLS / crypto error。
- permission deny。
- secure fallback。

典型证据：

- security log。
- certificate / version info。
- auth result。
- audit log。
- service log。

## 7. 功能分析能力清单

### 7.1 需求解析

| 项 | 内容 |
|---|---|
| 要做什么 | 从 task / what_changed / expected / concerns 里提取验证意图。 |
| 输入 | 自然语言背景、artifact metadata、调用方提示。 |
| 输出 | 功能域、目标行为、风险关注点。 |
| 缺了会怎样 | Planner 不知道要验证什么，只能跑固定 smoke。 |

### 7.2 功能域识别

| 项 | 内容 |
|---|---|
| 要做什么 | 判断改动属于 boot、service、IPC、network、UI、driver、OTA、resource 等哪类。 |
| 输入 | what_changed、component、changed_files、known failure。 |
| 输出 | `feature_area` 和置信度。 |
| 缺了会怎样 | 场景参考找不准，观察点会偏。 |

### 7.3 行为预期提取

| 项 | 内容 |
|---|---|
| 要做什么 | 把“期望正常”拆成可观察行为。 |
| 输入 | expected、场景参考、系统默认规则。 |
| 输出 | expected behavior 列表。 |
| 缺了会怎样 | 最后无法判断过没过。 |

### 7.4 风险关注点提取

| 项 | 内容 |
|---|---|
| 要做什么 | 找出最需要盯的失败现象。 |
| 输入 | concerns、known failure、场景库。 |
| 输出 | panic、timeout、crash、black screen、leak、rollback fail 等风险点。 |
| 缺了会怎样 | 观察会太泛，关键现场可能丢。 |

### 7.5 可刺激动作建议

| 项 | 内容 |
|---|---|
| 要做什么 | 建议用什么动作暴露问题。 |
| 输入 | 功能域、expected、constraints、场景参考。 |
| 输出 | suggested actions，例如重启、断网、压测、反复调用、kill 服务。 |
| 缺了会怎样 | 只会被动观察，无法主动验证功能边界。 |

注意：这里只是建议动作，不是执行动作。

### 7.6 观察点生成

| 项 | 内容 |
|---|---|
| 要做什么 | 生成运行中要盯的现象。 |
| 输入 | 功能域、风险点、目标设备提示。 |
| 输出 | observe list，例如 serial、process、latency、screen、resource。 |
| 缺了会怎样 | Observer 和 Rule Engine 不知道该重点看什么。 |

### 7.7 证据需求生成

| 项 | 内容 |
|---|---|
| 要做什么 | 明确正常和失败时要收哪些证据。 |
| 输入 | 功能域、风险点、场景参考。 |
| 输出 | evidence need，例如 dmesg、logcat、thread stack、screenshot。 |
| 缺了会怎样 | 失败后没有足够证据给 Coding Agent 修。 |

### 7.8 通过/失败条件生成

| 项 | 内容 |
|---|---|
| 要做什么 | 把成功和失败写成可判断条件。 |
| 输入 | expected、threshold、场景参考、默认规则。 |
| 输出 | pass/fail 条件。 |
| 缺了会怎样 | 只能给模糊结论，无法自动判定。 |

### 7.9 缺信息识别

| 项 | 内容 |
|---|---|
| 要做什么 | 判断哪些信息不足以形成可靠 intent。 |
| 输入 | 需求、目标、约束、场景参考。 |
| 输出 | missing_info 和低置信度说明。 |
| 缺了会怎样 | Agent 会编造测试方式或阈值。 |

### 7.10 Intent 输出

| 项 | 内容 |
|---|---|
| 要做什么 | 生成结构化 Validation Intent。 |
| 输入 | 上面所有分析结果。 |
| 输出 | feature_area、confidence、matched_scenarios、expected_behavior、risk_focus、suggested_actions、observe、evidence_need、pass_fail、assumptions、missing_info、inferred_values。 |
| 缺了会怎样 | Planner 没有稳定输入。 |

### 7.11 场景匹配

| 项 | 内容 |
|---|---|
| 要做什么 | 从场景库找到 1-3 个类似场景作为参考。 |
| 输入 | feature_area、task、what_changed、known_failure。 |
| 输出 | matched_scenarios、匹配原因、置信度。 |
| 缺了会怎样 | 只能凭空推断，观察点和证据需求容易漏。 |

场景匹配不是选模板。

它只是借用类似场景的：

- 常见失败现象。
- 常见观察点。
- 常见证据需求。
- 常见判断条件。
- 风险提醒。

### 7.12 阈值推断

| 项 | 内容 |
|---|---|
| 要做什么 | 调用方没有给阈值时，给出保守默认值并标注来源。 |
| 输入 | expected、feature_area、场景参考、系统默认规则。 |
| 输出 | inferred_values。 |
| 缺了会怎样 | 要么无法自动判断，要么偷偷编造阈值。 |

规则：

- 有调用方阈值，用调用方阈值。
- 没有调用方阈值，用系统默认值。
- 默认值必须标记 `recommend_confirm=true`。
- 不能把推断阈值伪装成业务事实。

### 7.13 依赖分析

| 项 | 内容 |
|---|---|
| 要做什么 | 分析功能验证依赖哪些前提。 |
| 输入 | feature_area、expected、test_hint、场景参考。 |
| 输出 | prerequisites 和 assumptions。 |
| 缺了会怎样 | Planner 可能直接跑测试，但前置服务、网络、外设或数据没准备好。 |

例子：

- IPC 测试依赖两个服务都 ready。
- 网络重连测试依赖能控制网络状态。
- UI 黑屏测试依赖截图或拍屏能力。
- OTA 测试依赖可读取版本和回滚状态。

### 7.14 影响面分析

| 项 | 内容 |
|---|---|
| 要做什么 | 根据改动描述和可选 changed_files 判断可能影响哪些功能。 |
| 输入 | what_changed、component、changed_files、related_issues。 |
| 输出 | affected_areas。 |
| 缺了会怎样 | 只验证主功能，可能漏掉相邻风险。 |

P0 只做轻量影响面分析。

允许：

- 从文件路径、模块名、组件名推断影响面。
- 从 related issues 借用风险提示。

不做：

- 深度代码调用链分析。
- 自动根因定位。
- 自动证明影响范围完整。

## 8. 和 Planner 的边界

| 问题 | Function Analysis 阶段 | Task Planner 编排阶段 |
|---|---|---|
| 该验证什么 | 负责 | 使用 |
| 正常应该看到什么 | 负责 | 转成 success criteria |
| 失败通常长什么样 | 负责 | 转成 failure signals |
| 建议做哪些动作 | 提建议 | 选择可执行能力 |
| target 有没有能力 | 不负责 | 读取 capabilities |
| 怎么安排步骤顺序 | 不负责 | 负责 |
| 是否违反约束 | 提醒风险 | Planner 避免，Orchestrator 硬校验 |
| 具体调用哪个工具 | 不负责 | 不直接负责，由 Orchestrator 绑定 |

## 9. P0 范围

P0 只做这些功能分析能力：

- 需求解析。
- 功能域识别。
- 场景匹配。
- 行为预期提取。
- 风险关注点提取。
- 依赖分析。
- 轻量影响面分析。
- 观察点生成。
- 证据需求生成。
- 通过/失败条件生成。
- 阈值推断，但只允许保守默认值，并标记需要确认。
- 缺信息识别。
- 输出 Validation Intent。

P0 不做：

- 深度代码静态分析。
- 自动读完整代码库推断功能。
- 自动生成测试脚本。
- 自动判断代码根因。
- 自动把推断阈值当作业务事实。
- 自动修改 Target Profile。

## 10. 收口

功能分析的核心是：

```text
把“我改了这个功能”
变成
“真机上该验证这些现象”。
```

它不负责连接、不负责调试、不负责工具执行。

它给 Planner 一个干净的输入，让后续编排不再只靠“刷机跑 smoke”。
