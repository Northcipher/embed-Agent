# Embed Agent 产品定义

> 状态：Draft
> 日期：2026-04-27
> 说明：本文档定义 `Embed Agent` 这个新项目的产品边界、核心对象和功能分层。它可以承接旧项目中的部分能力，但不继承旧产品叙事。

> 当前状态：背景参考。本文包含旧口径，尤其是 build、workspace、recipe、verdict、确认流程等内容。当前正式口径以 [EMBED-AGENT-ROLE-MODEL.md](EMBED-AGENT-ROLE-MODEL.md)、[EMBED-AGENT-SCENARIOS-AND-CALLS.md](EMBED-AGENT-SCENARIOS-AND-CALLS.md)、[EMBED-AGENT-FUNCTION-LIST.md](EMBED-AGENT-FUNCTION-LIST.md) 和 [EMBED-AGENT-FIRST-SLICE.md](EMBED-AGENT-FIRST-SLICE.md) 为准。

## 1. 一句话定义

`Embed Agent` 是一个**面向嵌入式研发与验证闭环的智能体运行层**。

它不是另一个通用 coding agent，也不是另一个聊天壳。  
它的职责是让通用 coding agent 真正进入嵌入式现场，连接真实目标、执行真实流程、沉淀真实证据，并能进入下一轮修复与验证。

一句更直接的话：

> `Codex / Claude Code` 管代码，`Embed Agent runtime` 管设备、运行和验证闭环，内置 `LLM worker` 负责把现场讲明白。

## 2. 产品目标

`Embed Agent` 要解决的不是“单次自动化”，而是下面这类重复而繁琐的工作：

- 在不同构建环境中生成产物
- 通过不同通道把产物送到目标设备
- 根据场景选择刷机或推包验证
- 在运行过程中挂接串口、SSH、ADB、Telnet、探针等调试链路
- 抓取日志、进程状态、CPU、内存等运行信息
- 对海量输出做过滤、聚合和结构化
- 根据结果判断是否通过，并进入下一轮修复或复测

产品最终要把这条链路收敛成可以稳定复用的 `run`。

更准确地说，产品不是只保存一次运行记录，而是要能回答：

- 这次验证对应哪份代码
- 这个问题已经尝试过哪些修复
- 每次 run 在哪块板、哪套环境、哪份产物上跑
- 失败时留下了哪些证据
- 最后结论是通过、失败、偶发还是仍需复现

### 2.1 先统一角色模型

这一轮文档统一按五层角色模型来讨论：

| 层 | 负责什么 |
|---|---|
| Human | 定目标、决定会改变设备状态的动作要不要做、收结果、背责任 |
| Coding Agent | 读代码、改代码、触发验证、读取 evidence、继续修复 |
| Embed Agent Runtime | 管 case、run、target、reservation、连接、执行、证据、最小执行保护和审计 |
| LLM Worker | 去噪、摘要、相似案例、候选结论、交接说明 |
| Toolchain / Real World | build host、flash tool、serial、SSH、ADB、probe、设备、电源控制器 |

这件事为什么重要：

- 外部 `coding agent` 不是 runtime 的一部分
- 内置 `LLM worker` 也不是现场状态机
- runtime 才是事实真理源

后面所有文档都默认沿用这套分工。  
如果需要展开，看 [EMBED-AGENT-ROLE-MODEL.md](EMBED-AGENT-ROLE-MODEL.md)。

### 2.2 第一版默认场景

第一版这里直接定死：

```text
默认就是个人开发
默认就是自己在用自己的设备
```

所以第一版不做完整审批系统，不做共享实验室那套细粒度放权。

第一版只保留这几个最小保护：

- run 启动前看清 revision、target、recipe、delivery
- 明确看到这次会不会刷机、重启、推包
- 关键动作有本地显式确认或显式命令参数
- 所有会改变设备状态的动作留下 audit

更复杂的内容，比如：

- approval queue
- 多人共享设备授权
- 不同设备级别的放权策略
- CI / 夜跑 / 远程实验室的细粒度拦截

