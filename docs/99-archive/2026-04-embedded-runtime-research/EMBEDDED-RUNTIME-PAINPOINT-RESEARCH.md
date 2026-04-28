# Embedded Runtime 痛点调研

> 状态：Draft  
> 日期：2026-04-28  
> 目的：继续调研现有工具已经解决了什么，剩下的真实痛点到底是不是值得做成一个 MCP / Runtime。

## 1. 先说结论

真实痛点不是：

```text
没有串口工具
没有刷机工具
没有测试框架
没有 MCP
没有 LLM 总结
```

这些都已经有人做了。

真实痛点如果存在，只可能是：

```text
Coding Agent 在一次修复循环里，
缺一个轻量、跨工具、可追踪的真实设备 run transaction。
```

更具体地说：

```text
artifact + target + steps + observation policy
-> async run
-> structured events
-> failure snapshot
-> evidence package
-> run report
```

这不是更智能，而是更适合 Coding Agent 消费。

## 2. 现有工具已经走到哪一步

### 2.1 连接层 MCP 已经很容易被做出来

[terminal_mcp](https://github.com/AuraFriday/terminal_mcp) 的实现很薄，更像一个 POC / 轻量 wrapper。  
但它仍然说明一个问题：把 Serial / SSH / Telnet 这类连接暴露给 AI agent，门槛不高。

它公开描述的能力包括：

- Serial / SSH / Telnet / TCP / WebSocket / Bluetooth / STDIO 等统一连接。
- pattern matching。
- multi-step atomic execution。
- auto reconnect。
- logging。
- async operations。
- progress tracking。

这说明：

```text
“让 AI 能连串口、连 SSH、等 pattern、保存日志”
不是一个足够深的壁垒。
```

即使不把 `terminal_mcp` 当成熟竞品，只做 connection wrapper 也很容易被复制。

### 2.2 SDK-specific MCP 已经出现

Espressif 官方文档已经有 `idf.py mcp-server`。

它提供：

- set target
- build project
- flash project
- clean project
- project config / status / devices resources

这说明：

```text
“让 AI 调 SDK 的 build / flash 命令”
也已经不是空白。
```

如果我们做 ESP-IDF build/flash MCP，没有价值。

### 2.3 实验室自动化已经很成熟

`labgrid` 已经抽象了：

- Target
- Resource
- Driver
- Environment YAML
- Strategy
- pytest plugin

它甚至处理 driver activation、resource binding、resource unavailable 等真实硬件问题。

`LAVA` 已经抽象了：

- job definition YAML
- deploy
- boot
- test
- DUT
- timeouts
- device type

这说明：

```text
“设备池 / HIL / CI / deploy-boot-test”
已经有成熟框架。
```

如果我们做 mini labgrid 或 mini LAVA，没有价值。

### 2.4 测试执行框架已经覆盖 expect / fixture

`pytest-embedded` 和 ESP-IDF pytest flow 已经抽象了：

- DUT fixture
- target parametrization
- serial expect
- timeout
- multi-DUT
- QEMU / hardware / Linux host 不同环境

这说明：

```text
“写硬件测试并通过串口 expect 判断结果”
也不是空白。
```

如果我们的目标是 test framework，也没有价值。

## 3. 现有工具的共同边界

这些工具不是不强，而是面向对象不同。

| 工具类型 | 主要服务谁 | 核心抽象 | 对 Coding Agent 的摩擦 |
|---|---|---|---|
| terminal_mcp | AI 操作连接和终端 | session / command / pattern / log | 实现很薄，说明连接层容易做；agent 仍要自己组织 artifact、steps、evidence、run report |
| ESP-IDF MCP | ESP-IDF 项目里的 AI build/flash | project command / device resource | 生态绑定强，只解决 ESP-IDF，不解决通用 board run |
| labgrid | 测试工程师 / 自动化脚本 | target / resource / driver / strategy | 需要 Python/YAML/test glue，面向测试工程，不是一次 agent repair run |
| LAVA | CI / 实验室 | job / deploy / boot / test | 很重，适合队列化 CI，不适合本地 agent 快速调试循环 |
| pytest-embedded | 测试作者 | fixture / dut / expect / marker | 需要预先写 test script，不是 agent 动态发起一次验证 |
| probe-rs / pyOCD / esptool | 嵌入式开发者 | flash / debug action | 只解决动作，不解决 run 事务 |

## 4. 痛点一：Agent 不缺工具，缺 run 边界

Coding Agent 直接用底层工具时，需要自己记住很多临时状态：

- 这次用哪个 target。
- artifact 是哪个文件。
- flash 是否成功。
- serial 从什么时候开始抓。
- ADB 什么时候恢复。
- 哪些日志和这次 goal 有关。
- 如果中途停止，哪些 evidence 已经保存。
- 这次 run 最终怎么交回下一轮修复。

这些状态不是代码修复逻辑，却会污染 Coding Agent 的上下文。

所以真正的抽象点不是：

```text
serial.read()
adb.shell()
flash()
```

而是：

```text
create_run()
get_run_events()
cancel_run()
get_run_result()
```

## 5. 痛点二：测试框架太“预设”，agent 修复太“临时”

`labgrid / LAVA / pytest-embedded` 都适合把已知测试流程沉淀下来。

但 Coding Agent 修 bug 时，经常是临时的：

```text
我刚改了一处启动逻辑
先刷进去
看 boot log 有没有 panic
ADB 回来后抓 dmesg
如果还是 panic，立刻停，回代码继续修
如果没 panic，再加一个 smoke command
```

这不是稳定 test suite，而是 repair loop 里的临时验证动作。

传统测试框架当然能做，但它会要求 agent 临时写很多 glue：

- 写 pytest case。
- 写 labgrid config。
- 写 LAVA job YAML。
- 配 driver / resource / strategy。
- 再把结果解析回修复上下文。

这一步太重。

我们的机会如果存在，就是提供一个更轻的临时 run contract。

## 6. 痛点三：日志量和上下文污染

真实设备输出很吵：

- 串口启动日志很多。
- ADB / dmesg / logcat 输出很多。
- 刷机工具 stdout 很长。
- reset / reconnect 会产生很多状态噪声。

把这些直接推给 Coding Agent 不现实。

但让 Runtime 自己“智能判断”也不对。  
Runtime 不知道业务目标。

所以合理设计是：

```text
Coding Agent 传 observation policy
Runtime 用确定性规则实时匹配
Runtime 保存原始 evidence
Runtime 返回结构化 key events / evidence refs
Coding Agent 再做语义判断
```

这里的痛点不是 LLM 总结，而是：

```text
如何把海量日志降成 agent 可消费的结构化事实。
```

## 7. 痛点四：硬件状态会变，连接工具只解决一半

terminal_mcp 这类项目至少证明了连接层能力可以很薄地暴露给 agent，例如 auto reconnect、pattern wait、日志读取这类能力。

但连接恢复不等于 run 语义恢复。

例如：

```text
串口重连了
```

只说明连接回来了，不说明：

- 当前 run 是否还有效。
- 当前 step 是否应该继续。
- flash 后重启是不是预期。
- ADB 不回来是不是失败。
- 需要不需要生成 failure snapshot。

所以 connection-level state 和 run-level state 是两层。

如果我们要做，必须证明 run-level state 有独立价值：

```text
running / paused / collecting_evidence / completed / failed / cancelled
step timeline
stop reason
matched observation policy
failure snapshot
```

## 8. 痛点五：Evidence 不只是日志文件

现有工具都会记录日志。  
但 agent 修复循环需要的 evidence package 更结构化：

- artifact metadata
- target profile
- step plan
- observation policy
- step timeline
- command stdout / stderr / exit code
- serial raw log
- ADB state
- matched key events
- failure snapshot
- raw evidence refs

这个包不是为了人看得舒服，而是为了下一轮 Coding Agent 能继续修。

如果我们只是保存 `serial.log`，没有价值。  
如果能稳定输出 agent-readable evidence schema，可能有价值。

## 9. 痛点六：跨生态一致性

ESP-IDF 有自己的 MCP。  
Android 有 ADB MCP。  
terminal_mcp 能连很多协议。  
labgrid 能管很多 target。

但它们的对象不统一。

Coding Agent 如果跨项目工作，会遇到：

```text
ESP32 用 idf.py MCP
Android board 用 adb MCP
MCU 用 probe-rs / pyOCD
Linux board 用 labgrid / SSH
另一个项目用自研脚本
```

如果每个生态都让 Coding Agent 重新学一套工具，agent 的上下文成本会很高。

所以真正可能成立的是一个薄统一层：

```text
不同后端 adapter
同一个 run contract
```

但这个统一层必须非常薄，不能重写后端能力。

## 10. 暂时不成立的痛点

下面这些痛点不成立，或者已经被别人很好覆盖：

| 伪痛点 | 为什么不成立 |
|---|---|
| AI 不能连串口 | terminal_mcp 这类薄 wrapper 已经能做，门槛不高 |
| AI 不能 flash ESP32 | ESP-IDF 官方 MCP 和 esp-mcp 类项目已覆盖 |
| 人没有串口工具 | tio / Serial Studio / minicom / pySerial 很成熟 |
| 没有硬件测试框架 | labgrid / LAVA / pytest-embedded / OpenHTF 很成熟 |
| 没有 pattern matching | terminal_mcp / pytest expect / LAVA prompt 都有 |
| 没有 LLM 总结 | 这不是核心痛点，而且 P0 不需要 |

## 11. 真痛点定义

当前最准确的痛点定义是：

```text
现有工具能完成设备动作，
但没有一个足够轻、足够通用、面向 Coding Agent 的 run-level transaction，
把临时验证目标、真实设备动作、运行状态、关键事件和证据包统一起来。
```

换成人话：

```text
工具能干活，
但 agent 每次还要自己拼现场、记状态、捞日志、整理证据。
```

## 12. 我们下一步该验证什么

不要继续写大文档。  
下一步应该做一个对比实验。

同一个任务：

```text
修 boot crash
编译 artifact
刷到板子
抓 serial
等 adb
抓 dmesg
根据结果继续修
```

分别用三种方式跑：

1. Coding Agent + terminal_mcp + 手写步骤。
2. Coding Agent + labgrid / pytest-embedded。
3. Coding Agent + 我们设想的 run contract。

观察指标：

- Agent 需要调用多少次工具。
- Agent 上下文里塞进多少日志。
- 是否丢失失败现场。
- 是否需要临时写 glue code。
- 结果能不能直接进入下一轮修复。
- 人能不能看懂 run 发生了什么。

如果第 3 种没有明显优势，项目就不该继续。

## 13. 当前 Go / No-Go 判断

Go 的条件：

- 我们能把 agent 的工具调用次数明显减少。
- 我们能把原始日志从 agent 上下文里隔离出去。
- 我们能让 failure snapshot 和 evidence package 稳定生成。
- 我们能复用底层工具，而不是重写工具。
- 我们能跨至少两类后端，例如 ESP-IDF + Linux board / ADB。

No-Go 的条件：

- 只支持单一 SDK，例如只做 ESP-IDF。
- 只是 serial / adb / flash MCP wrapper。
- 需要内置 LLM 才能讲清楚价值。
- 不能比一个很薄的 terminal MCP + 脚本少多少胶水。
- 不能形成稳定 evidence schema。

## 14. 当前判断

这个方向还有一点空间，但空间很窄。

它不是一个“更智能的 agent”。  
它也不是一个“更好的嵌入式工具”。

它只能是：

```text
Coding Agent 的真实设备 run transaction 层。
```

如果这个 transaction 层做得足够轻，可能成立。  
如果做重了，就会撞 labgrid / LAVA。  
如果做薄了但没有 evidence schema，就会退化成 terminal MCP wrapper。
