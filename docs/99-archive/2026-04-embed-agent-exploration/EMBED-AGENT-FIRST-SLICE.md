# Embed Agent 第一条最短 Demo 链

> 状态：Draft
> 日期：2026-04-28
> 目的：把第一条必须先打通的真实链路定死，避免实现时继续发散。

## 1. 结论

第一条链默认就选这条：

```text
Coding Agent 编译产物
-> Embed Agent 接收 artifact
-> flash 到目标设备
-> Serial 持续观察启动现场
-> 等待 ADB 恢复
-> 执行 agent 指定的 ADB shell / collect logs
-> 产出 evidence package
-> 过滤 evidence，提炼 key events
-> 生成 observation summary
-> handoff 给 Coding Agent
```

一句人话：

```text
agent 把产物交给 Embed Agent。
Embed Agent 负责把产物刷进板子、盯现场、留证据、把结果讲清楚。
```

## 2. 为什么选这条

因为它同时满足三件事：

1. 符合角色边界：编译归 Coding Agent，真机现场归 Embed Agent。
2. 能证明核心价值：产物进入设备以后，现场能被系统稳定接住。
3. 能逼出关键能力：异步 run、刷机、串口、ADB、证据、摘要、交接。

## 3. 这条链覆盖哪些核心能力

| 能力 | 是否覆盖 |
|---|---|
| Async Run | 覆盖 |
| Target | 覆盖 |
| Target Runtime State | 覆盖 |
| Artifact Intake | 覆盖 |
| Step Plan | 覆盖 |
| Flash Step | 覆盖 |
| Serial Watch Step | 覆盖 |
| Wait ADB Step | 覆盖 |
| ADB Shell / Collect Logs | 覆盖 |
| Run Events | 覆盖 |
| Partial Evidence | 覆盖 |
| Evidence Package | 覆盖 |
| Evidence Filtering | 覆盖 |
| Observation Summary | 覆盖 |
| Agent Handoff | 覆盖 |
| Action Visibility / Audit | 覆盖，不拦路 |
| Minimal Console View | 覆盖，只读状态视图 |

## 4. 这条链故意不覆盖什么

第一条链明确不吃下面这些：

- build adapter
- workspace 管理
- case 聚合
- recipe 沉淀
- approval / permission
- CI / HIL
- 多设备拓扑
- 共享实验室
- power control
- probe 级调试
- 固定 verdict 规则

这些都可能重要，但不是第一条链该背的复杂度。

## 5. 进入条件

要启动这条链，至少需要：

- Coding Agent 已经编译好一个可刷产物
- 一个最小 target profile
- 一种可用 flash 方式
- 一条可稳定读取的 Serial
- 一个可等待的 ADB 目标
- 一组 agent 传入的 steps

不要求：

- workspace
- case_id
- recipe_id
- 人工确认
- build host

## 6. 最小请求

```json
{
  "goal": "把新固件刷到 board-01，并观察启动是否异常",
  "target": "board-01",
  "artifacts": [
    {
      "id": "firmware",
      "kind": "firmware_image",
      "path": "/path/to/firmware.img"
    }
  ],
  "steps": [
    { "type": "flash", "artifact_id": "firmware" },
    { "type": "watch_serial", "duration_sec": 120 },
    { "type": "wait_adb", "timeout_sec": 180 },
    { "type": "adb_shell", "command": "dmesg | tail -100" }
  ]
}
```

`create_run` 创建后立即执行。  
它返回 `run_id`、当前状态和 `action_summary`。

`action_summary` 只做信息透明，不做审批拦截。

## 7. 运行时对象流

```text
agent.create_run
-> run.created
-> input.validate
-> target.resolve
-> artifact.intake
-> step.execute.flash
-> step.execute.watch_serial
-> step.execute.wait_adb
-> step.execute.adb_shell / collect_logs
-> evidence.package
-> observation.summary
-> agent.handoff
```

## 8. 最小验收

这条链算打通，至少要满足：

- Agent 能通过一个入口创建 run。
- `create_run` 能立即返回 `run_id`。
- Run 能按 steps 顺序执行。
- 能刷入一个指定 artifact。
- 能持续收 Serial 输出。
- 能等待 ADB 恢复并记录超时。
- 能执行至少一条 ADB shell 命令。
- 运行中能查询状态和最近事件。
- 运行中能读取 partial evidence。
- 取消后不丢已采集 evidence。
- run 结束后能导出 Evidence Package。
- 能提炼 Key Events 和过滤后的 evidence。
- 能生成 Observation Summary。
- 能生成给 Coding Agent 的 Handoff。
- Human 能看到最小状态视图。
- 能记录 action summary 和 audit。

## 9. 为什么不是别的链

### 9.1 为什么不是 build

编译是 Coding Agent 的事情。  
第一版让 Embed Agent 接管 build，会把代码工作区、构建环境、依赖缓存、产物路径都拉进 runtime，边界会变重。

### 9.2 为什么不是 push-only

当前故事从刷机开始。  
push-only 可以后续作为一种 step，但第一条链要证明 Embed Agent 能接住更真实的设备状态变化。

### 9.3 为什么不是权限 / 审批

个人开发调试场景不需要系统每次挡路。  
第一版要做到看得见、查得到、留得住，不做审批系统。

### 9.4 为什么不是固定 verdict

什么叫通过，应该由 Coding Agent 的任务目标决定。  
Embed Agent 只提供事实、摘要和可解释的候选观察，不把业务判定写死。

## 10. 第二条链建议

第一条链跑稳后，下一条最该接的是：

```text
黑卡死 / 无响应现场抓取
-> failure snapshot
-> partial evidence
-> 显式 recover_run
-> evidence timeline
```

## 11. 收口

第一条链的意义不是证明功能很多。

而是证明：

```text
Embed Agent 真的能在 Coding Agent 编译出产物以后，
把真实设备现场稳定接住，
并把证据和观察结果交回修复闭环。
```
