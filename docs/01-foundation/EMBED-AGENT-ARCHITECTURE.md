# Embed Agent 架构文档

> 状态：Draft
> 日期：2026-04-29

## 1. 本质

不是造 agent。是把工程师盯设备的重复劳动自动化。

```
工程师做的事                          系统做的事
─────────────────────────────────────────────────────
刷机                                 flash
盯串口，grep 关键词                   stream + Rule Detector 逐行检测
看趋势，watch -n                       Aggregator 周期采样 + 趋势对比
翻多个源的日志，找关联                 Aggregator 跨源关联
推理因果链                            Observer(LLM) 分析 Signal 序列
和历史对比                            Aggregator 对比 Memory.RunProfile baseline
主动查系统状态 (ps/top/df)            Aggregator 主动采样
记住这次经验，下次避开坑               Memory 存 Episode + RunProfile
```

**核心价值不是"会盯串口的 agent"。是 grep 做不了的事——时序分析、跨源关联、因果推断、基线对比、主动采样。**

---

## 2. 两层分工

```
做什么   = 人每次说（validate 命令，一句话描述验证目标）
怎么做   = 人一次配好（Target Profile + LLM Config + System Config + Skill）
怎么判断 = Agent 自己（六层 Observation + Planner + Observer + Memory）
怎么调度 = Runtime 组装上下文 → Agent 决策 → Runtime 执行
```

---

## 3. 架构原则

| 原则 | 含义 |
|-----|------|
| Event-first | 所有事实先变成 Event。Event 驱动状态、决策、视图。 |
| 决策分层 | 确定性(fatal)毫秒级反射，不确定(warning)走 Observer LLM，人覆盖最高。 |
| 观测六层 | grep → 时序 → 跨源关联 → 因果 → 基线 → 采样。前一到三层不走 LLM。 |
| 模型分层 | 高频用弱模型(Observer)，低频用强模型(Planner/Reply)。 |
| LLM 是提取器 | 从 Event 和 Evidence 提取关键信息。原始证据永远第一，LLM 在旁边。 |
| Tool 只管执行 | 连接设备 → 执行动作 → 写输出。不决策，不调 LLM。 |
| Connection 是接口 | exec/stream/push/flash。6 种实现，1 套 OutputPipe。 |
| 触发多样 | Manual / Cron / Event / Continuous。 |
| Interface 不持状态 | CLI/MCP/TUI 只发 Command、只读 View。 |
| 配置一次复用 | Agent 不直接读 Config。Runtime 组装 Context 后传给 Agent。 |
| 重启诚实 | 不确定就标失败，不装还在跑。 |
| 环境诚实 | Run 前 Pre-flight 检查连接；Run 后清理；脏了恢复。 |
| 失败可追溯 | 每次重试保留证据。上限到了写清原因。 |
| Memory 是公民 | Working Memory / Episode / SemanticFact / RunProfile。从第一天预留。 |

---

## 4. 架构总图

```mermaid
flowchart TD
    subgraph Config["配置层（人一次配好）"]
        TP["Target Profile"]
        LC["LLM Config"]
        SC["System Config<br/>含 RulePolicy"]
        SK["Skill"]
    end

    subgraph Interface["Interface Layer"]
        CLI["CLI"]
        MCP["MCP Server"]
        TUI["TUI"]
    end

    CLI --> CH["Command Handler"]
    MCP --> CH
    TUI --> CH

    subgraph Trigger["触发层"]
        MANUAL["Manual"]
        CRON["Cron Scheduler"]
        EVENT_TRIG["Event Watcher"]
        CONT["Continuous"]
    end

    subgraph Runtime["Runtime Engine"]
        TM["Task Manager<br/>调度触发器"]
        CRON --> TM
        EVENT_TRIG --> TM
        CONT --> TM
        TM --> RM["Run Manager"]
        CH -->|"人工命令(validate/pause/...)"| RM
        CH -->|"任务管理(task create/ls/...)"| TM
        RM --> SQ["Step Queue"]
        SQ --> SE["Step Executor"]
        RM --> DH["Decision Handler"]
        EB["Event Bus"]
        AS["Context Assembler"]
        HM["HookManager<br/>生命周期Hook"]
        RM --> EB
        SE --> EB
        DH --> EB
        RM --> HM
        SE --> HM
        DH --> HM
    end

    TP --> AS
    SC --> AS
    LC --> AS
    RM -->|"1.组装Context"| AS
    AS -->|"2. StaticPrompt+DynamicContext"| Planner
    AS -->|"StaticPrompt+ObserverInput"| Observer

    subgraph Tool["Tool Layer"]
        TG["Target Manager<br/>Pre-flight + 恢复 + 状态"]
        CM["Connection Manager"]
        C["Connection<br/>exec/stream/push/flash"]
        L["Local"]
        S["Serial"]
        A["ADB"]
        F["Fastboot"]
        SSH_C["SSH"]
        OP["OutputPipe<br/>行拼接 + Evidence + ring buffer<br/>+ Rule feed + Aggregator feed"]
        RD["Rule Detector<br/>精确匹配 / silence / exit_code<br/>/ timeout / connectivity"]
        AG["Aggregator<br/>阶段识别 / 输出模式 / 跨源关联<br/>基线对比 / 主动采样"]
    end

    RM -->|"Pre-flight (Run admission)"| TG
    SE -->|"获取Connection"| CM
    TG --> CM
    CM --> C
    C --> L & S & A & F & SSH_C
    SE --> OP
    OP --> RD
    OP --> AG
    AG -.->|"读其他源窗口"| EVS
    AG -.->|"读ring buffer窗口"| OP
    AG -.->|"读RunProfile(baseline)"| MS
    RD -->|"RuleMatched"| EB
    AG -->|"Checkpoint/Correlated/BaselineDiff"| EB
    TG -->|"TargetStateChanged"| EB
    EB -->|"RuleMatched/Checkpoint/Correlated/BaselineDiff (订阅)"| DH

    subgraph Agent["Agent Layer"]
        Planner["Planner<br/>强模型 1次/Run<br/>AssembledContext → Plan"]
        Observer["Observer<br/>弱模型 高频<br/>Signal序列 → Decision"]
        Reply["Reply Generator<br/>强模型 1次/Run<br/>提取关键信息"]
        MEM["Memory<br/>WM/Episode/Fact/Profile"]
        SR["Skill Registry"]
    end

    RM -->|"3.直接调用"| Planner
    Planner -->|"PlanGenerated"| EB
    Planner --> SR
    Planner --> MEM
    DH -->|"直接调用(warning时)"| Observer
    Observer -->|"DecisionMade/Suggestion"| EB
    Observer --> MEM
    Observer -->|"DecisionMade"| EB
    Note over DH,EB: DH 不订阅 DecisionMade。<br/>Observer Decision 由 DH 直接调用返回。<br/>Human Decision 由 RM 直接执行。<br/>DecisionMade 只走 EB→Store 审计。
    RM -->|"直接调用"| Reply
    Reply -->|"result_ready"| EB
    Reply --> MEM
    SK --> SR

    subgraph Notify["通知"]
        SL["Slack"]
        EM["Email"]
    end
    EB -->|"result_ready/target_state_changed/suggestion_generated (订阅)"| NF["Notification Filter<br/>Event→语义分类映射"]
    NF --> SL
    NF --> EM

    subgraph Store["Store Layer"]
        ES["Event Store"]
        EVS["Evidence Store + Index"]
        RS["Run Store"]
        TS["Target Store"]
        MS["Memory Store"]
        SS["Skill Store"]
    end

    EB -->|订阅| ES
    OP --> EVS
    RM --> RS
    TG --> TS
    MEM --> MS
    SR --> SS

    subgraph View["View Layer"]
        RV["Run View"]
        TV["Target View"]
        EV["Evidence View"]
    end

    ES --> View
    EVS --> View
    RS --> View
    TS --> View
    View --> Interface
```