统一放到后续真实需求再做。

## 3. 做什么

- 做真实目标的连接与长连接管理
- 做最小设备清单、健康状态和占用管理
- 做跨多环境的编译、交付、验证主链路
- 做刷机与非刷机两类交付策略
- 做运行期日志、指标、事件的采集与过滤
- 做可重复执行的 recipe、可追踪的 run 和可比较的 verdict
- 做外部 coding agent 的嵌入式执行层和运行管理层

## 4. 不做什么

- 不做另一个通用代码助手
- 不做另一个通用聊天工作台
- 不做通用 IDE 主环境
- 不做“什么都能自动化”的通用脚本平台
- 不把 memory、skills、multi-agent 作为第一阶段核心卖点
- 不先和 `Codex / Claude Code` 在代码编辑体验上正面对打

## 5. 目标用户

- 有真实设备、真实构建环境、真实部署/调试需求的嵌入式开发者
- 需要反复跑验证流程的测试工程师
- 需要连接现场设备、分析日志、推动修复闭环的问题定位人员

当前不把以下人群当主用户：

- 只想找一个通用 coding agent 的用户
- 只想找一个聊天 UI 的用户
- 只想找一个通用自动化平台的用户

## 6. 主流程

`Embed Agent` 的主产品闭环如下：

```text
绑定代码版本
-> 创建问题调查
-> 选择目标
-> 占用目标
-> build
-> deliver (flash / push / ota)
-> debug / run / watch
-> collect evidence
-> evaluate
-> repair / retry / promote
```

后续所有功能都应该回答两个问题：

- 它是否直接缩短了这条闭环？
- 它是否显著提高了这条闭环的成功率、可观察性或可追溯性？

如果答案都是否定的，就不应进入第一阶段主线。

## 7. 一等公民对象

`Embed Agent` 不应以“工具列表”为中心，而应以这些对象为中心：

### 7.1 Workspace / Revision

一次验证必须绑定到具体代码。

至少要记录：

- workspace path
- git branch
- git commit
- dirty state
- patch id
- build config

没有这个对象，系统就只能说“某次 run 失败了”，但说不清它到底验证了哪份代码。

### 7.2 Case

一个问题调查或专项任务。

例如：

- 修复一次黑屏问题
- 复现一次卡死问题
- 验证一次性能优化
- 跑一轮 OTA 回滚验证

一个 `Case` 下面可以有多次 `Run`，因为真实问题往往需要多轮修改和复测。

### 7.3 Target

一个真实验证目标，可能由多部分组成：

- build host
- device
- serial
- adb endpoint
- ssh endpoint
- probe
- power controller
- reservation state

### 7.4 Build Environment

产物生成环境。第一阶段至少承认以下类型：

- remote Linux server
- local Linux
- local Windows
- Windows VM

### 7.5 Reservation

对真实目标的占用记录。

它至少要说明：

- 谁占用了设备
- 占用多久
- 绑定到哪个 case / run
- 什么时候自动释放
- 设备是否处于坏状态

这是 `Embed Agent` 区别于个人脚本工具的重要对象。

### 7.6 Connection

一条可持续使用的连接：

- SSH
- ADB
- Serial
- Telnet
- Debug Probe

它必须具备状态、重连、心跳和可路由能力，而不只是“一次性执行命令”。

### 7.7 PowerController

控制真实设备的物理恢复和故障触发。

可能包括：

- power cycle
- reset
- relay
- PDU
- USB hub
- programmable power supply

黑屏、卡死、死机这类问题里，设备经常已经不能通过 SSH / ADB 恢复。没有 `PowerController`，系统只能观测问题，不能稳定恢复现场。

### 7.8 Delivery Strategy

把产物送到目标上的方式。至少分成两类：

- `flash`
- `push`
- `ota`

`flash` 用于烧录或刷机；`push` 用于 SSH / ADB / Serial 等非刷机式验证；`ota` 用于验证真实升级链路。

### 7.9 Stream

持续输出的数据流：

