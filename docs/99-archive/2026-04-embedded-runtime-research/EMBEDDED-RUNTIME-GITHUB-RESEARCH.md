# Embedded Runtime / MCP GitHub 调研

> 状态：Draft  
> 日期：2026-04-28  
> 目的：调研 GitHub 上已经存在的 MCP、串口工具、嵌入式自动化、HIL/CI、刷机调试工具，判断我们当前方向是否还有独立价值。

## 1. 结论

市场里已经有大量类似能力。

如果我们继续讲“Embed Agent”，方向会虚。  
更准确的定位只能是：

```text
面向 Coding Agent 的嵌入式设备运行 MCP Server / Runtime
```

而且这个定位也不是空白市场。  
已经有项目覆盖了相当多的底层能力：

- Android / iOS 设备 MCP：已经很多。
- 通用终端 / 串口 / SSH / Telnet MCP：已经出现，但不少项目仍是很薄的实现或概念验证。
- 人用串口工具和遥测面板：非常成熟。
- 嵌入式实验室自动化：labgrid、LAVA、tbot、pytest-embedded 等已经很强。
- 刷机和调试：probe-rs、pyOCD、esptool、OpenOCD 等都应该复用，不该重写。

所以我们如果继续做，只能做一个更窄的东西：

```text
把 Coding Agent 编译出的 artifact，
通过一个稳定 MCP contract，
放到真实 target 上运行，
并返回结构化 run evidence。
```

如果只是封装 `flash + serial + adb`，价值不够。

## 2. 最接近的 MCP 项目

