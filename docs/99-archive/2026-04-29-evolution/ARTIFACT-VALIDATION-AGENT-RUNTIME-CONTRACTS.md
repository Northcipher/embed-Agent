# Artifact Validation Agent Runtime 实现契约

> 状态：Draft  
> 日期：2026-04-28  
> 目的：补齐 Runtime-only P0 实现前必须稳定的执行契约。  
> 范围：状态机、Intent 校验、Rule 定义、Tool Adapter 执行契约、缺信息判断。  
> 非范围：LLM prompt、模型选择、prompt 版本管理、长远调度平台。

## 1. 核心判断

这份文档只补 Runtime 跑起来需要的硬契约。

第一版实现顺序仍然是：

```text
先让手写 Plan 跑通 Runtime。
再接 Task Planner / Observer / Reply Generator。
```

所以这里不定义完整 LLM prompt 体系。  
LLM 输出只要满足已有结构，Runtime 就按本契约校验和执行。

## 2. Run State Machine

### 2.1 Run 状态

P0 Run State 固定为：

```text
queued
planning
running
collecting_evidence
completed
failed
paused
cancelled
```

`clarification_needed`、`artifact_invalid`、`target_busy`、`plan_rejected` 是请求返回状态或拒绝原因，不是 Run State。

### 2.2 状态转换表

| from | to | 触发条件 | 发起方 | 写入方 |
|---|---|---|---|---|
| none | queued | `validate_artifact` 通过同步校验，但 worker 尚未开始。 | Run Manager | Run Manager |
| none | planning | `validate_artifact` 通过同步校验，并立即开始 planning。 | Run Manager | Run Manager |
| queued | planning | 本地 run worker 开始处理。 | Run Manager | Run Manager |
| planning | running | Plan 通过 Orchestrator 校验。 | Orchestrator | Run Manager 写 state，Orchestrator 写 event |
| planning | failed | Plan 已落盘但校验失败，或 planning 阶段内部错误。 | Run Manager / Orchestrator | Run Manager |
| running | paused | Human 干预或 Observer Intent 请求暂停，并通过校验。 | Orchestrator | Run Manager |
| paused | running | `resume` 干预通过校验。 | Orchestrator | Run Manager |
| running | collecting_evidence | 主路径完成，或失败后进入最终补采集。 | Orchestrator | Run Manager |
| paused | collecting_evidence | Human 取消暂停并选择收尾，或系统需要保留现场后结束。 | Orchestrator | Run Manager |
| collecting_evidence | completed | 验证通过，最终 evidence / reply 已写入。 | Run Manager | Run Manager |
| collecting_evidence | failed | 验证失败，最终 evidence / reply 已写入。 | Run Manager | Run Manager |
| queued | cancelled | run 尚未开始时被取消。 | Run Manager | Run Manager |
| planning | cancelled | planning 阶段被取消。 | Run Manager | Run Manager |
| running | cancelled | cancel 请求被接受；当前不可中断动作结束或超时后生效。 | Orchestrator | Run Manager |
| paused | cancelled | paused 状态下取消。 | Run Manager | Run Manager |
| collecting_evidence | cancelled | 收尾采集阶段取消；已产生 evidence 必须保留。 | Run Manager | Run Manager |

终态：

```text
completed
failed
cancelled
```

终态不能再转出。

### 2.3 非法转换处理

非法状态转换不能静默忽略。

处理规则：

| 来源 | 处理 |
|---|---|
| 外部接口请求 | 返回公共错误结构，`error_code=invalid_request`。 |
| `intervene_run` 请求 | 返回 `accepted=false`，说明当前状态不允许该 action。 |
| 内部调度错误 | 写入 `run_failed` 或保留当前状态并写明确错误 payload；不能伪造成功。 |

不新增 `state_transition_failed` 事件类型。  
如果需要记录一次被拒绝的干预，使用已有 `intervention_requested`，在 payload 中写：

```json
{
  "action": "resume",
  "accepted": false,
  "reason": "run is not paused"
}
```

## 3. Observer Intent 校验

### 3.1 Intent 输入结构