---

## 5. 配置层

### 5.1 Target Profile

```yaml
target_id: board-01
display_name: "高通 S820 开发板 #1"

connections:
  serial: { port: /dev/ttyUSB0, baud: 115200 }
  adb: { device_id: "ABC123" }
  fastboot: { device_id: "ABC123" }
  ssh: { host: "...", port: 22 }

flash:
  method: fastboot
  artifact_type: firmware_img

recovery:
  reboot_method: adb                 # adb | fastboot | custom_command
  stable_artifact: "/builds/stable/boot.img"   # 可选。没有就只重启

safety:
  allow_flash: true
  allow_reboot: true
  allow_shell_exec: true
  allow_power_cycle: false

target_hints:
  boot_markers: ["Booting Linux", "init started", "boot completed"]
  boot_sequence:
    # expected_duration 是软指标（baseline 参考值），不是硬超时。
    # Aggregator 用于基线对比（实际耗时 vs expected）。
    # Step 的硬超时由 Step.timeout 控制，不受 expected_duration 影响。
    - { stage: bootloader, expected_duration: 5 }
    - { stage: kernel, expected_duration: 15 }
    - { stage: init, expected_duration: 30 }
    - { stage: adb_ready, expected_duration: 150 }
  fail_patterns: ["qcom_smd: timeout"]
  known_quirks: ["dmesg 中 'foo error' 已知无害"]
  recommended_checks: ["/vendor/bin/smoke_test"]

skills: [pre-flash-check.yml]
```

### 5.2 LLM Config

```yaml
default_provider: anthropic
providers:
  anthropic:
    models:
      planner: "claude-sonnet-4-6"
      observer: "claude-haiku-4-5"
      reply: "claude-sonnet-4-6"
    timeout: { planner: 60, observer: 30, reply: 60 }
observer:
  debounce_sec: 30
  max_concurrent_per_run: 1
  default_checkpoint_interval: 300
```

### 5.3 System Config

```yaml
runtime:
  data_root: .embed-agent
  max_run_duration_sec: 86400

thresholds:
  serial_silence_sec: 60
  flash_timeout_sec: 300
  wait_adb_timeout_sec: 180

rule_policy:
  fatal:
    - rule: kernel_panic
    - rule: kernel_oops
    - rule: flash_failed
    - rule: serial_disconnected
  warning: "*"

retry:
  max_retries: 3
  intervals: [2, 5, 10]
  retryable: [flash_failed, adb_timeout, serial_open_failed, llm_timeout]

ring_buffer:
  max_lines: 500
  window_before: 200
  window_after: 80

aggregator:
  cross_source_time_window_sec: 5
  output_patterns:
    silence: "output rate = 0 且连接正常"
    burst: "output rate > 3x baseline"
    oscillation: "output rate 在高低间反复波动 >= 3 次"
    gradual_decline: "output rate 在 5 个连续 checkpoint 中持续下降"
    stable: "output rate 波动 < 20%"

storage:
  evidence_retention: { success_days: 30, failure_days: 90 }
  max_total_bytes: 107374182400

notifications:
  slack:
    enabled: true
    webhook_url_env: SLACK_WEBHOOK_URL
    on: [run_result, target_offline, target_offline_long, memory_suggestion]
  email:
    enabled: false

security:
  allowed_shell_commands:
    - "/vendor/bin/*"
    - "dmesg"
    - "logcat -d"
    - "cat /proc/*"
    - "ps"
    - "top -n 1"
  blocked_push_paths: ["/system/*", "/boot/*", "/data/data/*"]
```

---

## 6. Capability 推断

**本质：** Capability 不是人在 Target Profile 里逐条配置的。是从"怎么连、怎么刷"自动推断出来的。

**为什么：** 人只配连接事实（串口在哪、ADB 设备 ID、刷机方式）。系统自己推断能用什么能力。减少配置负担，避免不一致。

**怎么做：**

```
推断规则（固定，不改）：

有 connections.serial       → watch_serial, collect_logs(serial_last_window)
有 connections.adb          → wait_adb, shell_exec, check_process,
                              collect_logs(dmesg/logcat), push
有 connections.fastboot     → flash (method)
有 connections.ssh          → shell_exec, collect_logs, push
有 flash.method             → flash
没有 connections 但有 exec  → 只有 Local (shell_exec 本地命令)

推断出的 capabilities 要同时满足 safety 约束:
  - shell_exec: connections 存在 AND safety.allow_shell_exec = true
  - flash: connections 存在 AND safety.allow_flash = true
  如果 connections 存在但 safety 禁止 → capability.available = false

Planner 只看到 available=true 的能力。
如果所需能力不存在或 safety 禁止 → Plan 标记 capability_missing → 返回给调用方。
```

---

## 7. Prompt 组装与缓存

**本质：** 借鉴 Claude Code 的模式。System Prompt = 静态可缓存。User Message = 动态 per-Run。

**为什么：** LLM API 的 prompt cache 在 system prompt 侧。静态内容缓存命中 → 延迟和成本大幅下降。如果易变上下文（Request、Memory、Target hints）放在 system prompt → 每次都破坏缓存 → 成本翻倍。

**怎么做：**

```
ContextAssembler 产出两部分:

1. StaticPrompt（静态, Run 间不变, cacheable）:
   - Planner/ Observer/ Reply 各自的 system prompt
   - 身份定义、能力目录(Capability Catalog)、输出格式(JSON Schema)、决策规则
   - 只在系统升级或 Skill 变化时变

2. DynamicContext（动态, per-Run, 不缓存）:
   - Request: 人的描述 (task, expected, concerns, test_hint)
   - Target: 能力列表、hints、boot_markers、known_quirks
   - Memory: 最近 Episodes、Semantic Facts、known_issue_patterns
   - Constraints: 本次 Run 限制 (max_duration, safety)
   - Matched Skills: 匹配到的 Skill 摘要（name+description，非完整内容）

组装后的消息序列:
  [System]     StaticPrompt         ← 命中 cache
  [User]       <system-reminder>    ← 动态上下文
                 # Request / # Target / # Memory / # Constraints
               </system-reminder>
  [User]       "请生成验证 Plan"     ← 真正指令

Memory + Request + Target hints 全在 user message 侧 → system prompt 稳定 → cache 持续命中。
```

**Skill 渐进加载（三级）：**

```
Tier 1: 系统 prompt 里只包含 Skill 的 name + category + description。
        用于 Planner 匹配。不包含完整 steps。省 token。
Tier 2: Planner 选定 Skill 后，DynamicContext 里附带该 Skill 的 steps + evidence_policy。
Tier 3: Skill 引用外部脚本/模板 → Planner 生成 Step 时按需加载。
```

