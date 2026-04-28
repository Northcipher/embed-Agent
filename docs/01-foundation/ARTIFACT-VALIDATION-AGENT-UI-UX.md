# Artifact Validation Agent TUI / UE 设计

> 状态：Draft  
> 日期：2026-04-28  
> 目的：定义 Human 如何通过纯 TUI 发起、观察、理解和安全干预一次产物真机验证。  
> 关系：TUI 只展示 Runtime 状态，不保存独立状态；接口语义以 [ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md](ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md) 为准；技术选型见 [ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md](ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md)。

## 1. 核心判断

P0 UI 形态固定为：

```text
纯 TUI。
不做 Web。
不做 Electron / Tauri。
不做浏览器 Console。
```

P0 TUI 是一次验证的 Run Cockpit：

```text
发起一次 validation run
-> 看 target 当前是否可用
-> 看 run 正在做什么
-> 看事件时间线
-> 看关键 evidence
-> 必要时 pause / resume / cancel / add instruction
-> 结束后拿到 report 和 evidence 入口
```

第一版 TUI 成功标准：

```text
Human 不需要问 Coding Agent “现在怎么样了”。
Human 能在 30 秒内判断 run 卡在哪、有没有失败现场、下一步能做什么。
```

## 2. 设计原则

| 原则 | 含义 | 反例 |
|---|---|---|
| Runtime-state first | TUI 只展示 Runtime stores 的事实。 | TUI 自己推断 run 状态。 |
| Timeline 是主轴 | 一次验证按事件顺序理解，不按日志文件理解。 | 默认打开完整 serial.log 让人自己翻。 |
| Evidence 可回溯 | 每个判断都能看到 evidence ref / 文件路径。 | 只给一段 LLM summary。 |
| 干预必须受限 | 只能调用 `intervene_run` / `cancel_run` 允许动作。 | TUI 提供任意 shell 输入框。 |
| 不隐藏不确定性 | unknown / stale / partial 要明确显示。 | 用绿色“正常”掩盖状态未知。 |
| 单 run 优先 | 先把一个 run 讲清楚，再做历史和多 target。 | 一开始做 fleet dashboard。 |

## 3. 信息架构

P0 只做 5 个 TUI 视图。

| 视图 | 目的 | 数据来源 |
|---|---|---|
| New Validation | 发起一次验证。 | `get_target_capabilities`、`validate_artifact` |
| Run Cockpit | 运行中主视图。 | `get_run_status`、`watch_run`、`get_evidence` |
| Evidence View | 查看 evidence index 和关键 refs。 | `get_evidence` |
| Result View | 查看最终 Agent Reply / Report。 | `get_run_result`、`get_evidence` |
| Target View | 查看 target profile 摘要和 runtime state。 | `get_target_capabilities`、`get_run_status` |

P0 不做：

```text
多 target 调度看板。
用户权限系统。
历史趋势分析。
远端 evidence 浏览器。
任意命令终端。
完整日志搜索。
Web Console。
```

## 4. TUI 布局方向

视觉方向：工业控制室，但在终端里实现。

关键词：

```text
高对比
状态明确
证据优先
少装饰
键盘优先
```

配色语义：

| 状态 | 颜色语义 |
|---|---|
| running / active | cyan |
| waiting / collecting | amber |
| failed / fatal | red |
| completed | green |
| unknown / stale | gray |

TUI 不追求“网页感”，只追求快速判断。

## 5. 核心视图

### 5.1 New Validation

目的：

```text
让 Human 发起一次验证，同时提前暴露 target 是否可用、输入是否足够。
```

字段：

| 区块 | 字段 |
|---|---|
| Artifact | path、type、sha256 optional |
| Target | target id、runtime state、available capabilities |
| Context | task、what_changed、expected、concerns |
| Test Hint | kind、command、timeout_sec、expected_exit_code |
| Constraints | max_duration_sec、allow_flash、allow_reboot、allow_shell_exec、allow_power_cycle |
| Submit Result | accepted、busy、artifact_invalid、clarification_needed、plan_rejected |

