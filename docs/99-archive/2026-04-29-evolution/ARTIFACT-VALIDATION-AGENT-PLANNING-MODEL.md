# Artifact Validation Agent 编排模型

> 状态：Draft  
> 日期：2026-04-28  
> 目的：说明 LLM 怎么根据需求自己编排验证流程，以及系统需要提供什么边界。  
> 核心结论：场景库是参考手册，不是硬编码流程。  
> 关系：Task Planner 的 prompt、输入组装、输出解析和校验见 [ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md](ARTIFACT-VALIDATION-AGENT-LLM-INTEGRATION.md)。

## 1. 一句话

我们不把每个场景写死成固定脚本。

正确方式是：

```text
LLM 读懂验证需求，
查看目标设备有哪些能力，
参考常见场景做法，
在约束范围内生成 Plan，
Orchestrator 校验后执行。
```

场景库的作用不是让系统这样写：

```text
if 场景 == 启动挂了:
  固定执行 flash -> watch_serial -> wait_adb
```

而是让 LLM 知道：

```text
启动类问题通常要关注串口、panic、boot marker、ADB online、最后输出窗口。
但具体怎么编排，要看这次需求、目标设备能力和安全约束。
```

## 2. 场景库的定位

场景库是参考材料，不是执行脚本。

| 是什么 | 不是什么 |
|---|---|
| 常见问题的工程经验 | 硬编码流程 |
| 帮 Task Planner 理解需求 | 固定 if/else 逻辑 |
| 帮团队统一语言 | 强制模板 |
| 提醒 Agent 该观察什么 | 工具调用清单 |
| 提醒 Agent 失败时该抓什么 | 每个场景的固定参数 |

LLM 可以参考场景库，但不必须完全照做。

它应该能：

- 根据需求组合不同能力。
- 根据 Target Profile 调整计划。
- 根据 constraints 去掉危险动作。
- 根据运行中观察结果追加补采集。
- 遇到场景库没有的需求时，仍然基于能力和约束生成新计划。

## 3. 真正要设计的东西

我们真正要设计的是 5 件事：

| 要设计 | 作用 |
|---|---|
| 能力说明 | 告诉 LLM 和 Orchestrator 系统能做什么。 |
| 能力接口 | 每个能力需要什么输入、会输出什么结果。 |
| 编排约束 | 告诉 LLM 什么不能做，哪些动作需要允许。 |
| 场景参考 | 给 LLM 常见问题的经验提示。 |
| Plan 校验 | Orchestrator 判断 LLM 生成的计划能不能安全执行。 |

不要设计成：

| 不要做 | 原因 |
|---|---|
| 硬编码每个场景流程 | 不灵活，新场景会爆炸。 |
| 让场景库直接驱动执行 | 场景是经验，不是事实。 |
| 让 LLM 直接执行工具 | 安全和状态不可控。 |
| 让 LLM 猜设备协议 | 板子怎么连必须由 Human 配置。 |

## 4. Task Planner 输入

Task Planner 需要看到这些信息：

```text
验证需求
artifact
target id
目标设备可用能力
约束
场景参考
```

示例：

```json
{
  "demand": {
    "description": "验证 boot crash 是否修复，改了 init service 启动顺序",
    "expected": "设备能启动完成，ADB 能回来，不再出现 panic",
    "concerns": ["panic", "init timeout", "adb offline"]
  },
  "artifact": {
    "path": "/builds/firmware.img",
    "type": "firmware_img"
  },
  "target": {
    "id": "board-01",
    "capabilities": ["flash", "watch_serial", "wait_adb", "shell_exec", "collect_logs"]
  },
  "constraints": {
    "max_duration_sec": 600,
    "allow_flash": true,
    "allow_reboot": true,
    "allow_power_cycle": false,
    "allow_kill_process": false,
    "allow_inject_fault": false
  },
  "scenario_references": [
    "启动挂了",
    "ADB 不回来"
  ]
}
```

## 5. Task Planner 要做什么

Task Planner 的工作不是“选一个模板”。

它要做的是：

```text
理解需求
-> 判断要验证什么现象
-> 查目标设备有什么能力
-> 参考类似场景的常见做法
-> 选择需要的能力
-> 安排能力顺序
-> 写出成功/失败判断
-> 写出失败时要补采集什么
-> 输出结构化 Plan
```

Task Planner 内部有两个阶段：

```text
Function Analysis
-> 输出 Validation Intent

Planning
-> 把 Validation Intent 翻译成 target 能力级 Plan
```

`suggested_actions` 不能直接执行。

例子：

```text
Intent: 建议断网恢复
-> 查询 target capabilities
-> 有 network_control：生成 cut_network / restore_network / monitor_service / verify_request
-> 没有 network_control：返回能力不足，不编造测试方式
```

