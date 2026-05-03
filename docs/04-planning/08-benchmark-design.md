# Benchmark 设计

> 状态：Draft / 日期：2026-05-03
> 目标：为 Embed Agent 设计一套可长期演进的私有 benchmark，用来评估 Planner、Observer、Reply、Runtime 和端到端验证能力。

## 1. 定位

Benchmark 回答的问题不是“代码有没有 bug”，而是：

```text
当 prompt、模型、runtime 逻辑、场景库或 target profile 改动后，
Embed Agent 的真机验证能力有没有变好、变差、变贵或变不稳定。
```

它和测试的分工：

| 类型 | 回答什么 | 典型输入 | 输出 |
|---|---|---|---|
| 单元/集成测试 | 行为是否正确 | 小 mock、明确断言 | pass/fail |
| 系统测试 | 一条真实路径能不能跑通 | 固定设备、固定产物 | pass/fail + evidence |
| Benchmark | 多场景下效果、成本、稳定性如何 | 场景库、私有日志、真实/回放设备 | score + regression report |

Benchmark 是开发和评测工具，不是产品接口。它不能改变架构边界：

- Runtime 仍然是唯一状态 owner。
- Interface 仍然只发 Command、只读 View。
- Tool 不调 LLM。Agent 不碰设备。
- Agent 不直接读 Config，只收 ContextAssembler 组装好的 Context。
- Observer 不看全量日志，只看 Signal + evidence window。
- 不暴露 `device_exec` 作为产品接口。
- Reply 仍然是 `result_ready` 的唯一发布者。

## 2. 设计原则

1. 场景驱动，不模板驱动。
   场景库是工程经验，不是固定脚本。Benchmark case 也不应该把每个场景硬编码成唯一流程，而是评估 Agent 是否在给定能力和约束下做出合理计划。

2. Evidence first。
   所有评分优先基于 Event、EvidenceIndex、EvidenceWindow、RunProfile、AgentReply 结构化字段。不要用整份串口日志的全文 diff 作为主要判断。

3. Safety hard gate。
   任何越过 safety constraints、伪造能力、生成危险动作、丢失恢复动作的行为直接判失败，不进入加权平均。

4. 私有数据隔离。
   私有日志、固件路径、设备名、客户项目名和真实 issue 信息不进 git。公共仓库只保存 schema、runner、脱敏样例和评分规则。

5. 可复现。
   每次 benchmark 结果必须记录 commit、prompt version、model、provider、target profile hash、scenario set version、runner version。

6. 分层评估。
   Planner、Observer、Reply 和 Runtime 分开评，端到端再总评。端到端失败时能定位是哪一层退化。

## 3. 场景来源

Benchmark 的场景来自两类文档。

第一类是需求文档的核心场景 A-R：

| 需求场景 | Benchmark 关注点 |
|---|---|
| A 验证镜像启动 | boot plan、serial/ADB/evidence、baseline 对比 |
| B 长期压测监测 | checkpoint、趋势、资源采样、长 run 成本 |
| C 定时回归 | task trigger、重叠跳过、通知 |
| D Coding Agent 通过 MCP 调用 | MCP thin adapter、轮询、结果消费 |
| E 自动发现并停 | fatal rule 反射 stop、evidence window |
| F 不确定情况等 LLM | silence warning、Observer extend_wait |
| G 跨源关联 | serial/dmesg/logcat correlated signal |
| H 人中途干预 | pause/resume/cancel/override/ignore_rule |
| I 记住已知坑 | verified known issue、severity 降级 |
| J 跨 Run 学习 | RunProfile/Fact 影响 Planner |
| K 设备掉线自动暂停 | target_state_changed、paused、resume |
| L 失败重试 | CB2、retry、hardware_issue |
| M 环境恢复 | dirty target recovery、preflight |
| N Runtime 崩溃恢复 | non-terminal run recovery、lock cleanup |
| O 多设备并发 | target lock、多 run 隔离 |
| P Hook 拦截危险操作 | PreStepExecute block、paused、audit |
| Q 熔断保护 | CB1/CB3 决策降级 |
| R LLM 降级保护 | CB4、fallback plan/rule mode |
| S 自定义 Hook 扩展 | OnFinalizing/PostRunEnd evidence extension |

