# Embed Agent 第一版规格说明

> 状态：Draft
> 日期：2026-04-28
> 目的：把第一版到底做什么、怎么调用、怎么验收、哪些不做一次写清楚。

## 1. 一句话定义

`Embed Agent` 是一个面向嵌入式开发现场的验证 runtime。

第一版默认：

```text
Coding Agent 负责编译产物。
Embed Agent 负责把产物带进真实设备现场，并把现场证据交回给 Coding Agent。
```

## 2. 第一版主用户

| 角色 | 第一版怎么用 |
|---|---|
| Human | 定义问题、看结果、必要时接管设备 |
| Coding Agent | 编译产物、调用 run、消费 evidence 和 summary、继续修复 |
| Embed Agent Runtime | 执行 steps、管理设备状态、收证据 |
| LLM Worker | 过滤 evidence、摘要关键事件、生成 handoff |
| Toolchain / Device | 执行刷机、ADB、Serial 等真实动作 |

## 3. 第一版主链路

```text
Coding Agent 编译产物
-> create_run(goal, target, artifacts, steps)
-> Embed Agent 返回 run_id 并立即执行
-> flash
-> watch_serial
-> wait_adb
-> adb_shell / collect_logs
-> evidence package
-> observation summary
-> handoff
```

## 4. 第一版要做

### 4.1 对外调用

- `create_run`：创建并立即开始执行 run。
- `get_run`：查询状态、当前步骤、最近事件。
- `get_run_events`：读取 run 事件，第一版可先轮询。
- `get_partial_evidence`：运行中读取已采集事实。
- `cancel_run`：取消长任务，但保留已有证据。
- `get_run_result`：读取过滤后的 evidence、summary、key events、handoff 和原始 evidence 入口。
- `list_targets` / `get_target`：查询目标设备和状态。
- `get_console_view`：给 Human 读取最小状态视图。

### 4.2 P0 step

- `flash`
- `watch_serial`
- `wait_adb`
- `adb_shell`
- `collect_logs`
- `sleep`

### 4.3 P0 对象

- `Run`
- `Target`
- `TargetRuntimeState`
- `Artifact`
- `StepPlan`
- `RunEvent`
- `PartialEvidence`
- `EvidencePackage`
- `FilteredEvidence`
- `ObservationSummary`
- `AgentHandoff`
- `ActionSummary / Audit`
- `MinimalConsoleView`

## 5. 第一版明确不做

- 不做代码编辑能力。
- 不做编译主线。
- 不要求 workspace。
- 不要求 case。
- 不要求 recipe。
- 不做权限 / 审批系统。
- 不做逐次确认流程。
- 不内置固定 verdict 规则。
- 不做完整 CI / HIL。
- 不做共享实验室治理。
- 不做多设备拓扑。

## 6. create_run 请求

```json
{
  "goal": "把新固件刷到 board-01，并观察启动是否异常",
  "target": "board-01",
  "artifacts": [
    {
      "id": "firmware",
      "kind": "firmware_image",
      "path": "/path/to/firmware.img",
      "checksum": "optional"
    }
  ],
  "steps": [
    { "type": "flash", "artifact_id": "firmware" },
    { "type": "watch_serial", "duration_sec": 120 },
    { "type": "wait_adb", "timeout_sec": 180 },
    { "type": "adb_shell", "command": "dmesg | tail -100" }
  ],
  "source_ref": {
    "revision": "optional",
    "note": "optional"
  },
  "case_id": "optional"
}
```

信息必要性：

| 信息 | 是否必需 | 说明 |
|---|---|---|
| `goal` | 建议必需 | 给 summary 和 handoff 上下文 |
| `target` | 必需 | 没有目标设备就无法执行 |
| `artifacts` | 对刷机场景必需 | 编译产物来自 Coding Agent |
| `steps` | 必需 | Runtime 不猜流程，由 agent 组合能力 |
| `source_ref` | 可选 | 用于回绑代码上下文 |
| `case_id` | 可选 | 多轮聚合后续再做 |

## 7. create_run 响应