| 项目 | 做什么 | 和我们重叠在哪里 | 关键差异 |
|---|---|---|---|
| [terminal_mcp](https://github.com/AuraFriday/terminal_mcp) | 给 AI agent 提供 Serial、SSH、Telnet、TCP、WebSocket、Bluetooth、STDIO 等统一连接能力 | 概念上重叠，说明 connection-level MCP 很容易被做出来 | 代码实现很薄，更像 POC / 轻量 wrapper；它不证明 run-level contract 已被解决 |
| [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) | iOS / Android 真机、模拟器、仿真器自动化 MCP | 证明“设备 MCP”方向已经成立 | 偏移动 UI 自动化，不是嵌入式板级刷机和串口现场 |
| [appium/appium-mcp](https://github.com/appium/appium-mcp) | Appium MCP，让 AI 操作 Android / iOS | 设备控制、截图、点击、测试自动化 | 主要面向移动 App 测试 |
| [android-mcp-server](https://github.com/minhalvp/android-mcp-server) | 通过 ADB 控制 Android 设备，暴露 MCP tools | ADB command、截图、包管理、UI layout | 只有 Android ADB 侧，不管嵌入式 target / run / evidence |
| [adbfriend](https://github.com/mikepenz/adbfriend) | ADB CLI，并集成 MCP Server | 常见 ADB 开发动作 MCP 化 | Android 开发工具，不是通用嵌入式 runtime |
| [Serial Studio](https://github.com/Serial-Studio/Serial-Studio) | 串口 / BLE / MQTT / Modbus / CAN 遥测仪表盘，并提供 API 和 MCP | Console、遥测展示、AI 集成、记录和回放 | 强在人用 telemetry dashboard，不是 Coding Agent 的运行闭环 |

### 对我们的直接影响

`terminal_mcp` 不是成熟竞品级威胁，但它是一个重要信号：connection-level MCP 的实现门槛很低。  
它宣称覆盖了很多我们以为要做的底层能力：

- Serial ports
- SSH / Telnet / TCP
- async operations
- logging
- pattern matching
- reconnect
- embedded boot log capture
- firmware transfer

这意味着我们不能把“多协议连接 + 串口日志 + pattern matching”当核心壁垒。  
因为即使一个很薄的 MCP wrapper，也能讲出类似故事。

## 3. 嵌入式实验室 / HIL / CI 自动化

| 项目 | 做什么 | 和我们重叠在哪里 | 关键差异 |
|---|---|---|---|
| [labgrid](https://github.com/labgrid-project/labgrid) | 嵌入式板级控制库，支持远程 exporter/coordinator、pytest、串口、SSH、电源、USB、mux 等 | Target、远程设备、串口、power、pytest 集成、开发和测试自动化 | 它是成熟 hardware control layer，不是 MCP-first |
| [LAVA](https://github.com/Linaro/lava) | Linaro 自动化验证架构，用于部署 OS 到物理/虚拟硬件并运行测试 | CI、设备池、job、test result、长期追踪 | 更重，偏 CI / lab infrastructure；主仓库在 GitLab，GitHub 是只读镜像 |
| [tbot](https://github.com/Rahix/tbot) | 嵌入式自动化工具，覆盖 U-Boot、Linux、build host、board 操作 | bootloader / Linux shell 自动化 | 传统 Python 测试自动化，不是 agent-facing MCP |
| [pytest-embedded](https://github.com/espressif/pytest-embedded) | 面向嵌入式测试的 pytest plugin，支持 serial、esp、idf、jtag、qemu、arduino、wokwi、nuttx | 串口 expect、自动 flash、测试运行 | 强绑定 pytest / Espressif 生态，适合测试工程 |
| [OpenHTF](https://github.com/google/openhtf) | Google 开源硬件测试框架，减少硬件测试 setup/execution boilerplate | DUT、测试步骤、测量、制造/实验室测试 | 偏测试脚本和硬件测试工程，不是 Coding Agent runtime |

### 对我们的直接影响

传统 HIL / Lab 自动化已经很成熟。  
我们不应该重新发明：

- target reservation
- board farm
- power control
- serial console abstraction
- pytest integration
- CI result tracking

如果要做，应该是作为 MCP facade 或薄层协议，而不是替代这些框架。

## 4. 人用串口和遥测工具

| 项目 | 做什么 | 和我们重叠在哪里 | 关键差异 |
|---|---|---|---|
| [tio](https://github.com/tio/tio) | 面向嵌入式开发者的轻量串口工具，自动检测、自动重连、X/Y modem、统计 | Serial watch、auto reconnect | CLI 人用工具，不是 run/evidence contract |
| [pySerial](https://github.com/pyserial/pyserial) / miniterm | Python 串口访问库和简单串口终端 | 最底层串口 I/O | 库级能力，太底层 |
| [Serial Studio](https://github.com/Serial-Studio/Serial-Studio) | 遥测 dashboard、数据可视化、记录、回放、API、MCP | Console 和 telemetry 可视化 | 它比我们的人用 Console 更成熟 |
| WireTrace / Open Serial Port Monitor 等 | 多为串口监控、CSV 导出、颜色高亮、GUI | 日志展示和保存 | 人用工具，不是 agent-facing run |

### 对我们的直接影响

不要做“更好的串口工具”。  
这条路没有意义。

Console 如果做，只能是 Runtime 状态视图，不应该和 Serial Studio、tio、minicom 竞争。

## 5. 刷机 / Debug / Probe 工具

| 项目 | 做什么 | 和我们重叠在哪里 | 关键差异 |
|---|---|---|---|
| [probe-rs](https://github.com/probe-rs/probe-rs) | ARM / RISC-V / Xtensa 调试和刷机工具链，支持 DAPLink、STLink、JLink、FTDI、ESP32 USB JTAG 等 | flash、debug、memory、halt/run、GDB server | 很强的底层 probe 层，我们应调用而不是重写 |
| [pyOCD](https://github.com/pyocd/pyOCD) | Python 的 Cortex-M 编程和调试工具/API，支持 flash、erase、reset、RTT、GDB server | Cortex-M flash/debug/CI 控制 | 适合做 adapter |
| [esptool](https://github.com/espressif/esptool) | Espressif SoC 的串口刷机、provision、交互工具 | ESP32 flash/provision | 适合做 adapter |
| OpenOCD | JTAG/SWD debug server 和 flash 支持 | flash/debug | 适合做 adapter |

### 对我们的直接影响

刷机能力不应该自研。  
第一版如果要支持 flash，只需要做 adapter contract：

```text
Runtime 调 probe-rs / pyOCD / esptool / adb / fastboot
并把 stdout、stderr、exit code、artifact metadata 归档到 evidence
```

## 6. 和我们当前设想的重叠度

| 能力 | 市面成熟度 | 是否还值得做 |
|---|---:|---|
| 串口连接 / 自动重连 | 高 | 不值得单独做，复用或包装 |
| ADB 控制 | 高 | 不值得单独做，复用或包装 |
| 移动设备 MCP | 高 | 不做 |
| UI 自动化 MCP | 高 | 不做 |
| 刷机工具 | 高 | 不做，做 adapter |
| board farm / lab 管理 | 高 | 不做 P0 |
| pytest / CI 测试框架 | 高 | 不做 P0 |
| 人用 telemetry dashboard | 高 | 不做 |
| Agent-facing run contract | 中低 | 可能值得做 |
| Artifact -> Target -> Run -> Evidence 的 MCP schema | 中低 | 可能值得做 |
| Observation Policy 作为 agent 和 runtime 的契约 | 中低 | 可能值得做 |
| Agent-readable structured evidence bundle | 中低 | 可能值得做 |

## 7. 可能还有价值的切口

唯一还有空间的切口是：

```text
不是做设备工具，
而是定义 Coding Agent 调真实设备的运行协议。
```

这个协议包含：

- `Target Profile`
- `Artifact Intake`
- `Step Plan`
- `Observation Policy`
- `Async Run`
- `Run Events`
- `Failure Snapshot`
- `Evidence Package`
- `Run Report`

这不是因为底层能力没人做，而是因为这些能力没有统一成“Coding Agent 能稳定消费”的 MCP contract。

但这个空间很窄。  
如果不把 contract 做得足够清楚，它会马上退化成：

```text
又一个串口 / ADB / shell MCP wrapper
```

## 8. 建议

### 8.1 改名

不要叫 `Embed Agent`。

建议叫：

- `Embedded Runtime MCP`
- `Board Run MCP`
- `Device Run MCP`
- `Target Runtime MCP`

### 8.2 P0 不做什么

- 不做内置 LLM。
- 不做串口终端。
- 不做 telemetry dashboard。
- 不做 board farm。
- 不做 CI 系统。
- 不做刷机工具。
- 不做业务 verdict。

### 8.3 P0 做什么

P0 只做：

```text
给 Coding Agent 一个标准 MCP：
传 artifact、target、steps、observation policy，
启动真实设备 run，
返回 events、evidence、run report。
```

### 8.4 技术实现上应该复用

- 串口：pySerial / tio 思路 / terminal_mcp 经验
- Android：adb / fastboot / existing Android MCP
- MCU flash：probe-rs / pyOCD / esptool / OpenOCD
- Lab：后续接 labgrid，而不是重写 labgrid

## 9. Go / No-Go 判断

继续做的条件：

- 我们能定义出比 `terminal_mcp` 更适合 Coding Agent 的 `Run Contract`。
- Evidence Package 结构能明显降低 Coding Agent 后续修复成本。
- Observation Policy 能把“验证目标”稳定变成 Runtime 可执行规则。
- 第一版能用很少 adapter 跑通真实板子，不陷入工具平台建设。

不继续做的条件：

- 如果最后只是在 MCP 里包 `adb shell`、`serial read`、`flash command`。
- 如果目标变成做更好的串口工具。
- 如果目标变成做 labgrid / LAVA 的简化版。
- 如果仍然需要内置 LLM 才能讲清楚价值。

## 10. 当前判断

这个方向不是没有价值，但价值不在“能力”，而在“协议”。

更直白地说：

```text
底层工具已经很多。
缺的不是工具，而是 Coding Agent 调用真实设备时的一套窄而稳定的运行契约。
```

如果我们接受这个定位，项目可以继续。  
如果我们想做的是“嵌入式 Agent 平台”，不建议继续。

补充判断：

`terminal_mcp` 这种薄实现反而说明一点：  
connection-level wrapper 很容易被复制，不能构成护城河。真正要验证的是 run-level contract 是否能显著减少 Coding Agent 的胶水工作。