这个翻译逻辑属于 Task Planner，不单独拆模块。

### 例子：boot crash 修复验证

LLM 应该推理出：

```text
这次验证的是启动是否正常。
产物是 firmware，需要刷到设备上。
关注点是 panic、init timeout、ADB 是否回来。
target 有 flash、serial、ADB。
约束允许 flash，不允许 power cycle。
所以可以刷机、看串口、等 ADB、失败时采 serial/dmesg/logcat。
不能设计断电恢复，因为约束不允许 power cycle。
```

输出 Plan：

```json
{
  "steps": [
    {
      "capability": "flash",
      "input": {
        "artifact": "/builds/firmware.img"
      }
    },
    {
      "capability": "watch_serial",
      "input": {
        "duration_sec": 180,
        "patterns": ["kernel panic", "init timeout", "boot completed"]
      }
    },
    {
      "capability": "wait_adb",
      "input": {
        "timeout_sec": 180
      }
    },
    {
      "capability": "collect_logs",
      "condition": "on_failure",
      "input": {
        "items": ["serial_last_window", "dmesg", "logcat"]
      }
    }
  ],
  "success_criteria": [
    "boot completed",
    "adb online",
    "no kernel panic"
  ],
  "failure_signals": [
    "kernel panic",
    "init timeout followed by boot hang",
    "adb offline after timeout"
  ],
  "estimated_duration_sec": 360
}
```

## 6. 能力说明怎么写

能力说明要给两类对象看：

- Task Planner：知道能不能把这个能力放进 Plan。
- Orchestrator：知道怎么校验和执行。

示例：

```json
{
  "capability": "watch_serial",
  "description": "观察串口输出，并把关键 pattern 转成事件",
  "input_schema": {
    "duration_sec": "integer",
    "patterns": "array<string>"
  },
  "output_schema": {
    "log_ref": "string",
    "events": "array<object>",
    "patterns_matched": "array<string>"
  },
  "requires": {
    "connection": "serial"
  },
  "limits": {
    "max_duration_sec": 600
  },
  "risk": "low"
}
```

再比如故障注入：

```json
{
  "capability": "cut_network",
  "description": "临时断开目标设备网络，然后恢复",
  "input_schema": {
    "duration_sec": "integer"
  },
  "output_schema": {
    "network_cut_at": "timestamp",
    "network_restored_at": "timestamp"
  },
  "requires": {
    "connection": "network_controller"
  },
  "requires_permission": "allow_inject_fault",
  "risk": "medium"
}
```

这样 LLM 可以计划“断网恢复测试”，但 Orchestrator 会检查：

- target 有没有网络控制能力。
- constraints 是否允许故障注入。
- 断网时长是否超过上限。

## 7. 约束怎么生效

约束不是提示词，它必须由 Orchestrator 硬校验。

例子：

```json
{
  "constraints": {
    "allow_flash": true,
    "allow_reboot": true,
    "allow_power_cycle": false,
    "allow_kill_process": false,
    "allow_inject_fault": false,
    "max_duration_sec": 600
  }
}
```

如果 LLM 生成：

```json
{
  "capability": "power_cycle"
}
```

Orchestrator 必须拒绝：

```json
{
  "status": "rejected",
  "reason": "plan uses power_cycle but allow_power_cycle=false"
}
```

如果 LLM 生成：

```json
{
  "capability": "kill_process",
  "input": {
    "process": "system_server"
  }
}
```

Orchestrator 也必须拒绝，除非：

- Target Profile 支持这个动作。
- constraints 允许 kill process。
- process 在允许列表里。

## 8. 场景参考怎么喂给 LLM

场景库不要整篇塞给 LLM。

推荐流程：

```text
根据 demand 找 1-3 个相关场景
-> 摘出每个场景的“观察、证据、判断、风险”
-> 连同能力列表和约束一起给 Task Planner
```

示例：

```json
{
  "scenario_reference": {
    "name": "网络断连恢复",
    "common_actions": ["cut_network", "restore_network", "monitor_service"],
    "watch": ["network state", "service reconnect", "crash"],
    "evidence": ["network status log", "service log", "reconnect duration"],
    "pass_fail": [
      "network restored within configured time",
      "service reconnects within threshold",
      "service does not crash"
    ],
    "risk": [
      "requires allow_inject_fault",
      "must restore network after test"
    ]
  }
}
```

Task Planner 可以参考它，但最终输出的还是 Plan。

## 9. Orchestrator 校验什么

Orchestrator 至少校验这些：

