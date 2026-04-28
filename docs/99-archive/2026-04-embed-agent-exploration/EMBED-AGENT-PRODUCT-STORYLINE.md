# Embed Agent 产品故事线（一页读懂版）

> 状态：Draft
> 日期：2026-04-28
> 目的：把现有产品、架构、设计、调研和实施文档压缩成一条可以快速对齐团队的故事线，方便新读者先建立整体心智，再进入细节文档。

> 当前状态：背景参考。本文包含旧口径，尤其是远端 build、push-only 首链、verdict candidate 和确认流程等内容。当前正式口径以 [EMBED-AGENT-ROLE-MODEL.md](EMBED-AGENT-ROLE-MODEL.md)、[EMBED-AGENT-SCENARIOS-AND-CALLS.md](EMBED-AGENT-SCENARIOS-AND-CALLS.md)、[EMBED-AGENT-FUNCTION-LIST.md](EMBED-AGENT-FUNCTION-LIST.md) 和 [EMBED-AGENT-FIRST-SLICE.md](EMBED-AGENT-FIRST-SLICE.md) 为准。

## 1. 一句话

`Embed Agent` 不是另一个通用 coding agent，也不是另一个聊天壳。  
它是一个面向嵌入式研发与验证闭环的 runtime。

一句人话：

```text
Codex / Claude Code 管代码和修复，
Embed Agent 管设备现场、执行、状态、证据和恢复。
```

## 2. 这件事为什么成立

今天的嵌入式开发不是没有工具，而是工具太碎：

- 代码有人能改
- 设备有人能连
- 构建有人能跑
- 刷机、推包、串口、ADB、SSH 都各有办法
- 日志也能抓

但一旦把这些东西放进真实研发闭环，问题就出现了：

- 改完代码后，真机验证很碎，每次都像重新拼一遍现场
- 长任务、偶发问题、黑卡死很容易丢证据
- 通用 coding agent 会写代码，但不会稳定管理真实设备
- 自动化脚本能跑一次，却很难复用、交接和规模化

所以机会不在“再做一个工具”，而在把这些碎片收成一条稳定闭环：

```text
绑定代码版本
-> 选择目标
-> build
-> deliver
-> debug / watch
-> collect evidence
-> give verdict
-> hand off to next repair
```

## 3. 产品到底在卖什么

`Embed Agent` 真正卖的不是“AI 很聪明”，而是四个结果：

- 更快进入一次真实设备验证
- 更少重复配置和重复劳动
- 更快抓住失败现场并进入下一轮修复
- 人和 coding agent 都能围绕同一份 evidence 继续工作

所以它的产品定义应该是：

> 一个把通用 coding agent 接到真实嵌入式现场上的验证 runtime。

它补的不是代码编辑能力，而是通用 agent 最弱的一段：

- 真实设备连接
- 长任务执行和观察
- 失败现场保存
- 证据打包和交接
- 恢复动作和最小执行保护

## 4. 文档里反复在强调的边界

这套文档最重要的收口，不是功能，而是边界。

### 4.1 我们做什么

- 做 `Case / Run / Target / Evidence / Verdict` 这套对象
- 做真实目标连接、长连接、重连和健康状态
- 做 build、flash / push / ota、debug、watch 主链路
- 做 evidence package、failure snapshot、repair handoff
- 做对外 `CLI / MCP / Console` 入口
- 做最小执行保护：preview、confirm、audit

### 4.2 我们不做什么

- 不做另一个通用代码助手
- 不做另一个纯聊天工作台
- 不做只会调工具的一层 MCP 壳
- 不做第一版审批系统
- 不做第一版完整实验室治理平台

这条边界非常关键，因为它把故事从“AI 壳 + 工具集合”拉回到“嵌入式验证 runtime”。

## 5. 整个系统的角色分工

所有文档都在强调五层模型：

```text
Human
-> Coding Agent
-> Embed Agent Runtime
-> LLM Worker
-> Toolchain / Real World
```

对应职责是：

- `Human`：定目标、定边界、做高风险动作拍板、收最终结果
- `Coding Agent`：读代码、改代码、触发验证、消费 evidence、继续修复
- `Runtime`：管理 case、run、target、reservation、连接、执行、证据和审计
- `LLM Worker`：做日志去噪、摘要、相似案例和 verdict candidate
- `Toolchain / Real World`：真正执行 build、flash、push、ADB、SSH、Serial、Probe、电源控制