P0 Observer Intent 使用功能文档中的结构，并允许一个可选 `params`：

```json
{
  "intent": "collect_more",
  "reason": "serial shows init timeout and adb is still offline",
  "confidence": 0.82,
  "params": {},
  "requested_actions": [
    {
      "capability": "collect_logs",
      "input": {
        "items": ["serial_last_window"]
      }
    }
  ],
  "report_to_caller": false
}
```

`params` 只给非 capability 类 intent 使用，例如 `extend_wait` 的 `extra_wait_sec`。

### 3.2 通用校验

所有 Intent 必须满足：

| 规则 | 处理 |
|---|---|
| `intent` 必须在允许枚举内。 | 否则拒绝。 |
| `reason` 必须非空。 | 否则拒绝。 |
| `confidence` 必须是 0 到 1。 | 否则拒绝。 |
| `requested_actions` 必须是数组。 | 否则拒绝。 |
| 每个 requested action 的 capability 必须存在于 Capability Registry。 | 否则拒绝。 |
| 每个 requested action 的 input 必须符合 capability input schema。 | 否则拒绝。 |
| requested action 必须满足 constraints 和 target runtime state。 | 否则拒绝。 |
| requested action 不能包含连接参数、shell 注入、Target Profile 修改。 | 否则拒绝。 |

拒绝后：

```text
不执行 action。
写 observer_intent event，payload.accepted=false，并写 rejection reason。
必要时按 Orchestrator 默认规则继续、暂停或失败。
```

### 3.3 Intent 类型规则

| intent | 允许条件 | requested_actions | 执行效果 |
|---|---|---|---|
| `continue` | run 处于 `running`，当前没有 fatal event。 | 必须为空。 | 不改变 Plan，继续当前执行。 |
| `extend_wait` | 当前 step 是等待类或观察类：`watch_serial`、`wait_adb`、长时间 `shell_exec`。 | 必须为空。 | 延长当前等待，但不能超过 step capability 上限和 run max duration。 |
| `collect_more` | run 处于 `running`、`paused` 或 `collecting_evidence`。 | 只能是 `collect_logs`、`save_snapshot`。 | 执行补采集动作，写 evidence。 |
| `pause` | run 处于 `running`。 | 可为空；如有只能是 `save_snapshot`。 | 当前不可中断动作结束或超时后进入 `paused`。 |
| `stop` | 已有足够证据判断应结束，或发生 fatal event。 | 可为空；如有只能是 `collect_logs`、`save_snapshot`。 | 进入 `collecting_evidence`，然后 completed / failed。 |
| `intermediate_observation` | 任意非终态。 | 必须为空。 | 写 `intermediate_observation` event，不改变执行计划。 |

### 3.4 `extend_wait` 参数

`extend_wait` 使用：

```json
{
  "intent": "extend_wait",
  "params": {
    "extra_wait_sec": 30
  },
  "requested_actions": []
}
```

规则：

```text
extra_wait_sec 不传时默认 30s。
单次最大 60s。
累计等待不能超过 capability max duration。
累计 run 时间不能超过 constraints.max_duration_sec。
```

### 3.5 `stop` 参数

`stop` 可以携带：

```json
{
  "intent": "stop",
  "params": {
    "result_status": "failed"
  }
}
```

`result_status` 允许：

```text
completed
failed
timeout
```

P0 中 `timeout` 最终落到 Run State `failed`，但 Agent Reply 可以保留 `status=timeout` 或在 summary 中说明 timeout。

## 4. Observer 触发判断

### 4.1 触发条件

Orchestrator 决定是否触发 Observer。Rule Engine 只写 Event，不直接调用 Observer。

| event type | 条件 | 是否触发 Observer |
|---|---|---|
| `rule_matched` | severity=`error`，例如 panic / oops / fatal crash。 | 是 |
| `rule_matched` | severity=`warning`，例如 service timeout / serial silence。 | 条件触发 |
| `step_timeout` | 任意 step timeout。 | 是 |
| `step_failed` | flash / shell_exec / wait_adb 失败。 | 是 |
| `target_state_changed` | ADB offline、serial disconnected、target unknown。 | 条件触发 |
| `step_completed` | 阶段性完成且 step 是关键阶段：flash、wait_adb、shell_exec。 | 可低频触发 |
| `intervention_requested` | Human 增加 instruction。 | 条件触发 |