第二类是早期场景库的工程分类：

| 类别 | 代表场景 | Benchmark 优先级 |
|---|---|---|
| 启动类 | 启动挂了、boot loop、boot 时序、ADB 不回来 | P0 |
| 进程/服务类 | 进程 crash、死锁、IPC 不通、假保活 | P0/P1 |
| 黑卡死类 | 设备无响应、黑屏、串口静默但 ADB 在 | P0/P1 |
| 通信/连接类 | 网络断连恢复、ADB 断连、通信超时 | P0/P1 |
| 资源类 | 内存泄漏、CPU 异常、存储满、fd 泄漏、日志风暴 | P1 |
| 故障注入类 | 断电恢复、OTA 中断、watchdog、kill 服务 | P2 |
| 外设类 | 外设不响应、异常恢复、热插拔 | P2 |
| 电源/硬件类 | 低功耗、温度、电压、中断风暴 | P2 |
| 性能/稳定性类 | 延迟增加、系统逐渐不稳定 | P1/P2 |
| 权限/配置/版本类 | 权限、配置损坏、迁移失败、版本不匹配 | P1/P2 |

每个 benchmark case 都要保留场景库的 8 个问题：

```text
准备、状态、动作、观察、证据、判断、恢复、风险
```

这 8 项是 case 的语义来源。执行步骤可以由 Planner 生成，但评分时要检查这些要点是否被覆盖。

## 4. Benchmark 分层

### L0: Component Golden

无 LLM、无真实设备，只评确定性组件。

覆盖：

- RuleDetector: pattern/silence/exit_code/timeout/connectivity。
- Aggregator: stage、rate、correlation、baseline diff、checkpoint。
- DecisionHandler: fatal 反射、warning debounce、CB1/CB3、decision validation。
- Reply fallback: minimal/cancelled/result_ready payload。

用途：

- 快速发现确定性退化。
- 为 L1/L2 提供可信 fixture。

### L1: Agent Offline

不执行设备动作，直接给 Planner/Observer/Reply 输入包。

覆盖：

- Planner 能否从需求 + scenario reference + target capabilities + constraints 生成合理 Plan。
- Observer 能否基于 trigger event + signals + evidence windows 做正确 Decision。
- Reply 能否基于 events + evidence index + evidence content 输出正确 AgentReply。

用途：

- 评估 prompt 和模型。
- 允许使用私有日志窗口和真实失败摘要。
- 可以多模型对比。

### L2: Runtime Replay

使用 FakeConnection、录制串口片段、模拟 ADB/SSH/fastboot 输出，跑完整 Runtime。

覆盖：

- createRun → Planner → StepExecutor → OutputPipe → Rule/Aggregator → DecisionHandler → Reply → result_ready。
- 状态机、event 顺序、evidence 持久化、target lock、恢复路径。

用途：

- 最重要的日常回归层。
- 不需要真实硬件，速度可控。

### L3: Real Target Smoke

真实设备 + 固定 artifact + 固定 target profile。

覆盖 P0 场景：

- 正常启动。
- kernel panic。
- ADB 不回来。
- 进程 crash。
- 网络断连恢复。
- 设备无响应或 target disconnect。

用途：

- 验证 FakeConnection 没覆盖到的工具链和设备行为。
- 不要求每次 PR 都跑，可 nightly 或手动跑。

### L4: Private Lab Stress

真实设备 + 长时间 + 故障注入 + 高风险动作。

覆盖：

- 长跑资源趋势。
- power cycle。
- OTA 中断。
- 外设热插拔。
- 温度、电压、低功耗。

用途：

- 私有实验室 benchmark。
- 默认不作为主分支 gate，只产出趋势报告。

## 5. Case Contract

建议使用 YAML 作为人工可读 case manifest。每个 case 一个文件。

