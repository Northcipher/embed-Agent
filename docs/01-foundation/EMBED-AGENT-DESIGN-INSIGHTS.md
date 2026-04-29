# Embed Agent 设计洞见

> 状态：Draft
> 日期：2026-04-29
> 目的：记录架构设计过程中的关键判断和思考。不是规范文档，是"为什么这么设计"。

## 1. 本质上在解决什么问题

```
不是"造一个 agent"。agent 是手段。

本质是: 把工程师盯设备的重复劳动自动化。

工程师做的事:
  刷机 → 盯串口(grep) → 看趋势(watch) → 跨源翻日志 → 
  推理因果 → 对比历史 → 查系统状态 → 写结论

系统做的事:
  一样的。而且可以定时跑、持续跑、自动响应。
```

---

## 2. 为什么 Connection 是接口而不是按功能建类

```
ADB / Serial / SSH / Fastboot / Local 的执行流程一样:
  连接 → 执行 → 读输出 → 写证据 → 检测 → 发事件

差异只在"怎么连接"和"怎么执行"。

如果按功能建 Adapter 类:
  SerialAdapter: 打开→读→写证据→检测→写事件→关闭 (200 行)
  AdbAdapter:    subprocess→读→写证据→检测exit→写事件 (200 行)
  FlashAdapter:  subprocess→读→写证据→写事件            (150 行)
  → 重复逻辑四套

如果 Connection 是接口:
  Connection: exec / stream / push / flash
  OutputPipe: writeEvidence + detect + emit (所有 Connection 共用)
  → 重复逻辑 0
```

---

## 3. 为什么 Rule Detector 不做 Decision

```
Rule Detector 是 grep。它只负责"看到了什么"。

"看到了 kernel panic" → 出 Event(keyword=kernel_panic)
"该怎么办" → 不是 Rule Detector 的事。

Decision 在 Decision Handler。来源有三:
  - Rule(反射): fatal → 直接 stop，不走 LLM
  - Observer(LLM): 不确定 → LLM 判断
  - Human(覆盖): 人说了算

好处:
  - Rule Detector 可以只有一个职责: 检测。简单，可测试。
  - 什么算 fatal、什么算 warning 由 RulePolicy(配置)决定。
  - LLM 决策和规则决策互不干扰。
```

---

## 4. 为什么 Observer 不看全量日志

```
4 小时压测的 serial.log 可能是几百 MB。
LLM context window 装不下，就算装得下也太贵、太慢。

人看日志的方法:
  不是从第一行读到最后一行。
  是 grep 关键词 → 看前后文 → watch -n 看趋势 → 感觉不对才细看。

对应到系统:
  grep 关键词        → Rule Detector (实时，毫秒)
  watch -n 看趋势    → Aggregator (周期采样，统计)
  感觉不对才细看     → Observer 看 Signal + evidence window

Observer 拿到的是:
  - 单行匹配的结果 (RuleMatched Event + window)
  - 时序统计的结果 (Checkpoint: 速率、趋势、指标)
  - 跨源关联的结果 (CorrelatedEvent)
  - 基线对比的结果 (BaselineDiff)
  - 历史上下文 (Memory)

不是全量日志。是 Signal 摘要。
```

---

## 5. 为什么弱模型做 Observer，强模型做 Planner

```
Observer:
  - 调用频率高 (每次 event + 每次 checkpoint)
  - 判断逻辑: "有问题/没问题/不确定" + "什么趋势"
  - 输入小 (Signal + window)
  - 延迟敏感 (不能等 10 秒才决定是否继续)
  → 弱模型 (haiku / flash)，快且便宜

Planner:
  - 一次 Run 只调一次
  - 需要理解复杂需求 + 匹配 Skill + 查 Memory + 组合能力
  - 输出是完整的结构化 Plan
  → 强模型 (sonnet / opus)，值得

Reply:
  - 一次 Run 只调一次
  - 归纳几百条 Event 和多个 Evidence，提取关键
  → 强模型
```

---

## 6. 为什么 grep 不是全部，六层观测才是核心价值