### 4.2 不触发条件

这些情况只记录，不触发 Observer：

```text
debug / info 级普通事件。
重复的同类 warning，仍在 debounce 窗口内。
run 已处于终态。
当前已有 Observer 调用未结束。
当前事件没有 evidence window，且默认规则已能处理。
```

### 4.3 频率限制

P0 限制：

```text
同一 run 同一时间最多 1 个 Observer 调用。
同一 rule id 的重复触发默认 debounce 30s。
低频定期检查默认每 30s 一次。
Observer 调用 timeout 默认 30s。
Observer timeout 不阻塞 Tool Adapter 输出写入。
```

Observer 调用失败时：

```text
写 observer_intent event，payload.accepted=false 或 payload.error。
Orchestrator 使用默认降级规则继续、暂停或失败。
```

## 5. Rule Engine Rule 定义

### 5.1 Rule 结构

P0 Rule 最小结构：

```json
{
  "id": "serial.kernel_panic",
  "source": "serial",
  "kind": "pattern",
  "pattern": "kernel panic|kernel oops",
  "severity": "error",
  "summary": "kernel panic matched on serial",
  "event_type": "rule_matched",
  "capture": {
    "before_lines": 120,
    "after_lines": 80,
    "ref": "serial:last-200-lines"
  },
  "trigger_observer": true,
  "debounce_sec": 30
}
```

允许的 `kind`：

| kind | 必填字段 | 输出事件 |
|---|---|---|
| `pattern` | `source`、`pattern` | `rule_matched` |
| `timeout` | `step_id` 或 capability、`timeout_sec` | `step_timeout` |
| `silence` | `source`、`silence_sec` | `rule_matched` |
| `exit_code` | `expected_exit_code` 或 `exit_code_not` | `rule_matched` 或 `step_failed` |
| `connectivity` | `target_field`、`expected_state` / `bad_state` | `target_state_changed` |

允许的 `source`：

```text
serial
adb
adb_shell
flash
tool_adapter
target_state
```

### 5.2 Rule 来源

P0 Rule 来源按优先级合并：

| 来源 | 用途 | 是否可覆盖 |
|---|---|---|
| System default rules | panic、oops、timeout、exit code、silence、ADB offline。 | 不可删除，只能收紧。 |
| Target Profile `target_hints.fail_patterns` | 目标设备特定失败模式。 | 可追加。 |
| Target Profile `target_hints.boot_markers` | 启动阶段 marker。 | 可追加。 |
| Plan step `input.patterns` | 本次 run 关注的 pattern。 | 可追加。 |
| Runtime thresholds | timeout / silence 默认值。 | request / Plan 可收紧。 |

规则：

```text
LLM 不能直接定义连接参数。
LLM 可以建议 patterns，但必须进入 Plan input，并由 Orchestrator 校验。
Target Profile 的危险动作配置不能被 Rule 覆盖。
```

### 5.3 多 Rule 命中处理

同一输出 chunk 可以命中多个 Rule。

处理规则：

```text
全部命中都可以写 Event，但同一 rule id 受 debounce_sec 限制。
severity 以最高级驱动 Orchestrator 判断。
每个写入 Event 的 rule 必须有独立 payload.rule_id。
如果多个 rule 共用同一 evidence window，可以复用 evidence_ref。
```

severity 排序：

```text
error > warning > info > debug
```

### 5.4 Rule 命中后的固定动作

Rule Engine 命中后只做事实动作：

```text
写 raw output 或确认 raw output 已写入。
保存 window / snapshot。
写 Event。
更新 Evidence Index。
通知 Orchestrator 有新 Event。
```

Rule Engine 不做：

```text
不直接 stop run。
不直接 collect_logs。
不直接调用 Observer。
不直接修改 Plan。
```

## 6. Tool Adapter 执行契约

### 6.1 通用 Adapter 输入