**Observer 的 prompt 同样分层：**

```
StaticPrompt:   "你是 Embed Agent 的 Observer。决策规则: ..." + Decision JSON Schema
User Message:   <system-reminder> 包含当前 Signal + evidence window + Memory + 约束

Observer 每 event 调一次 → system prompt 完全 static → 每次都命中 cache。
只有 Signal + window 在 user message 侧变化。
```

---

## 8. Circuit Breaker（熔断）

**本质：** 借鉴 Claude Code（连续拒绝计数）和 OpenCode（doom loop 检测）。在系统自动决策失效时，降级到人工接管，不让系统在无人值守时反复犯错。

**为什么：** Observer 可能误判、LLM 可能超时、Step 可能因为硬件问题反复失败。没有熔断 → 系统在无人值守时无限重试、反复调用 LLM、浪费资源且不通知人。

**4 个熔断器：**

```
1. Observer 覆盖计数器
   触发: Observer Decision(stop) 被 Human override 记为 1 次。
   阈值: 同 Run 内连续 3 次。
   动作: 标记 "自动决策失效"。后续 Observer 只出 suggest，不再出 stop。
         人仍可手动 pause/cancel。
   重置: 本 Run 不会重置。下次 Run 重新计数。

2. Step 重试同因计数器
   触发: Step 重试时，失败类型和上次相同。
   阈值: 同 Step 内连续 3 次同一类型失败。
   动作: 标记 "possible_hardware_issue"。停止重试。Run → failed。
         通知人（target_offline 或 run_failure）。
   例子: flash failed 3 次（都因为 USB 超时）→ 可能是硬件问题。

3. Warning 累加器
   触发: rule_matched(severity=warning)。不同 rule_id 各记 1 次。
         silence 60s、exit_code 非预期、ADB 短暂离线...
   阈值: Run 内累计 5 个不同 warning。
   动作: 升格为 "建议 stop"。Observer 给出 suggest(recommend_stop)。
         不自动 stop——因为 warning 不算 fatal。等人判断。
   重置: 每 Run 独立。

4. LLM 降级器
   触发: Planner / Observer / Reply 调用 LLM 超时或失败。
   阈值: 同角色连续 3 次失败。
   动作: 该角色切到 fallback 模式，不再调用 LLM。
         Planner → 默认 Plan 模板。
         Observer → 纯规则决策（fatal→stop, warning→continue）。
         Reply → 规则摘要。
   重置: Runtime 重启后恢复。
```

**熔断器放在哪：**

```
Decision Handler 内部:
  - Observer 覆盖计数器（每次 override_decision 触发时 +1）
  - Warning 累加器（每次 rule_matched(warning) 触发时 +1）

Step Executor 内部:
  - Step 重试同因计数器（每次重试时比较上次失败原因）

LLM Call Manager（Agent 层的 LLM 调用封装）:
  - LLM 降级器（每次 LLM 调用失败时 +1，成功时重置）
```

**不做全局熔断器：** 每个熔断器独立运行。不共享状态。不相互影响。符合高内聚。

---

## 9. Hook 系统

**本质：** 借鉴 Claude Code 的 Hook 模式。在生命周期事件点执行用户自定义脚本。不进核心逻辑。不阻塞主流程。

**为什么：** 不给 Runtime 代码加扩展点 → 团队的自定义需求（额外日志、自定义通知、pre-check）都要改 Runtime → 无法升级。

**事件点（8 个）：**

```
Run 生命周期:
  PreRunStart      Run 创建后, Planning 之前
  PostRunEnd       Run 结束后 (completed/failed/cancelled)

Step 生命周期:
  PreStepExecute   Step 执行前 (可以 block 危险操作)
  PostStepComplete Step 成功后
  PostStepFailed   Step 失败后

Decision 生命周期:
  OnStopDecision   Decision(stop) 执行前 (可 block 或要求补采)
  OnFinalizing     Run → finalizing, Reply 生成前 (补采额外证据的最后窗口)

System 生命周期:
  RuntimeStart     Runtime 启动时
```

**Hook 配置：**

```yaml
# configs/hooks.yml
hooks:
  - name: "pre-flash-check"
    on: PreStepExecute
    match: { capability: "flash" }
    command: "./scripts/pre-flash-check.sh"
    timeout: 30

  - name: "notify-on-failure"
    on: PostRunEnd
    match: { state: "failed" }
    command: "./scripts/notify-failure.sh {{run_id}}"
    timeout: 10
```

**Hook 输出协议（按事件点限制返回值）：**

| Hook 点 | 允许返回值 | 语义 |
|---------|-----------|------|
| PreStepExecute | proceed/block/retry | block→Run paused; retry→重试 |
| OnStopDecision | proceed/block | block→不进 finalizing, 等人 |
| OnFinalizing | proceed | 只做补采, 不改变流程 |
| PreRunStart/PostRunEnd | proceed | 只做附加操作 |
| PostStepComplete/Failed | proceed | 只做通知/记录 |
| RuntimeStart | proceed | 只做环境检查 |

```
// stdout JSON (可选)
{ "decision": "proceed" | "block" | "retry",
  "reason": "...",
  "additionalContext": "..." }

没有 stdout 或非法 JSON → 视为 proceed。
返回 hook 点不支持的 decision → 忽略。视为 proceed。
```

**HookManager（Runtime 层的新组件）：**

```
职责:
  - 启动时加载 hooks.yml
  - 在事件点由 RM/SE/DH 调用
  - spawn 子进程执行 hook command
  - 读 stdout → 解析 JSON → 返回 { decision, reason, context }
  - 发 HookExecuted Event（审计）
  - hook 超时/失败 → 记录警告。不阻塞主流程。

不做什么:
  - 不修改 Run 状态（调用方决定）
  - 不调 LLM
```

---

## 10. Step Queue 和 Step 数据结构

### Step Queue

**本质：** Run Manager（生产 Step）和 Step Executor（消费 Step）之间的共享有序队列。

**为什么：** 不混在 Run Manager 或 Step Executor 内部。Step 的生产者和消费者不同——
- Run Manager 创建初始 Step（Plan 的 steps）。此时 Target 锁已在 planning 阶段获取。
- Decision Handler 追加 Step（collect_more）
- Decision Handler 清空 Step（stop/cancel）
- Step Executor 只取 Step 执行

Target 锁从 planning 持续到 cleaning→idle。收集证据和清理期间，同一 Target 不会被其他 Run 占用。
一个独立队列让所有权清晰：谁加、谁取、谁清。

### Step 数据结构

**本质：** 一个设备动作的完整描述。不是命令字符串。包含执行方式、超时、观测配置、失败策略。

