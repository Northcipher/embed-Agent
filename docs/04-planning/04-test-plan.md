# 测试计划

> 状态：Draft / 日期：2026-04-29

## 1. 三层测试策略

```
单元测试:  纯逻辑组件。Mock 外部边界。快速 (< 100ms/case)。
集成测试:  多组件协作。FakeConnection 模拟设备。完整 Run。
系统测试:  真实设备 + 固定镜像。已知结果验证。
```

## 2. 单元测试用例 (按模块)

### 2.1 RuleDetector

```
✅ pattern: 命中 → RuleMatched Event, severity=fatal, evidence_refs 有窗口
✅ pattern: 未命中 → 无 Event
✅ pattern: 多条 rule 同时命中 → 每条都出 Event
✅ silence: 60s 无 feed → RuleMatched(severity=warning)
✅ silence: feed 后重置 timer → 不触发
✅ silence: stream disconnect → 不触发 (不是静默，是断开)
✅ exit_code: 0 → 无 Event (expected=0)
✅ exit_code: 1 → RuleMatched (expected=0)
✅ semantic: known_issue 变体 pattern → 命中但 severity=info
✅ Step 级 pattern: loadStepPatterns → 生效。clearStepPatterns → 失效
```

### 2.2 Aggregator

```
✅ 阶段识别: boot_markers 匹配 → StageTransition
✅ 阶段识别: 无 boot_markers → stage="unknown" → 无 StageTransition
✅ 输出模式: 0 lines/sec → silence
✅ 输出模式: rate > 3x baseline → burst
✅ 输出模式: 5 window 持续下降 → gradual_decline
✅ 跨源关联: 3 源+PID → Correlated(severity=fatal)
✅ 跨源关联: 2 源+进程名 → Correlated(severity=warning)
✅ 跨源关联: 1 源 → 不关联
✅ 基线对比: 偏离 25% → BaselineDiff(severity=warning)
✅ 基线对比: 偏离 55% → BaselineDiff(severity=fatal)
```

### 2.3 DecisionHandler

```
✅ fatal event → 直接 stop。不调 Observer
✅ warning event → debounce 通过 → 调 Observer
✅ warning event → debounce 命中 → 跳过
✅ Observer 返回 stop → DH 执行 stop
✅ Observer 返回 collect_more → DH 追加 Step
✅ Decision 校验失败 → 拒绝。发 decision_rejected
✅ CB1: override 3次 → 只 suggest, 不调 Observer
✅ CB3: 5 个不同 warning → Observer 收到 warningEscalation=true
```

### 2.4 RunManager

```
✅ createRun: Plan 校验通过 + Pre-flight 通过 → Run(running)
✅ createRun: Plan 校验失败 → finalizing → Reply.generateMinimal → result_ready(status=failed) → run_failed
✅ createRun: Pre-flight 失败 → finalizing → Reply.generateMinimal → result_ready(status=failed) → run_failed
   验收: result_ready payload 含 failure_reason + evidence_path。RunProfile 仍存。
✅ createRun: Target busy → target_busy
✅ pause → Run(paused) + interrupt + RunPaused Event
✅ resume → Run(running) + RunResumed Event
✅ cancel → finalizing → Reply.generateCancelled → result_ready(status=cancelled) → run_cancelled
✅ Target 断开 → Run(paused)
```

### 2.5 StepExecutor

```
✅ exec Step → Connection.exec() → OutputPipe.feedExec → StepCompleted
✅ stream Step → Connection.stream() → 逐行 feedStream → StepCompleted
✅ 中断: interrupt → StepFailed(interrupted)
✅ 重试: flash 失败 → retry → 成功 → StepCompleted
✅ 重试: 同类型 3 次失败 → StepFailed(possible_hardware_issue)  [CB2]
✅ 超时: timeout → StepFailed(timeout)
✅ 采样子动作: checkpoint_interval → exec samplingCommands → metrics (需 Aggregator+OutputPipe 协作)
```

### 2.6 CircuitBreaker

```
CB1: 同 Run 内 override 3 次 → isActive=true
CB1: 新 Run → 新实例 → isActive=false
CB2: 同 Step 同类型 3 次 → shouldRetry=false
CB2: 新 Step → 新实例 → 重置
CB3: 5 个不同 rule_id → isEscalated=true
CB3: 新 Run → 新实例 → 重置
CB4: 同 role 3 次 LLM 失败 → isDegraded=true
CB4: 5 分钟后 → isDegraded=false (探测)
CB4: 探测成功 → recordSuccess → 恢复
CB4: 探测失败 → 再等 5 分钟
```

### 2.7 HookManager

```
✅ PreStepExecute: block → Run(paused)
✅ PreStepExecute: proceed → 继续执行
✅ OnStopDecision: block → pause (不 stop)
✅ OnFinalizing: proceed → 补采完成 (不改结局)
✅ Hook 超时 → proceed。记审计。
✅ Hook 返回值非法 → 忽略。proceed。
✅ Hook 成功 → HookExecuted Event (含 decision + duration_ms)
✅ Hook 失败 → HookExecuted Event (含 error)
```