Orchestrator 调 Adapter 前必须解析连接参数。

Adapter 只接收：

```json
{
  "run_id": "run-001",
  "step_id": "step-2",
  "capability": "watch_serial",
  "resolved_target": {
    "target_id": "board-01",
    "connection": {}
  },
  "input": {},
  "timeout_sec": 180,
  "evidence_root": "/var/artifact-validation/runs/run-001"
}
```

Adapter 不接收：

```text
LLM 原始输出。
未校验 Plan。
未解析的 Target Profile 全量对象。
Human 输入的任意 shell。
```

### 6.2 通用 Adapter 结果

AdapterResult：

```json
{
  "step_id": "step-2",
  "capability": "watch_serial",
  "status": "completed",
  "started_at": "2026-04-28T10:01:00+08:00",
  "ended_at": "2026-04-28T10:04:00+08:00",
  "duration_sec": 180,
  "exit_code": null,
  "evidence_refs": ["serial:full"],
  "events": [],
  "error": null
}
```

`status` 允许：

```text
completed
failed
timeout
cancelled
```

Adapter 必须：

```text
写原始 evidence。
写 step_completed / step_failed / step_timeout 所需信息。
长时间执行时写 heartbeat。
失败时返回结构化 error，不只返回字符串。
```

### 6.3 FlashAdapter

P0 支持：

```text
fastboot
custom_command
```

规则：

| 项 | 契约 |
|---|---|
| `fastboot` | Runtime 根据 Target Profile 生成 fastboot 调用。 |
| `custom_command` | 命令只能来自 Target Profile，不能来自 Plan 或 Observer。 |
| artifact | 必须来自已校验 artifact metadata。 |
| output | 必须写 `flash.log`。 |
| target state | start 时写 `flashing`，成功后写 `booting` 或 `unknown`。 |
| failure | 非 0 exit、timeout、artifact mismatch 都是 `failed`。 |

Plan input 只允许：

```json
{
  "artifact_ref": "firmware_img",
  "artifact_type": "firmware_img"
}
```

### 6.4 SerialAdapter

P0 契约：

| 项 | 契约 |
|---|---|
| connection | `connections.serial.port`、`connections.serial.baud` 来自 Target Profile。 |
| duration | 来自 Plan step `input.duration_sec`，不能超过 capability limit。 |
| output | 持续写 `serial.log`。 |
| heartbeat | 读取循环中定期更新 `last_heartbeat_at`。 |
| rule feed | 每个输出 chunk 送 Rule Engine 检测。 |
| completion | 到 duration 后返回 completed，除非 disconnected / timeout / cancel。 |

不强制具体库。实现可以用 serial 库或外部命令，但对上层契约不变。

### 6.5 AdbAdapter

P0 支持能力：

```text
wait_adb
shell_exec
check_process
push
collect_logs
```

`wait_adb`：

| 项 | 契约 |
|---|---|
| input | `timeout_sec` |
| success | ADB device online，写 `target_state_changed`。 |
| failure | 超时返回 `timeout`，保留当前 target state。 |

`shell_exec`：

| 项 | 契约 |
|---|---|
| input | `command`、`timeout_sec`、`expected_exit_code` |
| command 来源 | 只能来自 `test_hint` 或已校验 Plan。 |
| output | 写 stdout / stderr / exit_code 到 `adb-{step_id}.json`。 |
| success | exit_code 等于 expected_exit_code。 |
| failure | exit_code 不匹配、timeout、ADB offline。 |

`check_process`：

| 项 | 契约 |
|---|---|
| input | `process_name` |
| output | 写 process matched / not matched。 |
| failure | ADB offline 或命令执行失败。 |

`push`：

| 项 | 契约 |
|---|---|
| input | `src_ref`、`dst_path` |
| src | 必须是已登记 artifact / evidence ref。 |
| dst | P0 只允许绝对路径；危险路径由 constraints / policy 拦截。 |

`collect_logs`：

| item | 行为 |
|---|---|
| `dmesg` | 通过 adb shell 采集到 `dmesg.log`。 |
| `logcat` | 通过 adb logcat 采集到 `logcat.log`。 |
| `serial_last_window` | 从 serial ring buffer / serial.log 切窗口。 |
| `target_state` | 保存当前 runtime state snapshot。 |