交互规则：

```text
target busy 时，提交前提示或提交后明确返回 busy。
test_hint 为空时，提示“Planner 可能只做通用观察，不能编造 smoke command”。
allow_power_cycle 默认 off，P0 不提供开启入口。
危险约束必须显式显示，不隐藏在高级配置里。
```

### 5.2 Run Cockpit

这是 P0 TUI 主视图。

布局：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ run-001  running  board-01  +42s  seq=18       [p]ause [c]ancel [?]  │
├───────────────┬──────────────────────────────────────┬───────────────┤
│ Plan Steps    │ Event Timeline                       │ Target / Facts│
│               │                                      │               │
│ ✓ flash       │ +00 run_created                      │ state booting │
│ ▶ serial      │ +12 step_started watch_serial        │ serial active │
│ · wait_adb    │ +30 init service timeout             │ adb offline   │
│ · smoke       │ +42 kernel panic matched             │ heartbeat ok  │
│ · collect     │                                      │ partial true  │
├───────────────┴──────────────────────────────────────┴───────────────┤
│ Evidence: serial:last-200-lines  failure-snapshot  flash.log          │
└──────────────────────────────────────────────────────────────────────┘
```

顶部必须显示：

| 字段 | 说明 |
|---|---|
| run id | 可复制。 |
| run state | queued / planning / running / collecting_evidence / completed / failed / paused / cancelled。 |
| target id | 可跳 Target View。 |
| elapsed | 从 run start 计时。 |
| last event seq | 用于判断 TUI 是否跟上。 |
| stale / partial | 明确显示。 |
| actions | pause / resume / cancel / add instruction / refresh evidence。 |

### 5.3 Evidence View

目的：

```text
让 Human 快速知道已经采到了什么、关键证据在哪里。
```

展示：

| 区块 | 内容 |
|---|---|
| Evidence Index Summary | partial、updated_at、root_path。 |
| Key Events | seq、summary、evidence_refs。 |
| Refs | ref、kind、path、available、source_ref。 |
| Snapshots | failure snapshot、serial window、target state dump。 |
| Raw Files | flash.log、serial.log、dmesg.log、logcat.log。 |

规则：

```text
P0 不在 TUI 内渲染巨大日志。
P0 可以显示 path、tail window、metadata。
所有 summary 必须保留 evidence_refs。
partial=true 时顶部显示“运行中，证据仍在更新”。
```

### 5.4 Result View

必须展示：

| 字段 | 说明 |
|---|---|
| status | completed / failed / cancelled / running no result。 |
| summary | 一段短结论。 |
| confidence | 如果是 LLM 生成，显示 confidence；规则摘要显示 rule_based。 |
| key_evidence | 每条都带 evidence_refs。 |
| suggested_next | 建议下一步验证或排查方向。 |
| evidence_path / report_path | 可复制。 |

文案边界：

```text
可以说“serial 在 +42s 出现 kernel panic”。
不可以说“根因是某个代码提交”，除非 evidence 本身证明。
```

### 5.5 Target View

展示：

| 区块 | 内容 |
|---|---|
| Runtime State | idle / busy / flashing / booting / adb_ready / offline / unknown。 |
| Lock | current_run_id、locked_since。 |
| Connections | serial active/disconnected、adb online/offline。 |
| Capabilities | flash、watch_serial、wait_adb、shell_exec、collect_logs 等 available 状态。 |
| Safety | allow_flash、allow_reboot、allow_power_cycle。 |

P0 只读。

Target Profile 编辑可以后做。

## 6. 关键交互流

### 6.1 发起验证

```text
New Validation
-> Human 填 artifact / context / target / constraints
-> TUI 调 get_target_capabilities
-> TUI 提示 target busy 或能力缺失
-> Human submit
-> validate_artifact
-> accepted: 跳 Run Cockpit
-> rejected: 展示结构化原因
```

### 6.2 运行中观察

```text
Run Cockpit
-> 轮询 watch_run(after_seq)
-> 新事件进入 Timeline
-> 同步 get_run_status
-> 如果 evidence_refs 出现，刷新 Evidence strip
```

TUI 必须明确：

```text
last_event_seq
next_after_seq
是否 partial evidence
当前视图是否 stale
```

### 6.3 安全干预

允许动作：

```text
pause
resume
cancel
add_instruction
request_partial_evidence
```

TUI 控件：

| 动作 | 交互 |
|---|---|
| pause | 二次确认，说明不删除 evidence。 |
| resume | 仅 paused 状态可见。 |
| cancel | 强确认，说明保留 partial evidence。 |
| add_instruction | 只能写自然语言 instruction，不接受 shell。 |
| request_partial_evidence | 刷新 Evidence Index。 |

禁止：

```text
注入 shell command。
改 Plan。
改 constraints。
删除 evidence。
直接修改 target runtime state。
```

## 7. 状态显示规范

### 7.1 Run State

| state | TUI 文案 | 颜色语义 |
|---|---|---|
| queued | 等待本地 worker 开始 | neutral |
| planning | 正在生成或装载 Plan | amber |
| running | 正在执行 | active |
| collecting_evidence | 正在收集证据 | amber |
| completed | 验证完成 | success |
| failed | 验证失败 | error |
| paused | 已暂停 | warning |
| cancelled | 已取消 | neutral |

### 7.2 Target Runtime State

| state | TUI 文案 |
|---|---|
| idle | 可用 |
| busy | 被 run 占用 |
| flashing | 正在刷机 |
| booting | 正在启动 |
| adb_ready | ADB 可用 |
| offline | 离线 |
| unknown | 状态未知 |

`unknown` 不能显示成正常。

## 8. 文案规范

TUI 文案要具体，不要“智能分析中”。

推荐：

```text
正在等待 ADB，已等待 92 / 180 秒。
serial 42 秒处命中 kernel panic。
已保存 serial:last-200-lines。
target busy，当前 run 是 run-001。
```

避免：

```text
AI 正在思考。
设备状态良好。
出现未知问题。
自动修复中。
```

## 9. P0 实现切片

TUI 不应该先于 Runtime 复杂化。

| 顺序 | TUI 切片 | 依赖 |
|---:|---|---|
| 1 | Run Cockpit 静态 fixture | mock `get_run_status` / `watch_run`。 |
| 2 | Evidence View 静态 fixture | mock `get_evidence`。 |
| 3 | New Validation 表单 | `validate_artifact` skeleton。 |
| 4 | 轮询 Timeline | `watch_run(after_seq)`。 |
| 5 | 干预按钮 | `intervene_run` / `cancel_run`。 |
| 6 | Result View | `get_run_result`。 |
| 7 | Target View | `get_target_capabilities`。 |

P0 最小可用：

```text
New Validation
+ Run Cockpit
+ Evidence View
+ Result View
```

Target View 可以先做成 Run Cockpit 右侧卡片。

## 10. 验收标准

TUI/UE 验收不用看视图数量，看能否回答问题：

| 问题 | 必须能回答 |
|---|---|
| 这个 run 现在在哪一步？ | Run Cockpit 顶部和 Plan Steps。 |
| target 此刻是什么状态？ | Target card。 |
| 最新异常是什么？ | Timeline 高亮事件。 |
| 失败证据在哪里？ | Evidence strip / Evidence View。 |
| 这个结论有没有证据？ | Result View 的 key_evidence refs。 |
| Human 可以安全做什么？ | 受限 intervention controls。 |
| TUI 数据是不是过期？ | last_event_seq / stale 状态。 |

## 11. 收口

TUI 的核心不是“做一个好看的终端界面”。

核心是：

```text
把一次真实设备验证讲清楚。
把 Runtime 状态讲清楚。
把失败现场讲清楚。
把 Human 可做动作限制清楚。
```

只要 TUI 开始绕过 Runtime、隐藏 evidence、提供任意命令入口，就偏离产品方向。