```
grep 能找到 "kernel panic @ 42s"。
grep 找不到:
  - init 阶段比正常慢了 56%
  - foo_service 的异常导致了 20s 后的 kernel panic
  - serial + dmesg + logcat 同时指向同一个服务 crash
  - /proc/slabinfo 里 foo_kmem_cache 从 17MB 涨到 120MB
  - 同一种 known_issue 的变体 ("error reading backup config file")

六层观测:
  1. 单行匹配        grep (Rule Detector)
  2. 单源时序        输出速率、阶段耗时、输出模式 (Aggregator)
  3. 跨源关联        同窗口多源命中同实体 (Aggregator)
  4. 因果链          Event 序列 → 根因推断 (Observer)
  5. 基线对比        当前指标 vs 历史 RunProfile (Aggregator + Memory)
  6. 主动采样        周期查系统状态 (Aggregator + Connection)

前一到三层确定性，不走 LLM。产出 Signal 给 Observer。
Observer 只做推理，不看全量日志。
```

---

## 7. 为什么决策分三层

```
第一层: 确定性反射 (毫秒级)
  kernel panic → 不用想，就是 fatal → 直接 stop
  不需要 LLM 确认。

第二层: LLM 决策 (秒级)
  "串口静默 60s" → 是卡死还是正常等待？
  取决于上下文: 在 boot 阶段还是在稳定阶段、ADB 在不在、还剩多少时间
  规则判断不了 → LLM

第三层: 人覆盖
  人看了 Observer 的判断: "不对，这不是问题。"
  → override_decision → continue
  或者 add_instruction → Observer 参考
```

---

## 8. 为什么 Target Manager 状态机比 idle/busy/offline 复杂

```
之前只有: idle / busy / offline

实际上:
  Run 开始前 → 需要准备 (preparing)
  上次 Run 崩溃了 → 板子有残留 (dirty)
  需要恢复 → recovery
  清理 → cleaning
  恢复失败 → offline

状态机:
  idle → preparing → busy → cleaning → idle
  busy → dirty (崩溃)
  dirty → recovery → preparing (恢复)
  recovery 失败 → offline

不诚实的状态管理 → 下次 Run 在脏板子上跑 → 结果不可信。
```

---

## 9. 为什么 Event Bus 只通信不持久化

```
Event Bus 是通信设施，不是存储设施。

如果 Event Bus 自己持久化:
  - 耦合: 通信和存储绑在一起
  - 无法替换存储后端
  - 测试困难

如果 Store 订阅 Event Bus 自己存:
  - 解耦: Event Bus 只管发，Store 管存
  - 换存储不用动 Event Bus
  - Store 可以单独测试
```

---

## 10. 为什么 Planner 的输入需要预组装

```
Planner 需要: Target capabilities + hints + constraints + skill + memory

如果 Planner 自己翻 Target Profile 找这些信息:
  - Planner 和 Target Profile 结构耦合
  - Target Profile 结构变了，Planner 也要改
  - 测试时要 mock 整个 Target Profile

如果 Runtime 预先组装好 AssembledContext:
  - Planner 只依赖 Context 接口
  - Target Profile 变化不影响 Planner
  - 测试时只 mock Context
```

---

## 11. 为什么 LLM 是提取器不是总结器

```
总结器:
  把 80MB serial.log 总结成 "启动 42s 后 kernel panic"
  原始证据没了。人不信任。

提取器:
  从几百条 Event 和 Evidence 中提取:
    - kernel panic @ 42s, 调用栈: dump_backtrace → panic → do_exit
    - 证据: serial:last-200-lines (42KB, 可展开)
    - init 阶段慢了 56% vs baseline
    - 建议: 检查 initrc 依赖。Run-038 类似修复点。

  原始证据引用都存在。人想看就展开。
  LLM 分析在旁边供参考。
```

---

## 12. 为什么 Memory 要存 RunProfile 不只是 Episode

```
Episode: 自然语言摘要。人看得懂，机器不好用。

RunProfile: 结构化指标。
  { stage_durations: { bootloader: 4.1s, kernel: 13.1s, ... },
    metrics: { memory_mb: 120, cpu_pct: 30, ... },
    output_profile: { lines_per_sec_per_stage: {...} } }

作用:
  - 新的 Run → Aggregator 实时对比 baseline → Signal
  - 不需要 LLM 去理解"快了还是慢了"，直接给数字
  - 跨 Run 对比不需要读 Episode，直接读数字
```