如果 ADB 不可用，`collect_logs` 必须返回 `missing_items`，但仍保留可采集项。

### 6.6 EvidenceStore Adapter

`save_snapshot` 不是外部设备动作。

契约：

```text
读取当前 run state、target state、recent events、指定 evidence refs。
写 snapshots/{reason}.json 或 .log。
更新 evidence-index.json。
写 evidence_collected event。
```

## 7. 缺信息判断逻辑

### 7.1 同步请求校验

这些错误不创建 run：

| 情况 | 返回 |
|---|---|
| JSON 结构非法。 | `invalid_request` |
| `context.task` 缺失。 | `invalid_request` |
| `context.expected` 缺失。 | `invalid_request` |
| `artifact.path` 缺失或不可读。 | `artifact_invalid` |
| `artifact.type` 与 target flash 配置不匹配。 | `artifact_invalid` |
| target 不存在。 | `target_not_found` |
| target busy。 | `busy` / `target_busy` |
| constraints 要求的动作被 target safety 禁止。 | `invalid_request` |

### 7.2 Planning 缺信息

这些情况返回 `clarification_needed`，不执行设备动作：

| 情况 | missing_info | suggested_next |
|---|---|---|
| 任务需要主动验证，但没有 `test_hint`，也没有可观察 pass/fail。 | `context.test_hint.command` 或 `context.expected` | 提供 adb shell smoke command 或明确可观察行为。 |
| `test_hint.kind` 不是 P0 支持的 `adb_shell`。 | `context.test_hint.kind` | 改成 `adb_shell` 或暂时只做通用观察。 |
| `test_hint.kind=adb_shell` 但缺 command。 | `context.test_hint.command` | 提供命令。 |
| expected 太泛，例如“正常工作”，无法转成 success_criteria。 | `context.expected` | 描述可观察结果，例如 ADB online、进程存在、命令 exit 0。 |
| concerns / expected 指向能力缺失，例如要网络断连但 target 没有 network control。 | `target.capability` | 换 target、补能力或降低验证范围。 |
| confidence < 0.6。 | `context` | 补充 what_changed、expected、concerns 或 test_hint。 |

### 7.3 Plan 校验失败

这些情况返回 `plan_rejected`：

| 情况 | reason |
|---|---|
| Plan step capability 不存在。 | `unknown_capability` |
| capability 存在但 target 不可用。 | `capability_unavailable` |
| input 不符合 capability schema。 | `invalid_step_input` |
| timeout 超过 capability limit 或 run max duration。 | `timeout_exceeds_limit` |
| Plan 请求 constraints 禁止的动作。 | `constraint_violation` |
| Plan 包含连接参数、设备 id、串口端口。 | `planner_leaked_target_detail` |
| `condition` 不是 `always`、`on_failure`、`on_success`。 | `invalid_condition` |

如果 Plan 已落盘后被拒绝：

```text
run state = failed。
保留 request.json、intent.json、plan.json、rejection reason。
不执行任何 Tool Adapter。
```

## 8. P0 不补的内容

这些后续再补，不阻塞 Runtime-only：

| 内容 | 后置原因 |
|---|---|
| Prompt Registry | 只有接 LLM 后才需要。 |
| Prompt Assembler | Runtime-only 可用手写 Plan。 |
| LLM Output Parser | 先用结构化 mock / hand-written Plan。 |
| LLM retry / model fallback | P0 前 7 步不能依赖 LLM。 |
| 场景匹配算法细节 | 先把 Scenario Library 当参考输入，不做算法平台。 |
| Reply Generator prompt | P0 可以先规则摘要。 |

## 9. 收口

实现时先满足这 5 个问题：

```text
状态能不能合法推进？
Intent 能不能被硬校验？
Rule 命中能不能稳定写 Event / Evidence？
Adapter 能不能只执行已解析参数？
缺信息时能不能拒绝而不是硬猜？
```

这 5 个满足后，Runtime-only 才算可以开始写代码。