```
Step {
  id: string                      // "step-1"
  action: "exec"|"stream"|"push"|"flash"
  capability: string              // "shell_exec"|"wait_adb"|"collect_logs"|...

  // action 决定执行方式（怎么调 Connection）
  // capability 决定是什么操作（是否被 safety 允许、是否在 Capability Registry 中）
  // 例如 { action: "exec", capability: "shell_exec" } vs
  //      { action: "exec", capability: "collect_logs" }
  // Plan 校验时同时检查 action + capability，不是只看 action。

  // exec/push/flash 用
  command?: string                // "dmesg" / "/vendor/bin/smoke_test"
                                  // 不包含连接参数。Connection 补全。
  image?: string                  // flash 用
  partition?: string              // flash 用
  src?: string                    // push 用
  dst?: string                    // push 用

  timeout: number                 // 单步超时(秒)

  // 流式观测（仅 stream Step。exec/push/flash 不适用）
  observe?: {
    interval: number              // 秒。checkpoint 间隔。默认 300
    metrics: string[]             // ["memory", "cpu", "latency"]
    trend_window: number          // 对比最近 N 个 checkpoint。默认 3
    sampling_commands: string[]   // ["cat /proc/meminfo", "ps"]
  }

  // 执行策略
  condition: "always"|"on_failure"|"on_success"   // always=主路径
  on_failure: "stop"|"continue"|"collect_and_stop"
  retry_policy?: {                // 覆盖 system config
    max_retries: number
    intervals: number[]
  }
}
```

---

## 11. OutputPipe 和 Ring Buffer

### OutputPipe

**本质：** 所有 Connection 输出的统一处理入口。不强依赖 Connection 类型。

**为什么：** Serial 是 stream（持续流），ADB/SSH/Local 是 exec（一次性返回）。处理逻辑不同，
但 Step Executor 不应该知道这些差异。

**怎么做：**

```
Step Executor 根据 step.action 选择调用方式:

  stream (Serial):
    for await (const chunk of connection.stream(timeout)) {
      outputPipe.feedStream(chunk)
    }

  exec (ADB/SSH/Local):
    const { stdout, stderr, exitCode } = await connection.exec(command, timeout)
    outputPipe.feedExec(stdout, stderr, exitCode)

OutputPipe 内部:

  feedStream(chunk):
    → 拼完整行 (buffer += chunk; lines = split("\n"); buffer = last partial line)
    → 逐行: evidenceWriter.append(line)       ← 写原始文件(stream append)
            evidenceIndex.update(run_id)        ← 更新索引(当文件达到阈值时)
            ruleDetector.detect(line)
            aggregator.feed(line)
            ringBuffer.push(line)
    → 每 100 行: eventBus.emit(observation)
    → 每次 feed: silenceTimer.reset()

  feedExec(stdout, stderr, exitCode):
    → 逐行处理 stdout + stderr (同 feedStream 的逐行逻辑)
    → ruleDetector.checkExitCode(exitCode)
    → eventBus.emit(observation)
    → (不维护 ring buffer、不重置 silence timer、不触发 aggregator 持续采样)
    → Step 完成后: Aggregator 处理 exec 输出 → 跨源关联 + 指标统计
```

### Ring Buffer

**本质：** 串口输出的滑动窗口。保留最近 N 行，命中时切窗口保存。

**为什么：** 不保留全量最近输出的话，Rule 命中时需要上下文只能回去翻 serial.log——慢、且可能已经被写入覆盖。ring buffer 解决了"命中时前后文在哪"的问题。

**怎么做：**

```
大小: ring_buffer.max_lines (默认 500 行)
实现: 定长循环数组。新行覆盖最旧行。

权衡: 500 行在 500 lines/sec 的高速输出下只保留 1 秒上下文。
      可调大。适合大部分 boot 场景（输出速率 50-100 lines/sec，保留 5-10 秒）。
      高速输出场景建议增大 max_lines 到 2000+。
      窗口切取前 200 行在低速时够用，高速时可配。

命中时切窗口 (RuleDetector):
  1. 记录命中行在 ring buffer 中的位置
  2. 取命中前 window_before 行(默认 200) + 命中行 + 命中后 window_after 行(默认 80)
  3. 写到 snapshots/serial-last-280-lines.log
  4. 更新 evidence-index.json
  5. RuleMatched Event 的 evidence_refs 带上这个 ref

注意: ring buffer 只用于 stream 模式。exec 模式不需要。
```

---

## 12. Rule Detector

### 9.1 精确匹配

**本质：** grep。逐行正则匹配。

**Pattern 来源与加载时机：**

```
系统默认 (代码内置):              kernel_panic, kernel_oops
                                  → 编译时确定，永远生效

Target Profile (fail_patterns):   qcom_smd: timeout
                                  → Run 开始时从 Target Profile 加载

Plan 指定 (step.input.watch):    本次关注的 pattern
                                  → Step 开始时从 Plan 加载

Memory (known_issue 变体):        "foo: error reading * config file"
                                  → 人确认 SemanticFact(verified=true) → 持久化到 Memory Store
                                  → 下次 Run 开始时 ContextAssembler 从 Memory Store 读取，
                                    提取 extended_pattern → AssembledContext.known_issue_patterns
                                  → RuleDetector 在 Run 初始化时一次性加载。不热更新。
```

### 9.2 语义变体

**本质：** 不是 Rule Detector 做语义匹配。Rule Detector 只做精确正则。

**为什么：** Rule Detector 是确定性检测，不应引入语义模糊性。

**怎么做：**

```
语义变体分两步:

1. 人确认 known_issue → Memory 自动生成宽泛正则
   "dmesg 中 'foo: error reading config file' 已知无害"
   → Memory 提取 "foo: error reading * config file" → 存为 pattern
   → 存到 Memory Store (verified SemantiFact 带上 extended_pattern 字段)

   不直接从 Memory 通知 RuleDetector（违反 Agent→Tool 禁止）。
   加载路径:
   Run 开始时 ContextAssembler 读 Memory Store 中 verified=true 的 SemanticFact
   → 提取 extended_pattern → 放入 AssembledContext.known_issue_patterns
   → RuleDetector 在 Run 开始时一次性加载（不热更新）

2. Observer 判断时查 Memory
   RuleDetector 命中 pattern → Observer 触发了
   → Observer 查 Memory known_issues: "有没有类似的？"
   → 如果命中 pattern 和已知 known_issue 语义相似 (LLM 判断)
   → Decision(continue)，reason: "匹配 known_issue: foo error 变体"
```

### 9.3 fatal vs warning

**本质：** RulePolicy 配置决定。不在代码里写死。

**为什么：** 什么算 fatal、什么算 warning 是运维决策。内核工程师可能觉得某个 panic 是已知问题，想降级为 warning。RulePolicy 放在 System Config 里，改配置不用改代码。

**severity 谁填：** Rule Detector 发布 Event 前查 RulePolicy 决定 severity 并填入 RuleMatched Event。RulePolicy 是静态配置映射表（`"kernel_panic" → fatal`），Rule Detector 在 Run 开始时加载到内存。查表是确定性操作，不算"决策"。Event 发布出去时 severity 已经确定，Store 持久化的是完整事件，Observer/通知等所有订阅者看到一致的数据。

Decision Handler 的职责不变：收到 RuleMatched 后根据 severity 决定走快速反射(fatal)还是调 Observer(warning)。

---

## 13. Aggregator

### 10.1 阶段识别

**本质：** 从串口输出中识别 boot 到了哪个阶段。

**为什么：** "init 阶段没有输出" 和 "stable 阶段没有输出" 含义完全不同。阶段给 Observer 提供上下文。

**怎么做：**