核心纪律只有三条：

- 不把外部 coding agent 和内置 LLM worker 混成一个东西
- 不让 LLM 保管事实状态
- 不让人继续做系统本该兜住的体力活

## 6. 为什么 Runtime 是产品中心

这套文档最统一的一件事，是把系统中心定成了 `Embed Agent Runtime`。

不是 CLI。  
不是 MCP。  
也不是 Console。

它们都只是入口。

只有 runtime 持有：

- 统一对象
- 统一状态
- 统一证据
- 统一恢复链路

这也是为什么文档坚持：

- CLI、MCP、Console 不能各自保存一套 run 状态
- 高风险动作要先显示 action preview
- 恢复动作必须先留证据，再执行恢复

## 7. 对外产品形态应该怎么理解

从交互上看，第一版不是做成“大聊天框”，而是三种入口共用一套 runtime：

- 对人：对象式 CLI
- 对外部 coding agent：MCP
- 对长任务观察：最小 Console / run watch

用户看到的核心对象应该是：

- `Case`
- `Target`
- `Run`
- `Run Plan`
- `Evidence`
- `Verdict`
- `Handoff`

而不是一堆零散底层命令。

## 8. 第一版为什么要收得这么窄

文档里对第一版边界收得非常明确：

- 默认个人开发
- 默认自己在用自己的设备
- 先做最小执行保护，不做完整审批系统
- 先打通一条真实闭环，不吃掉全部嵌入式场景

原因很现实：

- 如果先做审批和治理，故事会被带偏
- 如果先做大而全实验室平台，第一版会过重
- 如果先做超级聊天 agent，长任务、连接和证据都接不住

所以第一版的完成定义不是“功能多”，而是：

> 至少有一条真实嵌入式验证闭环能稳定跑通，并且结果能被人和 coding agent 继续消费。

## 9. 第一条最短闭环为什么这样选

文档已经把第一条 Demo 链定得很清楚：

```text
远端 Linux build
-> push 到目标设备
-> ADB 执行
-> Serial 持续观察
-> 产出 evidence package
-> 生成 verdict candidate
```

这条链被选中的原因也很清楚：

- 最接近真实嵌入式开发日常
- 对现有 Rust / Python 底座复用最多
- 风险比 flash / power cycle 小，更适合作第一条验证链

它故意先不覆盖：

- flash
- power cycle
- fault injection
- probe 级调试
- 多设备拓扑
- 团队治理

也就是说，第一条链的目标不是证明平台多强，而是证明：

> `Embed Agent` 真的能把一次真实嵌入式验证闭环接起来。

## 10. 这套产品和市面方案的差异

调研文档给出的判断很明确：

- 有很多板卡 / 实验室编排方案
- 有很多嵌入式测试框架
- 有很多 HIL / CI 方案
- 有很多 OTA / fleet / observability 方案
- 也开始出现 agent 化设备控制

但 GitHub 上还没有一个成熟产品把这条链完整打穿：

```text
代码变更
-> 选择 target
-> build
-> flash / push / ota
-> debug / watch
-> collect evidence
-> analyze
-> repair / retry / report
```

所以 `Embed Agent` 不该把自己定义成“另一个测试框架”，而应该定义成：

> 把 coding agent、嵌入式设备控制、专项验证和证据交接收成一体的运行层。

## 11. 如果把全部文档压缩成一句故事

最顺的一句可以这样说：

> `Embed Agent` 让通用 coding agent 第一次真正进入嵌入式现场，不只是改代码，而是能围绕真实设备、真实运行、真实证据完成一轮验证和修复闭环。

## 12. 推荐把它当成什么文档来用

这份一页版最适合拿来做三件事：

- 给新成员做 5 分钟产品对齐
- 给设计和研发做编码前统一口径
- 给对外介绍时先讲清楚“我们不是谁、我们是谁”

需要继续往下读时，建议顺序是：

1. `EMBED-AGENT-SPEC.md`
2. `EMBED-AGENT-SYSTEM-ARCHITECTURE.md`
3. `EMBED-AGENT-INTERFACE-DESIGN.md`
4. `EMBED-AGENT-FIRST-SLICE.md`
5. `EMBED-AGENT-IMPLEMENTATION-PLAN.md`