- serial log
- process stdout/stderr
- logcat
- system log
- probe events

### 7.10 Artifact

构建得到、部署使用或调试产生的文件与产物。

### 7.11 Run

一次完整执行，包含：

- 属于哪个 case
- 对应哪份 revision
- 使用了哪个 target
- 使用了哪个 build environment
- 使用了哪种 delivery strategy
- 执行到了哪个阶段
- 当前结果是什么

### 7.12 Evidence

一次 run 留下来的证据：

- 日志
- 指标
- 配置
- 产物版本
- 失败快照
- 关键事件

### 7.13 Evidence Package

把一次 run 的关键证据打包成可以交给人、CI 或 coding agent 继续使用的材料。

它应该包含：

- run summary
- timeline
- filtered logs
- metrics
- artifacts
- failure snapshot
- verdict

### 7.14 Verdict

对一次 run 或一个 case 的判断。

常见结论包括：

- passed
- failed
- reproduced
- not reproduced
- flaky
- inconclusive
- regression
- improved

没有 `Verdict`，系统只能“收集证据”，不能稳定地回答“这次修复到底有没有用”。

### 7.15 Baseline

用于对比的稳定版本或历史结果。

性能专项、回归验证、压测复线都需要它。否则系统只能看单次结果，不能判断变好还是变坏。

### 7.16 Recipe

可重复执行的流程定义，例如：

```text
build
-> flash
-> reboot
-> attach serial
-> start process
-> run test
-> collect logs and metrics
-> summarize result
```

## 8. 基础功能

基础功能的目标是：让 `1个人 + 1个项目 + 1组目标` 真正闭环。

### 8.1 Workspace / Revision 绑定

- 绑定项目路径
- 记录 git branch / commit
- 识别 dirty state
- 把 run 和代码版本关联起来

### 8.2 Case 管理

- 创建一个问题调查
- 在一个 case 下反复跑 run
- 记录每轮尝试的结论
- 保留最后可交付的 evidence package

### 8.3 Target / Profile 管理

- 定义 build host、device、serial、probe
- 定义 power controller
- 保存 profile
- 绑定 target group
- 支持一套配置反复复用

### 8.4 最小资源管理

- 查看 target 是否在线
- 查看 target 是否被占用
- reserve / release target
- 标记坏设备
- 基础健康检查

这部分必须进入第一版。否则产品会退回到个人自动化工具，无法支撑 HIL 和团队共享场景。

### 8.5 多连接长连接能力

- 支持 SSH / ADB / Serial / Telnet / Debug Probe
- 支持连接状态管理
- 支持断线重连
- 支持基础健康检查
- 支持一个 session 挂多条连接

### 8.6 Build Adapter

- 远端 Linux 构建
- 本地 Linux 构建
- 本地 Windows 构建
- Windows VM 构建
- 自定义构建命令
- 构建日志与构建结果输出
- 产物发现与登记

### 8.7 Delivery

- 统一 `flash` 入口
- 统一 `push` 入口
- 支持 CLI 刷机工具
- 支持 OpenOCD / JLink / 厂商工具
- 支持 SSH / ADB / Serial 推包验证

### 8.8 Debug / Run / Watch

- 串口读取与串口交互
- SSH / ADB / Telnet 进入目标环境
- 进程拉起、停止、重启
- 测试命令执行
- 运行时日志抓取

### 8.9 数据过滤

- 日志去噪
- 关键词提取
- 错误与异常事件提取
- 多流合并
- 关键片段截取

这一层的目标不是替代日志平台，而是把原始输出转换成 agent 可消费的证据流。

### 8.10 运行指标采集

- CPU 占用
- 内存占用
- 进程状态
- 基础系统信息

### 8.11 Run 管理

- 每次执行都是一个 run
- run 有明确阶段和状态
- run 保存 case、revision、target、环境、产物、日志、指标、结果
- run 失败时保留现场

### 8.12 Evidence / Verdict

- 输出 evidence package
- 输出结构化 verdict
- 支持失败原因摘要
- 支持基础对比

### 8.13 Agent 接入层