```
Aggregator 在 stream 模式下，维护当前阶段。

阶段切换: 输出行匹配 Target Profile 的 boot_markers:
  "Booting Linux"   → stage = bootloader
  "init started"    → stage = init
  "boot completed"  → stage = system_ready

每阶段统计:
  - 阶段耗时 (从进入该阶段到离开)
  - 阶段内输出行数
  - 阶段内 rule_hit 数和类型
  - 阶段内输出速率 (lines/sec)

如果 Target Profile 没配 boot_markers → 阶段 = "unknown"。
  不产出 StageTransition Signal。Observer 仍可用其他 Signal 分析。

阶段切换时: 产出 StageTransition Signal
  { from: "kernel", to: "init", duration: 12.8s, baseline: 13.1s, diff: -2% }
```

### 10.2 输出模式

**本质：** 输出速率不是稳定不变的。模式变化本身是信号。

**怎么做：**

```
每个 checkpoint 计算当前输出速率 (lines/sec)。
对比 baseline (上几个窗口的速率)。

模式判定 (阈值在 System Config):
  silence:          rate = 0 且连接正常
  burst:            rate > 3x baseline
  oscillation:      rate 在高低间反复 >= 3 次
  gradual_decline:  rate 在 5 个连续 checkpoint 中持续下降
  stable:           rate 波动 < 20%

模式变化 → 写入 checkpoint Event → Observer 分析。
```

### 10.3 跨源关联

**本质：** 同一时间窗口内，不同源 (serial + dmesg + logcat) 指向同一实体 (进程名/PID/关键词)，合并为一个 CorrelatedEvent。

**为什么：** 单独一个源的 "foo_service error" 可能是 warning。三个源同时指向 foo_service → 很可能是 fatal。grep 做不到跨源关联。

**怎么做：**

```
触发: exec Step (dmesg/logcat) 执行完成

流程:
  1. 读当前 Step 的 exec 结果 (来自 Evidence Store)
  2. 提取实体: 正则匹配输出行中的进程名(通常空格分隔第3个token)、PID
  3. 在同一 time_window (默认 ±5s) 内，查其他源的 Evidence:
     - stream Step 进行中 → 从 OutputPipe 的 ring buffer 读窗口
     - 上一个 exec Step → 从 Evidence Store 读
  4. 同实体出现 → 聚合为 CorrelatedEvent:
     {
       entity: "foo_service",
       sources: ["serial:342", "dmesg:89", "logcat:156"],
       confidence: "high",          // 3源+PID → high, 2源+进程名 → medium
       summary: "foo_service crash 被 3 个源同时检测到"
     }
  5. confidence → severity 映射（Aggregator 发布前填充，确定性规则，不走 LLM）:
     confidence=high   → severity=fatal
     confidence=medium → severity=warning
     来源数量取决于 Target 的 connections 数量（有的 Target 只有 2 源，最多到 medium）。
     Event 发布时 severity 已完整。不延迟到 Decision Handler。

注意: 跨源关联只在 exec Step 完成后触发。stream Step 进行中不触发。
```

### 10.4 基线对比

**本质：** 当前 Run 的指标和历史上同 Target 的成功 RunProfile 对比。偏离 → BaselineDiff Signal。

**怎么做：**

```
Aggregator 内部维护当前 Run 的实时指标。

取 baseline: Aggregator 直接读 Memory Store 中同 Target 最近一次成功 Run
            的 RunProfile（或历史 RunProfile 的统计平均）。
            Aggregator(Tool) → Memory Store(Store): 这是 Tool→Store 的读路径，
            不走 Agent。不违反禁止交互。

对比项: stage_durations(每阶段耗时)、final_metrics(内存/CPU/...)

偏离阈值: > 20% → BaselineDiff Signal(warning), > 50% → (fatal)
  severity=fatal → Decision Handler 直接走快速反射 stop。不进 Observer。
```

### 10.5 主动采样

**本质：** 不依赖日志输出。主动查询系统状态。

**为什么：** 很多问题不会出现在日志里。内存泄漏只在 /proc/meminfo 或 /proc/slabinfo 里看得出来。

**怎么做：**

```
主动采样不绕过 Step Executor。Aggregator 不能直接调 Connection.exec()——
那会绕过超时/重试/证据归属/并发控制。

采样走 Step 模型:
  当前 Step 有 observe.sampling_commands 时，
  Step Executor 在每个 checkpoint_interval 触发时:
    1. 暂停当前 Step 的输出处理（stream 暂停读取，exec 不适用）
    2. 对每条采样命令: 创建一个采样子动作（sub-action）
       （子动作: exec cat /proc/meminfo, timeout 10s）
       - 不进 Step Queue。不分配 step_id。属于当前 Step 内的嵌套操作。
    3. Step Executor 执行子动作:
       → Connection.exec(command, timeout)
       → OutputPipe.feedExec(stdout, stderr, exitCode)
       → evidence 归属于当前 Step
    4. Aggregator 从子动作产出的 observation Event 中提取 metrics

  示例:
    Step Executor 执行 "cat /proc/meminfo | grep MemAvailable"
    → OutputPipe.feedExec 处理输出
    → Aggregator 从 Evidence 中提取数值 → metrics.mem_available_mb = 120

好处:
  - 不污染 Step Queue。不引入未定义的 Step 生命周期。
  - 采样子动作走 OutputPipe（evidence + rule detection），归属当前 Step
  - Step Executor 统一仲裁：采样和主 Step 不会并发打到同一 Target
```

---

## 14. Planner

**本质：** 用强模型，一次 Run 调一次。把人的自然语言描述 + 组装好的 Context 转成结构化 Plan。

**为什么是 Run Manager 直接调用而非 Event Bus 订阅：**

```
Planner 是同步依赖。Run 必须等 Plan 生成了才能开始执行。
如果用 Event Bus: RunStarted → Planner 订阅 → PlanGenerated → RunManager 订阅
  → 异步解耦了，但 RunManager 必须等 Plan。多了一层不必要的间接。

正确方式:
  Run Manager 创建 Run → 调 ContextAssembler → 调 Planner.call(context)
  → 拿到 Plan → 校验 → 推进 Run 状态 → 发 PlanGenerated Event

不是所有通信都要走 Event Bus。同步依赖走直接调用。
```

**默认 Plan 模板 (fallback):**

