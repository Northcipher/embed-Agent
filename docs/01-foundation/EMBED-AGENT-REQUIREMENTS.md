# Embed Agent 需求文档

> 状态：Draft
> 日期：2026-04-29

## 1. 一句话

替代工程师盯设备的重复劳动。人配好"怎么做"，每次告诉 agent "做什么"，系统自动刷机、盯串口、分析趋势、发现异常自动决策、留证据、翻译成人话。可以定时跑、持续跑、出了事自动响应。

**核心价值不是"会盯串口的 agent"。是 grep 做不了的事——时序分析、跨源关联、因果推断、基线对比、主动采样。**

---

## 2. 人怎么用

### 第一步：一次性配置。

```bash
va target add --id board-01 \
  --serial /dev/ttyUSB0 --baud 115200 \
  --adb device-02 --flash-method fastboot \
  --boot-markers "Booting Linux,init started,boot completed" \
  --fail-patterns "qcom_smd: timeout" \
  --known-quirks "dmesg 中 'foo error' 已知无害"
```

配好 LLM Config、System Config、可选的 Hook 脚本。之后不用再管。

### 第二步：日常使用。一句话。

```bash
va validate --artifact boot.img --target board-01 \
  --expected "设备能正常启动，ADB 能回来"

va validate --continuous --duration 4h --observe-interval 5m \
  --expected "4 小时内无崩溃、无内存泄漏"

va task create --name "nightly" --cron "0 2 * * *" --skill validate-boot
```

### 第三步：看结果。一眼懂。

```
❌ 启动 42s 后 kernel panic。崩溃位置: init 进程 (CPU0, PID1)。

Timeline:
  0s    ✅ flash completed
  42s   ❌ kernel panic detected → serial:last-200-lines [Enter 展开]
  300s  ⏹ run ended

📋 对比: init 阶段耗时 28.5s，比 baseline 慢 56%。
   建议: 检查 init 启动顺序。上次 Run-038 类似 panic，是 initrc 依赖顺序问题。
```

---

## 3. 用户

面向嵌入式/内核/驱动开发者。

- 看得懂调用栈、信任原始证据、不信任 LLM 摘要
- 需要信息密度高、细节可钻、快捷键直达
- 不需要 wizard、不需要"简化版"

---

## 4. 核心场景

### 场景A：验证镜像能否启动

```
人: va validate --artifact boot.img --target board-01
      --expected "设备能正常启动，ADB 能回来"

系统:
  1. Pre-flight 检查 Target 连接
  2. 发现 Target dirty → 自动恢复
  3. 刷 boot.img
  4. 盯串口 180s（重点看 kernel panic）
  5. 等 ADB 上线
  6. 跑 smoke_test
  7. 收集 dmesg
  8. 出结果

看到的:
  ✅ "验证通过。ADB 在 32s 上线。启动耗时 42s (baseline 40s, +2s, 正常范围)。"
  ❌ "启动 42s 后 kernel panic。崩溃位置: init 进程。..."
```

### 场景B：长期压测监测

```
人: va validate --continuous --duration 4h --observe-interval 5m
      --observe-metrics "memory,cpu,latency"
      --expected "4 小时内无崩溃、无内存泄漏"

系统:
  - 每 5 分钟采样: 输出速率、内存/CPU/延迟、错误率
  - Observer(弱模型) 每 5 分钟分析趋势，对比 baseline
  - 发现异常趋势 → 告警 / 调密检查频率 / 停

运行中:
  "压测 1h/4h。当前正常。内存较起始 +8%。"
  "第 35 分钟起内存持续增长。较 baseline 高 25%。建议关注。"
```

### 场景C：定时回归

```
人: va task create --name "nightly" --cron "0 2 * * *" --skill validate-boot
系统: 每天凌晨 2 点自动跑。结果推 Slack。
```

### 场景D：Coding Agent 通过 MCP 调用