### 2.8 Observer

```
✅ rule_matched(warning) → 分析 Signal+window → Decision
✅ checkpoint(warning) → 分析趋势+历史 → Decision
✅ LLM 成功 → 返回完整 Decision JSON (含 reasoning_trace)
✅ LLM 超时 → fallback: fatal→stop, others→continue
✅ known_issue 匹配 → continue (语义变体)
✅ circuitBreakerActive=true → 只出 suggest
✅ warningEscalation=true → suggest(recommend_stop)
```

### 2.9 Memory

```
✅ writeWorkingMemory/readWorkingMemory → 同 Run 内读写
✅ recordEpisode → 持久化。recallEpisodes → 按 target 查询
✅ writeFact/queryFacts → 按 scope/category 查询
✅ confirmFact → verified=true
✅ recordRunProfile/getLatestProfile → 按 target 查询最新
```

### 2.10 ReplyGenerator

```
✅ generate (LLM 成功) → AgentReply + Episode + RunProfile
✅ generateMinimal → 规则摘要 + Episode(最小) + RunProfile
✅ generateCancelled → 取消摘要 + Episode + RunProfile
✅ LLM 失败 → fallback 规则 → 仍存 RunProfile
```

---

## 3. 集成测试 (FakeConnection)

```
FakeConnection:
  - 预设 stdout/stderr/exitCode
  - 预设 stream 输出序列
  - 模拟 disconnect

用例:
  ✅ 完整 boot 验证: flash → stream(有 kernel panic) → stop → evidence
  ✅ 完整 boot 验证: flash → stream(正常) → wait_adb → smoke_test → completed
  ✅ Pre-flight 失败: serial 打不开 → target_not_ready
  ✅ Plan 校验失败: 包含不存在的 capability → plan_rejected
  ✅ Observer 决策: serial silence → extend_wait → 继续
  ✅ long run: 4 个 checkpoint → Observer 趋势分析
  ✅ Target 断开 → 自动 pause → 重连 → resume → 继续
  ✅ 运行中 cancel → finalizing → result_ready(cancelled) → evidence 保留 → RunProfile 存
  ✅ Host 崩溃恢复: 模拟 running Run → 重启 → failed(crashed)
  ✅ Memory 学习: 连续 2 次 wait_adb timeout → 第 3 次 Planner 自动设更长 timeout
```

---

## 4. 系统测试 (真实设备)

```
前置: 一块 board-01 + 已知正常镜像 + 已知失败镜像

用例:
  ✅ 正常 boot: 正常镜像 → completed
  ✅ kernel panic: 失败镜像 → 自动 stop + serial window + dmesg
  ✅ 串口静默: 失败镜像 → Observer extend_wait
  ✅ 持续监测: 正常镜像 + continuous 30min → Run 仍处于 running。
   每 checkpoint_interval 产出 Checkpoint + metrics。
   人为 stop 后才进入 finalizing → result_ready → completed/failed。
   RunProfile 包含 30min 内所有 checkpoint metrics。
  ✅ Pre-flight: 拔掉串口 → target_not_ready
  ✅ 环境恢复: 模拟 dirty → recovery → clean → 新 Run 正常
  ✅ 运行中取消: cancel → result_ready(cancelled) → evidence 保留 → Episode/RunProfile 存
  ✅ 定时任务: Cron 触发 1 次 → completed
```

---

## 5. 验收标准

```
M1 验收:
  - 手写 Plan 跑通完整的 flash → stream → exec → 出结果
  - FakeConnection + 真实 File Store
  - RuleDetector 正确检测 kernel panic 并 stop
  - Evidence (serial.log, dmesg.log) 完整保留
  - 状态机: planning → running → collecting_evidence → finalizing → completed/failed

M2 验收:
  - 人一句话 → Planner 生成 Plan → 执行 → Observer 决策 → Reply 出结果
  - Memory: Episode 自动保存。下一个 Run Planner 能查到历史
  - Skill: 人指定 --skill validate-boot → 跳过 Planner 直接跑
  - 熔断: override 3 次 → Observer 只 suggest
  - LLM 降级: mock LLM 失败 3 次 → fallback 模式

M3 验收:
  - CLI: embedagent validate/status/watch/result/evidence 全部可用
  - MCP: validate_artifact/watch_run/get_run_result 全部可用
  - TUI: Run 列表 + Target 列表 + 实时 Timeline
  - Hook: PreStepExecute block → Run paused
  - 通知: result_ready(status=failed) → Slack 通知（含 reply.summary + evidence_path）
        run_failed 审计事件 → 不触发通知。验证无重复。
  - 定时: Cron 创建/触发/列表/暂停/恢复
  - 崩溃恢复: 模拟崩溃 → 重启后 Run 诚实 failed
```