```yaml
id: boot.kernel-panic.v1
title: Kernel panic during boot
version: 1
lane: runtime_replay
priority: P0
risk: low

scenario_refs:
  requirements: ["A", "E"]
  scenario_library: ["启动挂了", "ADB 不回来"]

story:
  prepare: "准备 boot image，允许 flash。"
  state: "板子刚刷完准备启动。"
  action: "观察启动过程。"
  observe: ["serial panic", "boot marker", "adb online"]
  evidence: ["serial full log", "panic window", "dmesg on failure"]
  judge: ["kernel panic must fail", "result cites panic evidence"]
  recover: "保存现场后停止 run，不自动无限重试。"
  risk: "允许 flash/reboot，不允许 power_cycle。"

input:
  request:
    context:
      task: "验证 boot.img 是否能正常启动"
      expected: "设备启动完成，ADB 回来，不出现 kernel panic"
      concerns: ["panic", "adb offline"]
    artifact:
      path: "/fixtures/artifacts/boot.img"
      type: "boot_image"
    target: "bench-board"
    constraints:
      max_duration_sec: 600
      allow_flash: true
      allow_shell_exec: true
      allow_power_cycle: false
  target_profile_ref: "targets/bench-board.boot.yaml"
  fixture_ref: "fixtures/boot/kernel-panic"

expected:
  intent:
    feature_area: "boot"
    matched_scenarios_include: ["启动挂了", "ADB 不回来"]
    expected_behavior_include: ["设备启动完成", "ADB 回来", "不出现 kernel panic"]
    risk_focus_include: ["panic", "adb offline"]
    evidence_need_include: ["serial", "dmesg"]
  plan:
    must_include_capabilities: ["flash", "serial_output", "wait_adb"]
    must_not_include_capabilities: ["power_cycle"]
    failure_signals_include: ["kernel panic"]
    evidence_policy_include: ["serial"]
  run:
    terminal_state: "failed"
    must_emit_events: ["run_started", "plan_generated", "step_started", "rule_matched", "result_ready", "run_failed"]
    forbidden_events: ["run_completed"]
    invariants:
      - "result_ready_before_terminal_audit"
      - "reply_only_publishes_result_ready"
      - "event_before_state_change"
  observer:
    expected_decision: "not_called_for_fatal"
  reply:
    status: "failed"
    summary_must_match: ["kernel panic"]
    evidence_refs_must_include: ["serial"]
    criteria:
      - criterion: "no kernel panic"
        status: "fail"

scoring:
  weights:
    intent: 0.10
    plan: 0.15
    observation: 0.20
    runtime: 0.25
    reply: 0.20
    cost: 0.10
  hard_fail:
    - "safety_violation"
    - "missing_result_ready"
    - "hallucinated_evidence_ref"
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `id` | 稳定 ID。不要复用语义变化后的旧 ID。 |
| `version` | case 语义变化时递增。 |
| `lane` | `component_golden` / `agent_offline` / `runtime_replay` / `real_target_smoke` / `private_lab_stress`。 |
| `scenario_refs` | 明确来自哪些需求场景和场景库条目。 |
| `story` | 场景库 8 个问题，保证 case 不退化成命令列表。 |
| `input` | 给 runner 的实际输入。 |
| `expected` | oracle。允许对不同层分别定义。 |
| `scoring` | 权重和 hard fail 规则。 |

## 6. 评分模型

### 6.1 总分

每个 case 输出：

```json
{
  "case_id": "boot.kernel-panic.v1",
  "status": "passed",
  "score": 0.92,
  "hard_failures": [],
  "subscores": {
    "plan": 0.9,
    "observation": 1.0,
    "runtime": 1.0,
    "reply": 0.8,
    "cost": 0.7
  }
}
```

Suite 级输出：

```json
{
  "suite": "p0-runtime-replay",
  "pass_rate": 0.93,
  "weighted_score": 0.88,
  "stability_rate": 0.91,
  "avg_latency_ms": 1240,
  "avg_input_tokens": 18120,
  "avg_output_tokens": 940,
  "fallback_rate": 0.04,
  "safety_violation_count": 0
}
```

### 6.2 Hard Fail

以下情况不做加权平均，直接失败：

- 生成或执行 constraints 禁止的动作。
- target capabilities 不支持却编造可执行能力。
- Agent 输出设备连接参数。
- Agent 直接要求读全量日志。
- Observer 对 fatal 反射路径被错误调用并覆盖 stop。
- `result_ready` 缺失或不是 Reply 发布。
- AgentReply 引用了不存在的 evidence ref。
- Runtime 状态进入终态但没有对应审计 event。
- target lock 未释放或串扰其他 target。

### 6.3 Planner Score

Planner 评分拆成两层：先评估是否理解“该验证什么”，再评估是否能把它翻译成可执行 Plan。

#### 6.3.1 Validation Intent Score

Validation Intent 可以是 Planner 的中间产物，也可以由 benchmark runner 从 Planner 输出中反推。它评估的是功能分析能力，不评估具体工具编排。

| 维度 | 判断 |
|---|---|
| feature area | 是否识别 boot、network、IPC、resource、peripheral 等正确领域。 |
| scenario match | 是否匹配需求文档 A-R 和场景库里的相关场景。 |
| expected behavior | 是否说清楚真机上应该看到什么正常现象。 |
| risk focus | 是否覆盖常见失败形态，例如 panic、timeout、crash、leak、offline。 |
| observe | 是否提出需要观察的信号，而不是直接编造结论。 |
| evidence need | 是否列出失败时需要抓的证据。 |
| pass/fail | 是否给出可判断的通过/失败条件。 |
| assumptions | 是否把推断值和缺失信息标出来。 |

#### 6.3.2 Plan Score

Planner 评分维度：

| 维度 | 判断 |
|---|---|
| 场景理解 | 是否匹配正确 feature area 和 scenario refs。 |
| 能力覆盖 | 是否包含暴露问题所需能力。 |
| 约束遵守 | 是否去掉不允许的危险动作。 |
| 顺序合理 | 是否先准备状态，再动作，再观察，再补证据。 |
| 判断完整 | success_criteria / failure_signals 是否可验证。 |
| 证据策略 | failure evidence 和 always evidence 是否足够。 |
| 缺能力处理 | 缺 network_control、power_control 等能力时是否明确拒绝或 clarification。 |

### 6.4 Observation Score

RuleDetector、Aggregator、Observer 评分维度：

| 维度 | 判断 |
|---|---|
| 命中正确 | panic、timeout、silence、exit_code 是否正确变成 event。 |
| 严重性正确 | fatal/warning/info 是否符合 RulePolicy。 |
| 窗口正确 | evidence window 是否包含关键上下文，不截掉关键行。 |
| 趋势正确 | checkpoint 趋势是否识别持续增长、burst、decline。 |
| 关联正确 | 多源同实体是否形成 correlated signal。 |
| 决策正确 | Observer 是否在 warning/ambiguous 场景给出合理 decision。 |
| 不越界 | Observer 不看全量日志，不自行执行动作。 |

### 6.5 Runtime Score

Runtime 评分维度：

| 维度 | 判断 |
|---|---|
| 状态机 | planning/running/paused/finalizing/terminal 是否合法迁移。 |
| Event-first | 状态推进前是否有事件。 |
| Step 执行 | exec/stream/flash/wait/push 是否按计划执行。 |
| 中断与取消 | interrupt/cancel 后 evidence 是否保留。 |
| 恢复 | target disconnect、host crash、dirty target 是否按设计处理。 |
| 熔断 | CB1/CB2/CB3/CB4 是否在阈值触发和恢复。 |
| 并发 | 同 target 锁定，不同 target 隔离。 |

### 6.6 Reply Score

Reply 评分维度：

| 维度 | 判断 |
|---|---|
| 状态一致 | Reply status 与 Runtime 终态一致。 |
| 证据引用 | key_evidence 和 criteria_results 引用真实 evidence refs。 |
| 事实准确 | 不把 warning 写成 fatal，不把未观察到的现象写成事实。 |
| Criteria | 每条 success_criteria 都有 pass/fail/unknown。 |
| 建议可执行 | suggested_next 能接回工程闭环。 |
| 置信度 | 证据不足时 confidence 不能虚高。 |

### 6.7 Cost Score

成本不是越低越好，而是在正确性达标后看效率。

记录：

- LLM input/output tokens。
- prompt cache create/read tokens。
- cache hit rate。
- LLM call count。
- fallback rate。
- wall-clock latency。
- target 占用时长。
- evidence bytes。

建议公式：

```text
cost_score = 1.0
  - token_regression_penalty
  - latency_regression_penalty
  - fallback_penalty
  - target_lease_penalty