```
1. validate_artifact(context, artifact, target, constraints) → { run_id, state }
2. watch_run(run_id, after_seq) → { events, next_after_seq }
3. get_run_result(run_id) → { status, summary, key_evidence, suggested_next }
4. 需要时 get_evidence(run_id, ref)
```

### 场景E：运行中自动发现并停

```
串口出现 kernel panic:
  → 规则命中(fatal) → 毫秒级反射，直接 stop
  → 切证据窗口(前 200 行 + 后 80 行) + 收集 dmesg
  → Run failed → 翻译成人话
```

### 场景F：不确定的情况等 LLM

```
串口静默 60s:
  → Rule Detector 命中 silence(warning)
  → Observer(弱模型) 分析上下文: "boot 阶段，ADB 还没回来，剩余时间够"
  → Decision: extend_wait 30s
```

### 场景G：跨源关联发现复合异常

```
serial + dmesg + logcat 三个源同时指向 foo_service crash
→ Aggregator 关联为 CorrelatedSignal
→ Observer: "foo_service crash 被 3 个源同时检测到" → Decision(stop)
```

### 场景H：人中途干预

```
va pause / resume / cancel --run-id
va intervene --run-id --instruction "检查 dmesg 有没有 foo error"
va ignore-rule --run-id --rule-id foo_error
va override --run-id --decision continue
```

### 场景I：记住已知坑

```
第 1 次: dmesg 出现 "foo error" → 失败。人确认已知无害 → va memory add
第 2 次: 自动忽略 → 继续执行
```

### 场景J：跨 Run 学习

```
Run-001/002: board-01, wait_adb 180s → timeout → failed
Memory: "board-01 启动慢，wait_adb 至少 200s"
Run-003: Planner 查 Memory → wait_adb 设 200s → 成功
```

### 场景K：设备掉线自动暂停

```
串口断开 → Run → paused → 人重连 → resume → 继续
```

### 场景L：失败重试

```
flash 失败(USB 松动) → 自动重试 2s/5s/10s → 成功 → 继续
同类型失败 3 次 → "可能是硬件问题" → 通知 Slack → 停止重试
kernel panic → 不重试 → 镜像有问题
```

### 场景M：环境恢复

```
上次 Run 被 cancel → Target dirty
这次 Run 前 → recovery: 重启/重刷稳定版 → 验证 → 开始
恢复失败 → Target offline → 通知人
```

### 场景N：Runtime 崩溃恢复

```
Runtime 重启 → 加载非终态 Run + Target 状态
→ running 且无后续 Event → failed(crashed)
→ planning → 重新 Planner 或 failed
→ Target stale 锁 → 释放
→ View 从 Event Store 重建
```

### 场景O：多设备并发

```
同一 Target 从 planning 到 cleaning 全程锁定，不会并发冲突
不同 Target 可同时跑。人不指定 Target → 自动选 idle
```

### 场景P：Hook 拦截危险操作（新）

```
团队配了一个 PreStepExecute hook: flash 前检查 bootloader 版本
某次验证: 镜像要求 bootloader v2.0，但设备是 v1.2
→ Hook 返回 block → Run → paused，原因: "bootloader 版本不匹配"
→ 通知 Slack: "board-01 flash blocked by hook: bootloader version mismatch"
→ 人等 → 升级 bootloader → resume 或 cancel
```

### 场景Q：熔断保护（新）

```
Observer 连续 3 次说 stop → 人连续 3 次 override "不对，继续跑"
→ 系统标记 "自动决策失效"
→ 后续 Observer 只出 suggest，不再自动 stop
→ "自动 stop 已禁用。后续决策请手动确认。"

Warning 累计 5 个不同规则命中 → 升格 → "建议 stop"
（不自动停因为 warning 不是 fatal。让人判断。）
```

### 场景R：LLM 降级保护（新）

```
Observer LLM 连续 3 次超时
→ 自动切到纯规则模式（fatal→stop，其他→continue）
→ "Observer LLM 暂时不可用。正在使用规则模式。"

Planner LLM 也超时 3 次
→ 自动使用默认 Plan 模板
→ "Planner LLM 暂时不可用。正在使用默认验证流程。"

LLM 恢复后 → 自动切回正常模式。
```

