# 终端工具调研

> 状态：Draft  
> 日期：2026-04-28  
> 目的：补充调研终端相关工具，判断“终端能力”到底被抽象到什么程度，我们是否还有必要在这一层继续做。

## 1. 结论

终端工具生态已经非常成熟，而且分层很清楚。

```text
shell command MCP
terminal session / multiplexer
serial terminal
web terminal
terminal record / replay
expect automation
```

这些层已经覆盖了：

- 开 shell。
- 控制进程。
- 读写 TTY。
- 多会话管理。
- Web 里展示终端。
- 记录和回放终端。
- 用 pattern 自动化交互。
- 串口自动连接和重连。

所以我们的方向不能落在“终端工具”上。  
终端只是底层 I/O 后端。

如果继续做，抽象必须高于 terminal session：

```text
terminal output 是 evidence source
不是产品对象本身
```

## 2. MCP / AI 终端工具

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [iris-networks/terminal_mcp](https://github.com/iris-networks/terminal_mcp) | Go 写的 MCP Terminal Server，支持 command execution、persistent shell sessions、timeout、HTTP transport | shell command / persistent shell | shell MCP 已经很多，不是差异点 |
| [ooples/mcp-console-automation](https://github.com/ooples/mcp-console-automation) | AI 驱动 console app automation，支持 console session、streaming、SSH、monitor output、detect errors | console automation | 已经接近“Playwright for terminal”的说法 |
| [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server) | 白名单 shell command MCP，支持 stdin、timeout、stdout/stderr/status | secure shell execution | 说明安全命令执行也已被抽象 |
| [mkusaka/mcp-shell-server](https://github.com/mkusaka/mcp-shell-server) | Node shell MCP，支持多 shell、working dir、error handling | shell execution | 常规 shell wrapper |
| [GongRzhe/terminal-controller-mcp](https://github.com/GongRzhe/terminal-controller-mcp) | terminal command、directory、file operations MCP | terminal + filesystem | 更像通用开发工具 MCP |
| [nickgnd/tmux-mcp](https://github.com/nickgnd/tmux-mcp) | tmux 的 MCP server，让 AI 读和控制已有 terminal sessions | terminal session observation/control | 说明 agent 可以直接接 tmux 层 |
| [wonderwhy-er/DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | Claude 的 terminal control、filesystem search、diff editing MCP | desktop command/control | 通用桌面开发 MCP |
| [Uninen/devserver-mcp](https://github.com/Uninen/devserver-mcp) | 管理 dev servers，TUI 实时 log streaming，实验性 Playwright | process/server lifecycle | 对“长任务 + 日志流”已有类似抽象 |

### 判断

AI/MCP 终端工具已经覆盖：

- 命令执行。
- 长进程。
- session。
- streaming output。
- timeout。
- error detection。
- persistent shell。
- tmux session。

所以我们不应该做：

```text
更好的 shell MCP
更好的 terminal MCP
更好的 console automation MCP
```

## 3. 终端 session / multiplexer

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [tmux](https://github.com/tmux/tmux/wiki) | terminal multiplexer，支持 control mode、capture-pane、pipe-pane | session / pane / stream | 可以作为 terminal backend；session control 已成熟 |
| [Zellij](https://zellij.dev/documentation/session-resurrection.html) | terminal workspace，session resurrection、pane viewport serialization | session persistence | 终端状态持久化已经有成熟方向 |
| [WezTerm](https://github.com/wezterm/wezterm) | GPU terminal emulator + multiplexer，支持 SSH、serial、workspace/session management | terminal emulator + mux + serial | 人用终端已经支持 serial 和 automation |
| [Tabby](https://github.com/Eugeny/tabby) | modern terminal，支持 SSH、serial、Telnet，terminal output save | terminal emulator / serial / ssh | 人用多协议终端已成熟 |

### 判断

这一层已经能抽象：

- session。
- pane。
- scrollback。
- control mode。
- capture output。
- pipe output。
- restore session。

如果我们只做“session 管理”，会撞这层。

我们的对象不能是 `terminal session`。  
我们的对象只能是：

```text
Run
```

Run 可以引用 terminal session，但不等于 terminal session。

## 4. 串口终端工具

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [tio](https://github.com/tio/tio) | 面向 embedded developers 的简单 serial TTY tool，自动检测、自动重连、拓扑 ID | serial terminal | 人用串口体验已经很强 |
| [picocom](https://github.com/picocom-ng/picocom) | minimal dumb terminal emulator，用于 serial consoles | serial terminal | 串口最小工具很成熟 |
| [CuteCom](https://github.com/susundberg/cutecom) / [cutecom-ng](https://github.com/develer-staff/cutecom-ng) | GUI serial terminal | serial GUI | 人用 GUI 串口工具已有 |
| [Serial Studio](https://github.com/Serial-Studio/Serial-Studio) | 串口 / BLE / MQTT / CAN telemetry dashboard，且有 MCP/API 方向 | telemetry dashboard | 不要做 telemetry dashboard |
| [WezTerm serial](https://wezterm.org/cli/serial.html) | `wezterm serial` 可以直接打开 serial port | terminal emulator serial mode | 现代 terminal 也开始吃 serial 场景 |

### 判断

串口工具已经覆盖：

- 连接。
- 自动重连。
- 日志保存。
- 人用交互。
- telemetry 展示。
- GUI / TUI / CLI。

所以我们不应该做：

```text
serial terminal
serial monitor
serial dashboard
```

串口只应该是 evidence source。

## 5. Web 终端 / 浏览器终端

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) | 浏览器里的完整 terminal component，支持 attach、serialize、search 等 addon | terminal UI component | Web Console 不需要自研 terminal emulator |
| [ttyd](https://github.com/tsl0922/ttyd) | 通过 WebSocket 把 terminal 暴露到 Web，基于 xterm.js | web terminal | Web 终端方案成熟 |
| [GoTTY](https://github.com/yudai/gotty) | 把任意 CLI 变成 Web app | web terminal wrapper | 终端上 Web 很容易 |
| [WeTTY](https://github.com/butlerx/wetty) | browser terminal over HTTP/HTTPS，基于 xterm.js 和 WebSocket | web SSH / web terminal | 浏览器终端不是差异点 |
| [Upterm](https://github.com/owenthereal/upterm) / [tmate](https://github.com/tmate-io/tmate) | terminal sharing / remote pair debugging | terminal sharing | 远程共享也已成熟 |

### 判断

Web Console 如果要做，不要做成另一个 terminal。  
应该只展示：

- run state。
- step timeline。
- key events。
- evidence refs。
- failure snapshot。

如果用户要完整 terminal，可以嵌入 xterm.js / ttyd / tmux backend。

## 6. 终端记录 / 回放

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [asciinema](https://github.com/asciinema/asciinema) | terminal session recorder / streamer / player，生成 asciicast | terminal recording / replay | 终端记录和回放非常成熟 |
| `script` / `scriptreplay` | Unix 原生命令，记录和回放 terminal session | raw terminal recording | 最基础证据采集已内置 |
| [tty-record](https://github.com/elisescu/tty-record) | 记录 terminal session 并生成自包含 HTML | terminal evidence artifact | 可以作为 evidence 展示思路 |

### 判断

终端证据保存不是难点。  
难点是：

```text
把 terminal evidence 放进 run schema。
```

也就是：

- 哪个 step 产生了这段输出。
- 输出对应哪个 target。
- 输出对应哪个 artifact。
- 哪些行命中了 observation policy。
- 失败前后窗口在哪里。

## 7. Expect / 交互自动化

| 项目 | 做什么 | 抽象层级 | 对我们的影响 |
|---|---|---|---|
| [pexpect](https://github.com/pexpect/pexpect) | Python 控制交互式程序，spawn child app，根据 expected patterns 响应输出 | expect automation | pattern wait / interactive automation 已非常成熟 |
| Expect | 经典交互自动化工具 | expect automation | “看到 pattern 后发送输入”不是新东西 |

### 判断

Observation Policy 的底层不是新发明。  
它本质上接近：

```text
expect rules + run semantics + evidence schema
```

差异不能是 pattern matching。  
差异只能是把 pattern matching 纳入 run transaction。

## 8. 抽象层级对比

```text
PTY / serial / socket
    ↓
terminal session
    ↓
terminal recording / expect automation
    ↓
process / command / devserver lifecycle
    ↓
run transaction  ← 只有这里可能是我们的空间
    ↓
business verdict  ← 不应该做
```

现有工具已经覆盖到 `process / command / devserver lifecycle`。  
嵌入式 HIL 工具覆盖到 `test job / lab run`。

我们的空间只剩：

```text
轻量 agent-facing board run transaction
```

## 9. 对我们的约束

### 9.1 不做终端

不要做：

- terminal emulator
- serial terminal
- Web terminal
- terminal sharing
- terminal recording
- expect engine

这些都成熟或容易做。

### 9.2 终端能力只作为 adapter

Runtime 可以接：

- tmux capture / pipe-pane
- pexpect
- xterm.js / ttyd
- tio / pyserial
- raw PTY

但它们都是后端。

### 9.3 我们必须证明 Run 比 Session 更有价值

Terminal session 关心：

```text
谁在读写这个终端
输出是什么
窗口怎么恢复
```

Run 关心：

```text
哪个 artifact 在哪个 target 上跑
执行了哪些 steps
哪个 step 失败
什么条件触发了 pause/stop
失败现场是什么
证据包在哪里
下一轮 agent 应该读什么
```

如果这个差异不成立，项目不成立。

## 10. 当前判断

终端工具调研进一步说明：

```text
“能控制终端”不是价值。
“能把终端输出纳入一次真实设备 run 的证据链”才可能是价值。
```

所以项目边界应该进一步收窄：

```text
Board Run MCP
不是 Terminal MCP
不是 Serial MCP
不是 Web Console
```

P0 的最小差异必须落在：

- `Run` 对象。
- `Target + Artifact + StepPlan` 绑定。
- `ObservationPolicy`。
- `FailureSnapshot`。
- `EvidencePackage`。
- `RunReport`。

否则就会被现有终端生态吞掉。