| 校验项 | 例子 |
|---|---|
| 能力是否存在 | Plan 里用了 `cut_network`，但 target 没有网络控制能力。 |
| 连接是否配置 | Plan 里用了 `watch_serial`，但 target 没有 serial。 |
| 权限是否允许 | Plan 里用了 `power_cycle`，但 constraints 不允许。 |
| 参数是否合规 | watch_serial 要 3600 秒，但上限是 600 秒。 |
| 总时长是否超限 | steps 预估总时长超过 `max_duration_sec`。 |
| 危险对象是否允许 | kill 的进程不在 allowlist。 |
| 证据是否可收集 | Plan 要 collect logcat，但 target 没有 ADB。 |
| 恢复动作是否存在 | 断网测试必须有 restore_network。 |

校验失败时，不要让 Runtime 猜。

返回：

```json
{
  "status": "plan_rejected",
  "reasons": [
    "cut_network requires network_controller but target board-01 does not provide it",
    "allow_inject_fault=false"
  ],
  "suggested_next": "remove network fault injection or choose a target with network control"
}
```

如果 Task Planner 输出 `clarification_needed`，Orchestrator 不进入执行阶段。

返回给调用方：

```json
{
  "status": "clarification_needed",
  "missing_info": [
    "missing expected behavior",
    "missing test entry"
  ],
  "reason": "validation intent confidence is too low to build a safe plan"
}
```

## 10. Observer 运行中怎么调整

Observer 可以调整，但不能随便改流程。

允许的调整：

- 继续等一段时间。
- 提前停止。
- 增加补采集。
- 跳过后续无意义步骤。
- 在安全范围内增加检查步骤。

不允许的调整：

- 绕过 constraints。
- 新增危险动作。
- 修改 Target Profile。
- 直接执行工具。

例子：

```json
{
  "intent": "collect_more",
  "reason": "serial shows init timeout and adb is still offline",
  "requested_actions": [
    {
      "capability": "collect_logs",
      "input": {
        "items": ["serial_last_window"]
      }
    }
  ]
}
```

Orchestrator 仍然要校验 `collect_logs` 是否可用。

## 11. Rule Engine 什么时候触发 Observer

Observer 不应该自己盲目轮询全量日志。

P0 调用时机：

| 触发 | 说明 |
|---|---|
| 关键异常事件 | panic、oops、crash、hang、异常重启。 |
| 关键超时 | ADB offline 太久、step timeout、run timeout。 |
| 长时间静默 | serial 或命令输出超过阈值无输出。 |
| 关键成功事件 | boot completed、adb online、reconnect success、test passed。 |
| 阶段完成 | flash 完成、deploy 完成、collect 完成。 |
| 定期低频检查 | 长任务中每隔一段时间看趋势。 |

触发链路：

```text
Rule Engine -> Event -> Evidence window -> Observer -> Intent -> Orchestrator
```

普通日志行只进入 raw log 和 event stream，不必每行触发 LLM。

## 12. Observer 主动汇报

长任务里，Agent 不能只等最终结果。

Observer 可以输出 intermediate observation：

```json
{
  "type": "intermediate_observation",
  "summary": "boot completed, waiting for adb",
  "concern_level": "medium",
  "suggested_wait_sec": 60
}
```

Orchestrator 把它写成 run event，供 `watch_run` 推送。

这不是新接口，是 event stream 的一种事件。

## 13. Evidence 不能被 LLM 压缩丢

Reply Generator 可以总结 evidence，但不能替代 evidence。

硬规则：

```text
Rule Engine 标记的事件必须保留。
事件前后窗口必须保留。
原始日志必须可追溯。
LLM 摘要只能引用 evidence ref，不能覆盖原始证据。
```

这保证 Coding Agent / Human 能回看现场，而不是只看到一句总结。

## 14. 什么是好 Plan

好 Plan 要满足：

- 能解释为什么做这些步骤。
- 每一步都对应 target 可用能力。
- 每个危险动作都被 constraints 允许。
- 有清楚的成功判断。
- 有清楚的失败信号。
- 失败时知道抓什么证据。
- 有预估时长。
- 不依赖 LLM 在执行时临场猜工具。

坏 Plan 的例子：

```text
刷机后观察一下，如果不对就处理。
```

问题：

- 没说观察什么。
- 没说怎么判断不对。
- 没说失败抓什么。
- 没说用哪些能力。
- Orchestrator 无法校验。

## 15. 收口

最终边界是：

```text
场景库提供经验。
能力说明提供可执行动作。
constraints 提供安全边界。
Task Planner 负责组合。
Orchestrator 负责校验。
Tool Adapter 负责执行。
Observer 只在运行中提出受限调整。
```

这才是“LLM 自己编排”的正确方式。

LLM 可以灵活，但系统必须有边界。