### 场景S：自定义 Hook 扩展（新）

```
团队写了 ./scripts/collect-extra-logs.sh:
  在 Run 失败时自动收集 /var/log 下的所有日志，打包存到 evidence 目录。

配一个 Hook: OnFailure → ./scripts/collect-extra-logs.sh {{evidence_root}}
系统: Run failed 后自动执行 → 额外日志进入 evidence → 不需要改 Runtime 代码。
```

---

## 5. Agent 怎么判断

### 观测六层

```
第一层: 单行匹配      grep 关键词 + 语义变体                    Rule Detector
第二层: 单源时序      输出速率 / 阶段识别 / 静默 / 输出模式      Aggregator
第三层: 跨源关联      同窗口多源指向同实体                        Aggregator
第四层: 因果链        Event 序列 → 根因推断                       Observer(LLM)
第五层: 基线对比      当前指标 vs 历史 RunProfile                 Aggregator + Memory + Observer
第六层: 主动采样      周期查 /proc、ps、df 等系统状态            Step Executor + Aggregator
```

前一到三层确定性，不走 LLM。产出 Signal。Observer 只看 Signal + 窗口，不看全量日志。

### 决策三层

```
第一层: 确定性反射 (毫秒级, 不走 LLM)
  kernel panic → 直接 stop

第二层: LLM 决策 (秒级, 弱模型)
  事件驱动: "串口静默 60s" → Observer 结合上下文判断
  周期驱动: checkpoint → Observer 分析趋势

第三层: 人覆盖 (最高优先级)
  pause/resume/cancel → 直接执行
  add_instruction → Observer 参考
  override_decision → 纠正 Agent
```

### 模型分层

```
Planner:  强模型，1次/Run。把人的描述转成结构化 Plan
Observer: 弱模型，高频。每次 Event + 每次 checkpoint
Reply:    强模型，1次/Run。从 Event 和 Evidence 提取关键信息
```

高频用便宜模型，低频用强模型。Prompt 静态部分缓存 → 每次调用成本更低。

### 熔断保护（新）

```
系统在无人值守时防止无限循环和反复犯错:

Observer 覆盖计数器:  连续 3 次 stop 被 override → 只 suggest，不自动 stop
Step 重试同因检测:    同类型失败 3 次 → hardware_issue，停止重试
Warning 累加器:       5 个不同 warning → 升格为建议 stop
LLM 降级器:           同角色连续 3 次超时 → 切换纯规则模式，LLM 恢复后自动切回
```

---

## 6. 扩展能力（新）

### Hook 系统

```
不修改 Runtime 代码就能扩展行为。Hook 是人配的 shell 脚本，在事件点自动执行。

8 个事件点:
  PreRunStart, PostRunEnd                          ← Run 前/后
  PreStepExecute, PostStepComplete, PostStepFailed ← Step 前/后
  OnStopDecision, OnFailure                        ← 决策/失败时
  RuntimeStart                                     ← 系统启动时

Hook 可以:
  - 通过: 继续执行
  - 阻止: Run → paused。等人介入。
  - 重试: 再执行一次
  - 附加信息: 输出文本注入当前上下文

例子:
  PreStepExecute(flash) → ./scripts/pre-flash-check.sh
    → block → "bootloader 版本不匹配" → Run paused → 通知人
  
  OnFailure → ./scripts/collect-extra-logs.sh
    → 自动收集额外日志到 evidence 目录

  PostRunEnd(failed) → ./scripts/notify-team.sh {{run_id}}
    → 自定义通知（替代或补充系统 Slack 通知）
```

### Prompt 缓存

```
系统 prompt（身份、能力目录、输出格式）静态不变 → LLM API 缓存命中
每次 Run 只在 user message 侧替换动态上下文（Request、Target、Memory）
→ 成本显著降低、延迟显著下降
```