- 通过 MCP 对接外部 coding agent
- 第一优先级支持 `Codex / Claude Code`
- Embed Agent 作为嵌入式执行层被调用，而不是替代它们

### 8.14 安全边界

- 命令执行权限
- 烧录、重启、删除等危险操作确认
- 凭据隔离
- 基础审计记录

## 9. 进阶功能

进阶功能的目标是：让 `1个团队 + 1批设备 + 长时间任务` 真正可管理。

### 9.1 完整共享资源管理

- 设备池
- 资源发现
- 更完整的租约 / 占用
- 冲突检测
- 自动回收
- 坏设备标记

### 9.2 多目标拓扑编排

- `build host + device + serial + probe` 组合成一个 target
- 多连接默认路由
- 跨连接 recipe 编排
- 同一 session 下多目标协同

### 9.3 长任务管理

- 压测
- 浸泡
- 夜跑回归
- 自动重试
- 中断恢复
- 告警与超时处理

### 9.4 证据系统

- 日志回放
- 事件标记
- 失败快照
- 配置、产物、版本绑定
- 一次 run 的完整证据链

### 9.5 基线与对比

- 与上一次 run 比较
- 与稳定版本比较
- 性能退化检测
- 回归识别
- 异常模式聚类

### 9.6 故障注入

- 延迟注入
- 断网
- kill 进程
- CPU / 内存压力
- 断电
- 反复重启

### 9.7 调试增强

- reset / halt / continue
- breakpoint
- register / memory dump
- 故障现场自动抓取

### 9.8 团队治理

- 团队权限
- 共享实验室规则
- promote gate
- 操作审计

### 9.9 嵌入式专用记忆

- 板卡画像
- 平台差异知识
- 调试 recipe
- 故障签名库

### 9.10 控制台 / 管理面

- 查看所有 target 状态
- 查看 run 队列
- 查看资源占用
- 查看失败热点
- 查看实验室健康状态

## 10. 继承旧项目的原则

`Embed Agent` 可以承接旧项目的以下能力方向：

- 设备连接能力
- 构建、部署、调试工具面
- session / permission / runtime 思路
- 非侵入式设备接入原则

但不原样继承以下产品重心：

- 通用聊天工作台叙事
- 通用平台化扩张
- 以 memory / cron / channels / swarm 为中心的故事
- 以桌面 UI 为产品本体的做法

原则很简单：

> 继承能力，不继承包袱。

## 11. 第一阶段准入规则

第一阶段的功能只有在同时满足以下条件时才进入主线：

- 直接增强主闭环
- 对嵌入式场景有专属性
- 能沉淀为 case、run、recipe、evidence 或 verdict
- 不把产品重新拉回“通用 agent 平台”

## 12. 当前结论

`Embed Agent` 的第一性定位不是“自动化工具”，也不是“嵌入式版聊天 agent”。

它更准确的定义应该是：

> 一个面向真实设备、真实运行、真实验证闭环的嵌入式智能体运行层。

## 13. 为什么它必须是一个大 agent

`Embed Agent` 最终会走向一个更大的 agent，不是因为“功能想做多”，而是因为嵌入式现场的问题天然不是单步动作。

典型的专项问题往往同时具有以下特点：

- 链路长，不是一次命令能结束
- 通道多，需要同时观察串口、SSH、ADB、探针、进程、指标
- 时长长，需要长时间运行、复跑、压测、浸泡
- 证据碎，需要把日志、事件、指标、产物和配置拼成一条时间线
- 结果不确定，需要根据中间状态决定继续、重试、回滚还是升级验证

这意味着小工具模式不够。

小工具可以完成：

- 连一次设备
- 跑一次命令
- 推一次包
- 抓一段日志

但它很难负责：

- 长连接与中断恢复
- 多阶段执行状态
- 多通道联合观测
- 长时间专项任务管理
- 失败现场保留
- 多轮修复与复测闭环

这也意味着通用 coding agent 不够。

通用 coding agent 很擅长：