```
LLM 失败或 confidence < 0.6 时使用:

{
  // 默认模板假设 Target 有 flash + serial + adb。
  // 如果 Target 缺少某项能力，对应的 Step 会在 Plan 校验时被标记 capability_missing。
  steps: [
    { action: "flash",  capability: "flash",         condition: "always" },
    { action: "stream", capability: "watch_serial",   timeout: 180,
      observe: { interval: 60, metrics: [] } },
    { action: "exec",   capability: "wait_adb",       command: "wait_adb", timeout: 180 },
    { action: "exec",   capability: "shell_exec",     timeout: 60, condition: "always" },
    { action: "exec",   capability: "collect_logs",   command: "dmesg", condition: "always" }
  ],
  evidence_policy: {
    always: ["serial:full", "events", "dmesg"],
    on_failure: ["serial:last_window", "logcat"]
  }
}

Run Manager 在把 Plan 交给 Step Executor 之前校验每个 Step:
  → Step.capability 存在于 Capability Registry 且 available=true → 保留
  → Step.capability 被 safety 禁止（如 allow_shell_exec=false 但 capability=shell_exec）→ 拒绝
  → Step.action 对应的 Connection 存在（如 stream 需要 serial）→ 保留
  → 不同 capability 即使 action 相同，校验也不同:
      exec("wait_adb")   → capability=wait_adb,  不需要 allow_shell_exec
      exec("dmesg")      → capability=collect_logs, 不需要 allow_shell_exec
      exec("kill -9")    → capability=shell_exec,   需要 allow_shell_exec，
                          且命令必须在 allowed_shell_commands 白名单内
  → capability 不可用或 safety 禁止 → 标记 skipped(capability_missing)
  → 所有 Step 都 skipped → Run(failed, reason: no_viable_plan)
```
```

---

## 15. Observer

**本质：** 用弱模型，高频调用。消费 RuleMatched/Checkpoint/Correlated/BaselineDiff/HumanNote，产出 Decision。

**为什么是 Decision Handler 调用而非 Event Bus 订阅：**

```
Observer 不是独立轮询。它只在有 Signal 需要判断时才被调用。

Decision Handler 是 Observer 的触发者:
  1. 收到 Event (RuleMatched/Checkpoint/...)
  2. 判断 Event.severity:
     fatal → 不调 Observer。直接 Decision(stop)
     warning / info → 需要 Observer 分析
  3. 做 debounce 检查 (同 rule_id 30s 内不重复)
  4. 调 ContextAssembler.assembleObserverInput()
  5. 调 Observer.decide(input)
  6. 拿到 Decision → 执行或拒绝

好处:
  - debounce、并发控制、fallback 都在 Decision Handler 里统一处理
  - Observer 只做纯粹的 LLM 调用 + 决策逻辑
  - Event Bus 不走 Observer，Observer 不直接订阅 Event Bus
```

**Decision JSON 结构：**

```
{
  decision: "stop"|"continue"|"collect_more"|"extend_wait"|"pause"|"suggest"
            |"observe_more_frequent"|"observe_again_at",
  reason: "内存从 120MB 持续增长到 180MB，+50%，持续 90 分钟",
  confidence: 0.82,

  params?: {
    extra_wait_sec?: number,      // extend_wait 时
    logs?: string[],              // collect_more 时: ["dmesg"]
    observe_interval?: number,    // observe_more_frequent 时
    observe_at?: number           // observe_again_at 时
  },

  suggestion?: string,            // suggest 时。给人看的。
                                  // "建议关注 foo 模块内存释放"

  reasoning_trace: string,        // 决策依据。可审计。
                                  // "memory ↑50%, errors 12, 持续90min"
  evidence_refs: string[]         // 引用哪些 checkpoint / rule_hit
}
```

---

## 16. Reply Generator

**本质：** 用强模型，一次 Run 调一次。不是总结器，是提取器。

**触发方式：Run Manager 直接调用，不是 Event Bus 订阅。**

```
为什么:
  Reply 和终态存在循环依赖:
    如果 Reply 消费 run_completed/run_failed Event 才开始，
    但终态又定义成 "Reply 写完后 Run Manager 标记"，
    → Reply 等终态 Event → 终态等 Reply 完成 → 死锁。

正确方式:
  1. collecting_evidence 完成 → RM 调 Reply.generate(run_id)        [正常流程]
     cancelled 后 → RM 调 Reply.generateCancelled(run_id, reason)    [取消流程]
     早期失败(Pre-flight/Plan reject/no_viable_plan/崩溃恢复) →
       RM 调 Reply.generateMinimal(run_id, failure_reason)           [最小化流程]
       不调 LLM。直接生成规则摘要。仍存 RunProfile。
  2. Reply 读 Event 摘要 + Evidence Index + Observer Notes
  3. LLM 提取关键信息 → 写 reply.json (minimal 时跳过 LLM)
  4. Reply 发 result_ready Event(payload统一契约: { run_id, status, summary, suggested_next, evidence_path, key_evidence })
     status同Reply判定终态。RM/NotificationFilter/Store 共用此payload。
     
  5. RM 收到 result_ready → 标记 Run 终态 completed/failed/cancelled
  6. RM 发 run_completed/run_failed/run_cancelled Event

  所有终态都经过 Reply。所有终态都存 Episode + RunProfile。
  Cancelled 不丢证据。早期失败不丢 RunProfile。

  终态在 Reply 完成之后。Reply 不消费终态 Event。
  Reply 发布 result_ready，不是消费 run_completed/run_failed。
```

**存 Memory 的时机：**

```
LLM 成功:
  → 写 reply.json (Agent Reply)
  → 存 Episode: { result, summary, key_evidence, suggestions }
  → 存 RunProfile: { stage_durations, final_metrics, output_summary }

LLM 失败 (fallback 规则摘要):
  → 写 reply.json (rule-based minimal reply)
  → 存最小 Episode: { result: run.state, summary: "LLM failed, 见 key events" }
  → 存 RunProfile (不需要 LLM，直接从 Aggregator 取 metrics)

RunProfile 永远存。即使 LLM 失败。它是结构化 metrics，不依赖 LLM。
```

**RunProfile 结构：**

```
{
  run_id, target_id,
  artifact: { path, type, version, build_id },
  result: "completed"|"failed"|"cancelled",
  stage_durations: [
    { stage: "bootloader", duration: 4.2 },
    { stage: "kernel", duration: 12.8 },
    ...
  ],
  final_metrics: {
    memory_mb: 132,
    cpu_pct: 28,
    fd_count: 1024,
    ...
  },
  output_summary: {
    total_lines: 12000,
    peak_lines_per_sec: 500,
    silence_count: 0,
    rule_hits: { kernel_panic: 0, foo_error: 1, ... }
  },
  recorded_at: timestamp
}
```

---

## 17. Memory

### 14.1 Semantic Fact 确认流程

```
Observer 发现新模式:
  → 发 suggestion_generated(suggest_new_fact, ...)
  → SemanticFact 存为 verified=false

Notification Filter:
  → 如果 config.on.memory_suggestion = true
  → 发通知: "Observer 建议新 SemanticFact: 'foo error 可能无害'。
            请确认: va memory confirm <fact-id>"

人确认:
  CLI: va memory confirm <fact-id>
  TUI: 选中 → 确认
  → verified=true。SemanticFact 持久化到 Memory Store。
  → 下次 Run 开始时，ContextAssembler 从 Memory Store 读取 verified=true
    的 SemanticFact，提取 extended_pattern，放入 AssembledContext.known_issue_patterns。
  → RuleDetector 在 Run 初始化时一次性加载。
  → 不热更新。当前正在执行的 Run 不受影响。

人拒绝:
  va memory delete <fact-id>
  → 删除。不生效。
```

### 14.2 Memory 调用方式

```
Memory 是 Agent 层的内部服务。不通过 Event Bus。

调用方直接调用:
  Planner:  memory.recall(target_id, task_keywords) → episodes + facts
  Observer: memory.recall(target_id, rule_id)       → known_issues + working_memory
  Observer: memory.writeWorkingMemory(run_id, entry)
  Reply:    memory.recordEpisode(episode)
  Reply:    memory.recordRunProfile(profile)