---

## 7. 人机交互原则

### 原始证据第一，LLM 在旁边

```
机器输出: "[41.5s] Kernel panic - not syncing: Attempted to kill init!"
Reply 提取: "kernel panic @ 42s, init 进程 (CPU0, PID1)"
            "调用栈: dump_backtrace → panic → do_exit"
LLM 在旁边: "可能是 init 模块问题。慢 56% vs baseline。"
原始证据: serial:last-200-lines (42KB, Enter 展开)
```

### 分层展示

```
第一层: 一句话（过没过、原因）
第二层: Timeline + 关键输出窗口
第三层: LLM 提取的关键信息 + 对比 + 建议
第四层: 原始证据（Enter 展开）
```

### TUI

```
┌──────────────────────────────────────────────────────────┐
│  Embed Agent                                             │
├──────────────────────────────────────────────────────────┤
│  Run #042  board-01  boot.img (v2.1.3)  ❌ failed       │
│                                                          │
│  ── Timeline ──────────────────────────────────────────  │
│  0s    ✅ flash                    2.1s                 │
│  42s   ❌ kernel_panic                                   │
│          [41.5s] Kernel panic - not syncing:            │
│          serial:last-200-lines [Enter 查看]              │
│                                                          │
│  ── Analysis ──────────────────────────────────────────  │
│  init 慢 56% vs baseline。Run-038 类似修复。              │
│                                                          │
│  [e] evidence  [r] raw  [d] dmesg  [q] back             │
└──────────────────────────────────────────────────────────┘

主视图:
┌──────────────────────────────────────────────────────────┐
│  Embed Agent                                        ⚡🟢 │
├──────────────────────────────────────────────────────────┤
│  Runs:  #042 ❌ failed    #043 ⏳ running (28s)         │
│  Targets: board-01 🟢 idle    board-02 🟡 busy          │
│  Tasks: nightly-boot-check ⏰ next: 02:00               │
│  Cost: $1.42 / Observer cache hit 94%                   │
│                                                          │
│  [Enter] select  [p] pause  [c] cancel  [q] quit        │
└──────────────────────────────────────────────────────────┘
```

---

## 8. 命令清单

```
验证 & 执行
  va validate              一次性验证
  va run --skill            直接跑 Skill
  va task create/ls/pause/resume/delete

查询
  va status --run-id        Run 状态
  va watch --run-id         实时盯 Run
  va events --run-id        历史事件
  va result --run-id        最终结果
  va evidence --run-id      证据索引/内容

干预
  va pause / resume / cancel --run-id
  va intervene --run-id --instruction "..."
  va ignore-rule --run-id --rule-id
  va override --run-id --decision continue

知识
  va memory add / ls / confirm / delete

技能
  va skill list / show / create

设备
  va target add / ls / show / remove

Hook
  va hook list / show / test

导出
  va export / import
```

---

## 9. MCP Tool 清单

```
validate_artifact        发起验证
get_run_status           查询 Run 状态
watch_run                轮询新事件
get_run_events           读历史事件
get_evidence             读证据索引/内容
get_run_result           读最终结果
intervene_run            干预 (pause/resume/cancel/add_instruction/override)
cancel_run               取消
get_target_capabilities  查询 Target 能力
```

---

## 10. 配置清单

```
Target Profile:  怎么连、怎么刷、设备特性、安全约束、恢复策略、专属 Skill

LLM Config:      provider、planner/observer/reply 各用什么模型、timeout

System Config:   阈值、RulePolicy、重试策略、ring buffer、Aggregator 阈值、
                 存储保留、通知 (Slack/邮件)、安全白名单

Hook Config:     事件点 → shell 脚本。不进 Runtime 代码。yaml 配置。
```

---

## 11. 不做的事

- 不改代码、不修 bug、不生成 patch
- 不推断代码根因
- 不让 LLM 直接执行设备命令
- 不做 CI/CD 流水线
- 不做 board farm