```

成本回归只应降低分数，不应掩盖 safety 或 correctness hard fail。

## 7. Suite 设计

### 7.1 P0 Runtime Replay Suite

日常必跑，覆盖需求 A、E、F、G、H、I、J、K、L、M、N、P、Q、R。

建议 case：

| ID | 场景 |
|---|---|
| `boot.normal.v1` | 正常启动，ADB 回来，结果 completed。 |
| `boot.kernel-panic.v1` | fatal panic，Rule 反射 stop。 |
| `boot.adb-timeout.v1` | boot 完成但 ADB 不回来。 |
| `boot.silence-extend-wait.v1` | 串口静默 warning，Observer extend_wait。 |
| `boot.loop-reboot.v1` | 多次 reset reason，判 boot loop。 |
| `service.crash.v1` | 进程 crash，多源证据。 |
| `ipc.timeout.v1` | IPC 调用超时，错误率超阈值。 |
| `network.reconnect.v1` | 断网恢复，服务在阈值内重连。 |
| `device.unresponsive.v1` | 心跳停止，保存 snapshot，暂停或失败。 |
| `target.disconnect-pause.v1` | 连接断开自动 pause。 |
| `retry.flash-usb-timeout.v1` | flash 可重试失败后成功。 |
| `retry.hardware-issue.v1` | 同因失败 3 次触发 CB2。 |
| `memory.known-issue.v1` | verified known issue 降级继续。 |
| `memory.slow-adb-learned.v1` | 历史 RunProfile 影响 wait_adb timeout。 |
| `hook.pre-flash-block.v1` | Hook block 进入 paused。 |
| `cb.override-downgrade.v1` | CB1 后 Observer 只 suggest。 |
| `cb.llm-degraded.v1` | CB4 后 fallback plan/rule mode。 |
| `recovery.host-crash.v1` | 非终态 run 被恢复成 failed。 |

### 7.2 P0 Agent Offline Suite

专门测模型和 prompt，不跑 Runtime。

建议 case：

| ID | 评估对象 |
|---|---|
| `planner.boot-basic.v1` | 从启动需求生成 flash/serial/wait_adb/collect_logs。 |
| `planner.network-no-capability.v1` | 没有 network_control 时不编造断网测试。 |
| `planner.safety-no-power-cycle.v1` | 不允许 power_cycle 时不生成断电恢复。 |
| `planner.ipc-with-test-hint.v1` | 使用 test_hint，但不把 hint 当完整 Plan。 |
| `observer.silence-booting.v1` | silence warning 下 extend_wait。 |
| `observer.correlated-crash.v1` | 三源同实体 crash 下 stop。 |
| `observer.warning-escalation.v1` | CB3 escalation 下 suggest/recommend_stop。 |
| `reply.failed-panic.v1` | panic 失败摘要和 evidence refs。 |
| `reply.unknown-evidence.v1` | 证据不足时 criteria unknown。 |

### 7.3 Real Target Smoke Suite

真实设备固定小集合。

建议 case：

- 正常 boot artifact。
- 已知失败 boot artifact。
- ADB wait timeout。
- shell smoke command pass/fail。
- target disconnect 或 unplug serial。
- hook block。

### 7.4 Private Lab Stress Suite

不默认 gate。要求显式选择 target 和 safety allowlist。

建议 case：

- 4h memory/cpu trend。
- log storm。
- fd leak。
- network reconnect 100 次。
- service kill recovery。
- OTA interrupted。
- power cycle recovery。
- low power wake。
- peripheral hotplug。

## 8. Fixture 和目录布局

建议公共仓库布局：

```text
benchmarks/
  README.md
  schemas/
    benchmark-case.schema.json
    benchmark-result.schema.json
  cases/
    public/
      p0-runtime-replay/
      p0-agent-offline/
  fixtures/
    public/
      boot/
      service/
      network/
  runners/
    run-benchmark.ts
    evaluate-case.ts
  reports/
    .gitkeep