内部:
  Memory 持有 Memory Store 引用。读写通过 Store。
```

---

## 18. Target Manager

### Pre-flight Check

**本质：** Run 开始前验证所有连接可用。失败就拒绝，不在执行到一半才发现设备连不上。

**触发方：** Run Manager（不是 Step Executor）。

**通过路径：**
  RM → TG.preflight() → 全部通过
  → Run(planning) + Target(preparing→busy) → Run(running) → SE 开始执行

**失败路径（Run Manager 统一收口）：**
  RM → TG.preflight() → 任一检查失败
  → 释放 Target 锁，Run 进入终态:
      Host 问题(权限/文件) → Run(planning→failed) + Target(preparing→idle)
      设备问题(串口/ADB)  → Run(planning→failed) + Target(preparing→offline)
  → RM 发 RunFailed Event(failure_reason: "preflight_failed: {failed_checks}")
  → 返回错误给调用方

  注意: planning/failed 是 Run 状态。preparing/busy/idle/offline 是 Target 状态。
  两者独立变化。不混用。

```
{
  status: "target_not_ready",
  target_id: "board-01",
  failed_checks: [
    { check: "serial_open", error: "无法打开 /dev/ttyUSB0: Permission denied" },
    { check: "adb_connect", error: "设备 ABC123 offline" }
  ]
}
```

### 环境恢复

```
recovery 阶段:

1. 尝试重启设备
   Target Profile 的 recovery.reboot_method = "adb"
   → adb reboot
   → 如果 adb 不可用且 safety.allow_reboot=true → fastboot reboot
   → 都不行 → recovery 失败 → offline

2. 重刷稳定版本 (如果配置了 recovery.stable_artifact)
   → fastboot flash boot stable_artifact

3. 验证基本功能
   → 等 adb online (timeout: 180s)
   → 等串口有输出 (timeout: 30s)
   → 成功: 有 pending Run → preparing; 无 pending Run → idle
     (对齐 Target 状态迁移表: recovery 成功落点取决于是否有待执行 Run)

4. 恢复失败 → offline → 通知人 (target_offline)
```

---

## 19. Task Manager

### 重叠触发

**本质：** Cron 触发时，如果上一次 Run 还在跑，不创建新 Run。

```
为什么: 同一 Target 不能同时跑两个 Run。两个 Run 抢一个串口/ADB 端口。
怎么做: Task Manager 触发时:
  1. 检查 Task.last_run 状态
  2. 如果仍在 planning/running/paused/collecting_evidence/finalizing/cleaning → skip
  3. 记录 skipped_run Event
  4. 下一次触发再试

如果上一个 Run 刚刚结束 (Target 在 cleaning):
  Pre-flight 会在 preparing 阶段检查 Target 状态。
  如果 cleaning 还没完成 → Target != idle → Pre-flight 失败 → 拒绝。
  如果 cleaning 已完成 → Target 回到 idle → Pre-flight 通过 → 正常开始。
  不需要显式的 cooldown。Pre-flight 天然拦住。
```

---

## 20. Host 崩溃恢复

**本质：** Target 恢复（Section 15）处理设备侧。Host 崩溃恢复处理 Runtime 自己。

**怎么做：**

```
Runtime 启动时:
  1. Run Store 加载所有非终态 Run (planning/running/paused/collecting_evidence/finalizing)
  2. Target Store 加载 Target 状态
  3. 处理 stale 状态:
     - Run(state=running) 且最后 Event 距今 > N 分钟 → failed(crashed)
     - Run(state=paused) → 保持 paused
     - Run(state=planning):
      单进程模型下, 崩溃前的 Planner 调用不会继续存在。
      直接判定 Planning 中断:
        → Target 可用 → 重新触发 Planner
          → Planner 成功 → 继续 planning→running
          → Planner 失败 → Run(failed), 释放 Target 锁
        → Target 不可用 → Run(failed), 释放 Target 锁
     - Run(state=collecting_evidence) → 收尾 evidence。调 Reply.generateMinimal → finalizing→failed
     - Run(state=finalizing) → 判定已中断。调 Reply.generateMinimal → failed
     - Target(state=busy/dirty) → 标记 dirty。下次 Run 前走 recovery
     - Target(state=preparing) 且对应 Run 已被判定 crashed/failed → 释放锁 → idle
  4. Target Manager 尝试重连 → 发布 TargetStateChanged
  5. 清理 stale 锁:
       遍历所有 Target 的 currentRunId → 对应 Run 已终态 → 释放锁
       对应 Run 不存在 → 释放锁
  6. View 从 Event Store 重建
  7. 清理残留: 临时文件

原则: 不确定就标失败。不假装还在跑。
     已产生 evidence 保留。不丢现场。
```

---

## 21. Agent 自观测

**本质：** 系统不只盯设备，也盯自己。

```
关键指标（通过 Event Store 查询 + 内部计数器）:
  - Event Bus: 每 Run 的事件数、积压（如果队列可观测）
  - Observer: 调用次数、LLM 延迟 p50/p99、fallback 率
  - Planner/Reply: 调用次数、成功率
  - Target: 在线率、平均 busy 时长
  - Evidence Store: 磁盘使用量
  - LLM Cost: 每 Session 累计

暴露方式:
  - TUI status bar 展示关键数字
  - CLI: va status（系统级，不只是 Run）
  - Notification: LLM 成功率持续低于阈值 → 告警
```

---

## 22. 并发模型

**本质：** 多 Target 可以同时跑，单 Target 串行。

```
约束:
  - 同一 Target 同时最多 1 个 Run 处于占用状态（planning/running/paused/collecting_evidence/finalizing/cleaning）。
  - Target 锁在 Run 创建时获取（planning），在 Run 清理完成（cleaning→idle）后释放。
  - 不同 Target 的 Run 独立并行。
  - Step Executor: 每个 Run 一个独立的执行上下文
  - Event Bus: 按 run_id 分区。同 Run 事件顺序执行。不同 Run 事件并发
  - Observer/Planner/Reply: 它们内部可能调 LLM（async），不阻塞 Event Bus

实现假设:
  - Node.js 事件循环
  - 每个 Run 的执行是一个 async 上下文（不是独立线程）
  - Connection 操作（serialport, child_process）天然 async，不阻塞主循环
  - Observer LLM 调用是 async。Decision Handler 不等待 Observer 返回时
    Event Bus 可以继续处理其他事件
```

---

## 23. Notification Filter

**本质：** 订阅 Event Bus，根据 config 决定是否通知。消息内容是模板，不是 LLM。

**事件顺序（修 Reply 死锁后的新流程）：**

```
通知触发规则：

  result_ready 是唯一的 Run 终态通知触发源。
  所有终态路径（completed/failed/cancelled）都经过 Reply → result_ready。
  result_ready.payload 携带 { status, summary, suggested_next }。
  NotificationFilter 根据 status 渲染不同模板。

  RunFailed / RunCompleted / RunCancelled 是审计事件。不触发通知。
  早期失败（Pre-flight / Plan reject）→ Reply.generateMinimal → result_ready → 通知。
  正常失败（Decision stop）→ Reply.generate → result_ready → 通知。
  Cancelled → Reply.generateCancelled → result_ready → 通知。

  同一次 Run 只有一个 result_ready。不存在重复通知问题。