- 读代码
- 改代码
- 跑命令
- 调 MCP
- 串基础自动化

但它们并不天然擅长：

- 管理真实嵌入式目标和共享资源
- 持续盯住长时间运行任务
- 把多种调试链路合成统一运行上下文
- 在异常发生时自动抓取现场
- 把一次专项验证沉淀成可回放、可比较、可审计的 run

所以 `Embed Agent` 必须是一个大 agent，但这个“大”必须是纵向做深，而不是横向做宽。

它应该大在：

- 跨 `build -> deliver -> debug -> watch -> analyze -> retry`
- 跨 `serial / ssh / adb / probe / process / metrics`
- 跨长任务、异常恢复、复跑、证据沉淀
- 跨专项策略，而不是只会执行通用命令

它不应该大在：

- 通用聊天平台
- 通用 IDE
- 通用技能市场
- 通用多 agent 平台
- 面向所有行业的超级 agent

一句话说：

> `Embed Agent` 是一个大闭环 agent，而不是一个大而泛的平台 agent。

## 14. 典型专项场景

下面这些专项问题，决定了 `Embed Agent` 不能只停留在“连接 + 命令执行”层。

### 14.1 黑卡死专项

典型问题：

- 黑屏
- 卡机
- 死机
- 无响应
- 偶发冻结

这类问题的核心不是“手动排一次”，而是：

- 持续观测
- 自动识别异常
- 在失效瞬间保留现场
- 从多个通道拼出故障前后时间线

对应能力要求：

- 串口、SSH、ADB、probe 并行观测
- 心跳与 watchdog
- 无输出超时检测
- freeze / reboot / crash 事件识别
- 故障前后日志窗口保留
- CPU、内存、进程状态快照
- 必要时自动抓取 dump、tombstone、core

### 14.2 压测复线专项

典型问题：

- 长时间运行后才出现的 bug
- 高频操作下才暴露的问题
- 需要压力、耐久、重复触发才能稳定复现的问题

这类问题的核心不是“跑一遍脚本”，而是：

- 稳定长跑
- 自动重复
- 中断恢复
- 保存失败样本

对应能力要求：

- soak / stress run
- 循环 recipe
- 失败后停止或继续策略
- 周期性指标采集
- 阈值告警
- 异常样本归档
- run 统计与复现率视角

### 14.3 IPC / 时序专项

典型问题：

- 进程间通讯 race
- 启动顺序导致的问题
- 极端时序窗口
- 资源竞争和并发边界问题

这类问题最难的地方是跨进程、跨时间线，不是单条日志能解释。

对应能力要求：

- 多进程日志时间对齐
- 关键步骤打点和事件标记
- 启停顺序控制
- 延迟注入、重试控制、故障注入
- IPC 状态与进程状态联合采样
- 多 run 对比，识别偶发条件

### 14.4 性能专项

典型问题：

- CPU 高
- 内存涨
- 延迟抖动
- 吞吐下降
- 专项优化是否真的生效

这类问题的核心不是“收集一点数据”，而是：

- 建立基线
- 对比优化前后
- 判断是否回归

对应能力要求：

- CPU、内存、线程、进程级指标采集
- 启动耗时、响应耗时、吞吐统计
- 关键命令耗时记录
- 基线版本对比
- 回归检测
- 优化结果输出

## 15. 对功能定义的反推

有了上面的专项场景，功能定义就不能只是一张工具清单。

`Embed Agent` 的功能必须至少满足下面这些反推：

- 不是只会跑一次，而是会围绕一个 case 反复推进
- 不是只会记录结果，而是会绑定代码版本
- 不是只会连接，而是会长期维持连接
- 不是只会使用设备，而是会管理设备占用
- 不是只会执行，而是会管理 run
- 不是只会抓日志，而是会过滤、聚合、抽取证据
- 不是只会自动化，而是会对专项验证负责
- 不是只会看一次结果，而是会做复跑、对比、verdict 和回归判断

因此，`基础功能` 解决的是“把流程跑通”，`进阶功能` 解决的是“把专项问题管起来”。