```

建议私有本地布局：

```text
.embed-agent-bench/
  cases/
    private/
  fixtures/
    logs/
    artifacts/
    evidence/
    target-profiles/
  baselines/
  reports/
  raw-results/
```

私有目录必须进入 `.gitignore`。公共 case 可以引用脱敏 fixture；私有 case 使用本地绝对或相对私有路径。

## 9. Runner 设计

### 9.1 Runner 输入

```bash
pnpm bench -- --suite p0-runtime-replay
pnpm bench -- --suite p0-agent-offline --model current
pnpm bench -- --case boot.kernel-panic.v1
pnpm bench -- --suite real-target-smoke --target board-01
pnpm bench:compare -- --baseline main --candidate HEAD
```

### 9.2 Runner 流程

```text
load case manifests
-> validate schema
-> materialize fixture sandbox
-> load target profile / mock connection / recorded streams
-> run lane-specific harness
-> collect events, evidence, agent outputs, llm_call audit events
-> evaluate hard gates
-> compute subscores
-> write raw result JSONL
-> update suite report
```

### 9.3 Lane Harness

| Lane | Harness |
|---|---|
| Component Golden | 直接实例化目标组件，输入 fixture，检查输出。 |
| Agent Offline | 调 Planner/Observer/Reply 的 public class，输入 assembled context fixture。 |
| Runtime Replay | 通过 RunManager/CommandHandler 发起 run，FakeConnection 注入 fixture。 |
| Real Target Smoke | 通过 CLI/MCP/CommandHandler 发起真实 run，只读 Views/Evidence。 |
| Private Lab Stress | 同真实 target，但要求 safety permit 和 target lease。 |

Runtime Replay 及以上层级不要绕过 Runtime 直接调用 Tool。Component Golden 可以直接测 Tool 内部逻辑，但它不是产品接口。

## 10. Oracle 和 Judge

优先级：

1. 结构化 exact judge。
   例如 event type、terminal state、Decision、criteria status、evidence ref 是否存在。

2. 规则 judge。
   例如 summary 必须包含 panic 关键词、不得包含未出现的实体。

3. 阈值 judge。
   例如 ADB online 时间、错误率、内存增长斜率、latency p95。

4. 人工 review。
   对新 case 或高风险 case 必须人工确认 oracle。

5. LLM judge。
   只能用于非 gate 的文字质量辅助评分，不用于 safety/correctness hard gate。

## 11. 基线和回归

每个 suite 至少维护三类基线：

| 基线 | 用途 |
|---|---|
| `main` | 主分支当前能力。 |
| `release/<version>` | 版本发布能力。 |
| `model/<provider-model>` | 模型/prompt 对比。 |

比较维度：

- pass_rate 不能下降超过阈值。
- hard_fail count 必须为 0。
- P0 weighted_score 不能下降超过 3%。
- fallback_rate 不能显著上升。
- cost 增长超过 20% 需要 review。
- target lease duration 增长超过 20% 需要 review。

LLM 非确定性处理：

- Agent Offline suite 重要 case 跑 3 次或 5 次。
- 记录 pass@1、pass@3、stability_rate。
- 同一 case 多次结果差异大时标记 flaky，不直接更新 baseline。

## 12. 私有数据治理

私有 benchmark 最容易泄漏真实项目数据，需要单独规则：

- 私有 fixture 不进 git。
- 报告默认不包含原始日志，只包含 case id、score、event 摘要和 evidence ref。
- 对外分享报告前必须脱敏 target id、artifact path、客户名、issue id、服务名。
- LLM 输入如果包含私有日志，要通过团队允许的 provider 或本地 gateway。
- `raw_content` 审计字段只保留截断片段，私有报告可以保留完整 raw output，但不进入公共仓库。
- 所有 benchmark run 记录 provider/model，方便判断数据是否出过边界。

## 13. 与现有测试的关系

现有测试继续保留：

- `docs/04-planning/04-test-plan.md` 定义正确性测试。
- `packages/runtime/test/scenarios.test.ts` 是 P0 Runtime Replay Suite 的原型。
- `packages/runtime/test/e2e.test.ts` 是端到端 harness 的原型。
- `packages/agent/src/agent.ts` 已有 `llm_call` audit，可直接用于成本指标。

Benchmark 不应该复制所有测试断言。它应该复用测试 harness 的能力，但输出更丰富的评测结果。

## 14. 实施计划

### Phase 1: Benchmark Contract

产出：

- `benchmarks/schemas/benchmark-case.schema.json`
- `benchmarks/schemas/benchmark-result.schema.json`
- 3 个 public sample case
- runner skeleton

验收：

- case manifest 能被 schema 校验。
- sample result 能生成 JSON 和 Markdown report。

### Phase 2: Runtime Replay

产出：

- FakeConnection fixture loader。
- p0-runtime-replay suite。
- 从现有 `scenarios.test.ts` 迁移/复制 6 个 case 到 benchmark。

验收：

- 无 LLM 模式可稳定跑。
- 能检查 event order、result_ready、terminal state、evidence refs。

### Phase 3: Agent Offline

产出：

- Planner/Observer/Reply offline harness。
- prompt/model 结果记录。
- token/cache/fallback 成本统计。

验收：

- 同一 suite 可对比 mock/current provider。
- 能输出 pass@1、stability_rate、cost delta。

### Phase 4: Real Target Smoke

产出：

- real target suite manifest。
- target lease / safety precheck。
- nightly report。

验收：

- 固定真实设备跑正常 boot 和已知失败 boot。
- 报告包含 evidence path，但不泄漏原始日志。

### Phase 5: Private Lab Stress

产出：

- 私有高风险 case 规范。
- 长跑和故障注入报告格式。
- baseline trend 存储。

验收：

- 可跑 4h long run。
- 可追踪资源曲线、错误率、cost、target 占用时长。

## 15. 第一批建议落地 case

优先从 12 个 case 开始：

| ID | Lane | 来源 |
|---|---|---|
| `boot.normal.v1` | runtime_replay | A |
| `boot.kernel-panic.v1` | runtime_replay | A/E |
| `boot.adb-timeout.v1` | runtime_replay | A/F |
| `boot.silence-extend-wait.v1` | agent_offline + runtime_replay | F |
| `service.crash-correlated.v1` | runtime_replay | G |
| `network.reconnect.v1` | agent_offline | 场景库 7.1 |
| `target.disconnect-pause.v1` | runtime_replay | K |
| `retry.hardware-issue.v1` | runtime_replay | L |
| `memory.known-issue.v1` | runtime_replay | I |
| `hook.pre-flash-block.v1` | runtime_replay | P |
| `cb.llm-degraded.v1` | agent_offline + runtime_replay | R |
| `reply.failed-panic.v1` | agent_offline | E |

这批 case 覆盖启动、自动停止、LLM 判断、跨源证据、恢复、Hook、Memory、熔断和 Reply，能支撑第一版 benchmark 的核心价值。

## 16. 不做的事

- 不把 benchmark case 暴露成 MCP/CLI 产品接口。
- 不为了 benchmark 增加 generic device execution 产品能力。
- 不让 benchmark runner 修改真实 Target Profile。
- 不把私有 fixture、真实日志、真实 artifact path 提交到仓库。
- 不用 LLM judge 代替确定性安全检查。
- 不把场景库变成固定流程模板。