run_failed/run_completed 是终端状态审计事件。
NotificationFilter 不直接订阅它们——已由规则1和2覆盖。
```

**通知触发配置（语义分类，不直接写 Event 名）：**

```
notifications.on:
  run_result:        result_ready → 结果通知（唯一。含 status + reply.summary + suggested_next）
  target_offline:    target_state_changed → Target.state = offline → 即时通知
  target_offline_long: 连接断开持续 > 30min → 升级通知
  memory_suggestion: suggestion_generated(memory) → 新 SemanticFact 建议

NotificationFilter 内部映射 Event → 触发分类 → 查 config.on → 决定是否通知
```

```
消息模板:

run_result (result_ready → 唯一终态通知):
  "Run #{run_id} {status}:
   {reply.summary}
   建议: {reply.suggested_next}
   证据: {evidence_root}
   查看: va result --run-id {run_id}"

target_offline (即时):
  "Target {target_id} 进入 offline 状态。原因: {offline_reason}
   恢复步骤: 检查物理连接 → 检查串口/ADB → va target status {target_id}"

target_offline_long (持续 > 30min):
  "Target {target_id} offline 已持续 {duration} 分钟。
   最后状态: {target_state}
   请尽快检查。"

memory_suggestion:
  "Observer 建议新 SemanticFact:
   '{suggestion}'
   确认: va memory confirm {fact_id}
   忽略: va memory delete {fact_id}"

去重:
  同 Run 同原因 5 分钟内不重复
  target_offline 30 分钟内最多一次
```

---

## 24. 核心类型汇总

```
Run 状态:     planning | running | paused | collecting_evidence | finalizing | completed | failed | cancelled

Target 状态:  idle | preparing | busy | cleaning | dirty | recovery | offline

Step action:  exec | stream | push | flash

Event:
  Lifecycle:    run_started, plan_generated, step_started, step_completed,
                step_failed, run_completed, run_failed, run_cancelled,
                run_paused, run_resumed, result_ready
  Observation:  observation, target_state_changed, human_note
  Rule:         rule_matched, step_timeout
  Periodic:     checkpoint
  Signal:       correlated, baseline_diff, stage_transition
  Decision:     decision_made(source=rule/observer/human/fallback),
                decision_rejected, suggestion_generated, rule_ignored, decision_overridden
  Task:         skipped_run
  Evidence:     evidence_collected
  Hook:         hook_executed
  Notify:       notification_sent

Decision:  stop | continue | collect_more | extend_wait | pause | resume |
           cancel | ignore_rule | suggest | observe_more_frequent |
           observe_again_at | override_decision
```

### Run 状态迁移

```
所有终态（completed/failed/cancelled）统一经过 Reply → result_ready → RM 标记终态。

planning  → running               Plan 校验通过 + Pre-flight 通过
planning  → finalizing            Plan 校验失败 / Pre-flight 失败
                                   → Reply.generateMinimal → result_ready → failed
running   → paused                Human pause / Target 断开
running   → collecting_evidence   主路径完成 或 Decision(stop)
running   → finalizing            Human cancel (跳过补采)
paused    → running               Human resume, Target 可用
paused    → finalizing            Human cancel 或选择结束
collecting_evidence → finalizing  证据补采完成 → Reply 开始生成
finalizing → completed            Reply 判定成功, result_ready 已发
finalizing → failed               Reply 判定失败, result_ready 已发
finalizing → cancelled            Reply 判定取消, result_ready 已发

collecting_evidence = 失败/完成后补采最终证据（dmesg/snapshot/...）。
finalizing = Reply 正在生成结果。终态标记在 result_ready 之后。
```

终态 `completed | failed | cancelled` 不可再迁移。

### Target 状态迁移

```
idle      → preparing            Run 开始前 Pre-flight
idle      → recovery             人触发恢复 (无 pending Run 时)
preparing → recovery             检测到 dirty (由 pending Run 触发)
preparing → busy                 Pre-flight 全部通过
preparing → recovery             检测到残留 (dirty 标记)
preparing → idle                 Pre-flight 失败(Host侧: 权限/文件不存在) → 释放锁
preparing → offline              Pre-flight 失败(设备侧: 串口/ADB 连不上) → 设备不可用
busy      → cleaning             Run 结束
busy      → dirty                Run 崩溃/未正常清理
cleaning  → idle                 清理完成
cleaning  → dirty                清理失败，有残留
dirty     → recovery             下次 Run 前自动触发
recovery  → idle                 恢复成功，且无 pending Run
recovery  → preparing            恢复成功，有 pending Run 等待执行
recovery  → offline              恢复失败, 需人工介入
offline   → recovery             人修复后触发恢复
```

---

## 25. 调用方式：什么时候走 Event Bus，什么时候直接调

```
直接调用（同步依赖，调用方需要返回值）:
  Run Manager → Planner          (等 Plan 才能推进状态)
  Decision Handler → Observer    (等 Decision 才能执行)
  Run Manager → Reply            (Reply 完成前不进终态)
  Reply Generator → Memory       (写 Episode/RunProfile)
  Agent → Memory                 (读写 Memory)
  Step Executor → Connection     (等 exec/stream 完成)
  Context Assembler → Config     (组装 Context)

Event Bus（异步，不依赖返回值）:
  Tool → Event Bus               (RuleMatched, Checkpoint, TargetStateChanged)
  Run Manager → Event Bus        (RunStarted, RunCompleted, ...)
  Planner → Event Bus            (PlanGenerated)
  Observer → Event Bus           (DecisionMade, Suggestion)  ← 仅审计
  Reply → Event Bus            (result_ready)
  Event Bus → Notification Filter (各种 Event)
  Event Bus → Store              (持久化)

原则: 需要返回值 → 直接调。广播/持久化 → Event Bus。
```

---

## 26. 禁止交互

| 禁止 | 原因 |
|-----|------|
| Interface → Tool | 不直接执行设备动作 |
| Interface → Agent | 不直接调 LLM |
| Tool → Agent (直接调用) | Tool 只发 Event |
| Agent → Tool | Agent 不执行设备动作 |
| Agent 直接读 Config | 只收 AssembledContext |
| Tool 改 Run 状态 | 只 Run Manager 改 |
| Agent 写 Step Queue | 只 Step Executor 取，Decision Handler 追加/清空 |
| Observer 读全量日志 | 只看 Signal + 窗口 |
| generic device_exec 作为产品接口 | 打穿安全边界 |

---

## 27. 目录结构

```
packages/
  contracts/       类型定义
  runtime/         Run Manager, Step Queue, Step Executor, Decision Handler,
                   Event Bus, Task Manager, Context Assembler, HookManager
  tools/           Connection 接口, Local/Serial/ADB/Fastboot/SSH,
                   OutputPipe, RingBuffer, Rule Detector, Aggregator,
                   Connection Manager, Target Manager
  agent/           Planner, Observer, Reply, Memory, Skill Registry
  stores/          Event, Evidence, Run, Target, Memory, Skill
  notify/          Notification Filter
  views/           Run View, Target View, Evidence View

apps/
  cli/             CLI 入口
  mcp-server/      MCP Server
  tui/             TUI 实时视图
```