---

## 13. 为什么串口 stream 和 ADB exec 处理不同

```
SSH/ADB exec:
  发命令 → 等结束 → 一次性拿到 stdout/stderr/exitCode
  处理: 逐行 pattern 检测 + exit_code 检测 + 写 Evidence

Serial stream:
  打开串口 → chunk 持续来 → 没有"结束"的概念
  处理:
    - chunk 可能不是完整行 → 需要行拼接
    - 需要 ring buffer → 命中时切窗口
    - 需要 silence timer → 检测静默
    - 需要 Aggregator 持续采样 → 统计输出速率和阶段
    - 可能随时断开 → 需要检测

OutputPipe 内部处理两种模式的所有差异。
Step Executor 和 Observer 不需要知道底层是 Serial 还是 ADB。
```

---

## 14. 为什么不用"极简"而是"信息密度高"

```
面向开发者，不是面向普通用户。

开发者:
  - 看得懂调用栈
  - 需要看到全貌，不是被简化后的"一句话"
  - 信任原始证据，不信任 LLM 摘要
  - 需要快捷键直达内容，不需要 wizard

TUI 设计:
  Timeline 是主角（一眼看到全部过程）
  原始输出是主角（关键窗口直接展示）
  LLM 分析在旁边（小字，供参考）
  Enter 展开原始证据，[d] 看 dmesg，[q] 退出

不是"简单"。是"快"。
```

---

## 15. 为什么配置一次复用，不是每次从头问

```
不是: 每次验证时问 "串口在哪？波特率多少？怎么刷？"
而是: 人配好 Target Profile，Agent 每次自己读。

人配一次:
  Target Profile: 怎么连 / 怎么刷 / 能做什么 / 设备特性
  LLM Config: 用什么模型
  System Config: 阈值 / 存储 / 通知
  Skill: 常用的 Step 模板

Agent 每次:
  Planner 查 Target 能力 + Skill + Memory → 生成 Plan
  Observer 查 Target hints(know_quirks) + Memory → 判断
  Connection Manager 查 Target connections → 连接设备
```

---

## 16. 顶层设计的取舍

```
选了:
  Event-first           所有事实先变成 Event
  Connection 是接口     不按功能建类
  六层观测              grep → 时序 → 跨源 → 因果 → 基线 → 采样
  决策三层              反射 / LLM / 人
  模型二层              高频弱模型 / 低频强模型
  配置一次复用          人配 Target Profile，Agent 每次用
  Agent 不碰执行        Planner/Observer 只产 Decision
  原始证据优先          LLM 在旁边，不替代

没选:
  多 Agent 协作         Planner/Observer/Reply 分工已够。不需要 handoff
  插件系统              Skill 模板 + YAML 配置已够
  Board Farm            P0 不做，不是核心瓶颈
  复杂权限              P0 开发者自己管
  LLM 直接控设备        绝对不。安全边界
```

---

## 17. 和上一版原型的关键差异

```
原型:
  - 8 个 Adapter 类，重复四套逻辑
  - Rule 嵌在 PlanExecutor 里
  - Observer 在 Run 结束才调用
  - 没有 Decision Queue / Aggregator / Memory
  - LLM output 不执行 (observer intent 写了但没实现)
  - Target state 是推断的，不是真实检测

现在:
  - Connection 接口 + OutputPipe 统一处理
  - Rule Detector 独立，只出 Event
  - Observer 运行中消费 Event + Checkpoint → 实时 Decision
  - Aggregator 周期采样 → 六层观测
  - Memory 从第一天预留 → 已知坑 + baseline
  - Target Manager 生命周期完整 → 环境诚实
```

---

## 18. 什么不变

```
Event-first          这是 backbone。所有决策和状态都从 Event 来。
Runtime owns execution 只有 Runtime 能把 Decision 变成 Step 并执行。
Tool 不决策           执行者不判断。
Agent 不执行          决策者不动手。
原始证据不丢          LLM 是辅助，不是替代。
```