```json
{
  "run_id": "run-001",
  "status": "running",
  "current_step": "flash",
  "action_summary": {
    "will_flash": true,
    "will_reboot": "depends_on_flash_tool",
    "will_delete": false,
    "will_power_cycle": false
  },
  "evidence": {
    "partial_available": false
  }
}
```

`action_summary` 只做透明展示和 audit，不阻塞执行。

## 8. Run 状态

最小状态：

```text
created
validating
running
paused
cancelling
failed
collecting_evidence
summarizing
completed
cancelled
```

取消语义：

- 如果 run 还没开始执行步骤，可以直接 cancelled。
- 如果 run 已经开始，必须保留已采集 partial evidence。
- cancelled 也可以有 evidence package 和 observation summary。
- `paused` 表示 Runtime 已保存现场，正在等待 Human 或 Agent 决定是否恢复、取消或结束。

### 8.1 get_console_view 响应

最小 Console 状态视图只读 Runtime 状态，不单独保存状态。

```json
{
  "run_id": "run-001",
  "status": "running",
  "current_step": "watch_serial",
  "elapsed_sec": 86,
  "action_summary": {
    "will_flash": true,
    "will_reboot": "depends_on_flash_tool",
    "will_delete": false
  },
  "key_events": [
    { "time": "+00:12", "event": "flash completed" },
    { "time": "+01:10", "event": "serial boot marker observed" }
  ],
  "recent_log_excerpt": "optional",
  "failure_snapshot_available": false,
  "observation_summary_available": false
}
```

## 9. Evidence 和 Summary

`EvidencePackage` 只放事实：

- artifact metadata
- step plan
- step timeline
- flash output
- serial raw log
- ADB state
- command stdout / stderr / exit code
- collected logs
- failure snapshot

`FilteredEvidence` 是前置过滤结果：

- summary
- key events
- 异常片段
- 重要时间点
- candidate observation
- 原始 evidence 引用

`ObservationSummary` 是解释：

- 本次做了什么。
- 哪一步失败或超时。
- 关键日志是什么。
- 哪些证据值得 Coding Agent 看。
- 可选 candidate observation，但必须带依据。

默认给 Coding Agent 的是 `FilteredEvidence + ObservationSummary + AgentHandoff`。  
原始 `EvidencePackage` 完整保留，供 Human 深挖、复盘和归档。

## 10. 成功标准

第一版完成，不看功能数量，看这条链是否能跑通：

- Coding Agent 能传入 artifact、target、steps 创建 run。
- `create_run` 能立即返回 `run_id`。
- Runtime 能按 steps 执行。
- 能刷入 artifact。
- 能持续收 Serial。
- 能等待 ADB 恢复。
- 能执行 ADB shell 或采日志。
- 运行中能查状态和事件。
- 运行中能读 partial evidence。
- 取消后不丢已采集 evidence。
- 结束后能导出 EvidencePackage。
- 能生成 FilteredEvidence 和 Key Events。
- 能生成 ObservationSummary。
- 能生成 AgentHandoff。
- Human 能通过最小 Console 状态视图看到 run 状态、当前阶段、动作摘要、关键事件和结果摘要。
- 动作可见且可追溯。

## 11. 测试与验证策略

文档阶段：

- 检查角色分工是否一致。
- 检查 P0 是否只围绕第一条链。
- 检查是否混入 workspace、build、approval、fixed verdict。

编码阶段：

- Runtime 状态机单元测试。
- Step executor 单元测试。
- Artifact input 校验测试。
- Evidence package 结构测试。
- Mock target 集成测试。
- 真实 target 手工 smoke：flash -> serial -> wait adb -> adb shell -> evidence。

## 12. P1 / P2 延后项

P1：

- Case
- Recipe
- Source Context / Revision
- Target Reservation
- Recovery
- Failure Snapshot 增强
- Full Console
- Config Normalize

P2：

- Build Adapter
- Workspace
- Approval / Permission
- CI / HIL
- 多设备拓扑
- Power Control
- Probe 调试
- Baseline 对比

## 13. 收口

第一版规格只定一件事：

```text
Embed Agent 要先成为 Coding Agent 进入真实设备现场的 runtime。
```
