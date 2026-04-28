# Artifact Validation Agent 参考实现调研

> 状态：Draft  
> 日期：2026-04-28  
> 目的：梳理 GitHub 和本地 `embedclaw` 中可参考的实现，明确哪些模式可以借、哪些不能借。  
> 关系：技术选型见 [ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md](ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md)；MCP / TUI / LLM 具体实现时优先参考本文。

## 1. 结论

可以参考，但不能照搬。

本地参考仓库已经拉到：

```text
reference-repos/github/
```

本地 `embedclaw` 参考路径：

```text
/Users/luozx/work/embedclaw/EmbedClaw/mcp-server
```

强制规则：

```text
以后写任何实现代码前，必须先看对应参考目录。
最终回复必须说明看过哪些参考路径。
```

外部 GitHub 项目主要给我们这些东西：

```text
MCP server 写法
tool / resource / prompt 分层
ToolAnnotations / 安全提示
MCP conformance 测试思路
Ink TUI 组件与键盘交互模式
serialport stream 模式
LLM SDK provider 接入细节
Fastify schema validation 方式
```

本地 `embedclaw` 主要给我们这些东西：

```text
MCP 薄分发层
统一 ToolResponse
handler registry
结构化错误和脱敏
输出截断
stderr progress / stream event
runtime cleanup
cooperative cancellation
```

不能照搬的是：

```text
connection-level public tools
device_exec 作为核心入口
MCP server 自己持有设备连接状态
Python 主 MCP server
通用终端 / 通用 shell 代理思路
```

我们的 P0 仍然是：

```text
run-level contract
Runtime Server 是状态拥有者
MCP / CLI / TUI 都是 thin adapter
```

## 2. GitHub 参考项目

### 2.1 `modelcontextprotocol/typescript-sdk`

链接：

```text
https://github.com/modelcontextprotocol/typescript-sdk
```

用途：

| 可参考 | 说明 |
|---|---|
| MCP Server 基础写法 | tool / resource / prompt / transport。 |
| stdio transport | P0 给 Coding Agent 接入的首选。 |
| schema 接入 | SDK 支持 Standard Schema；可结合 Zod / JSON schema。 |
| examples | 优先看官方 runnable examples，不从博客抄。 |

注意：

```text
官方仓库 main 分支已经进入 v2 结构。
P0 落代码前必须确认当前稳定版本和包名。
不要在设计文档里写死旧的 @modelcontextprotocol/sdk ^1.0.0。
```

对我们的影响：

```text
MCP Server 只做 tools/resources/prompts 暴露和 Runtime HTTP 转发。
工具 schema 从 packages/contracts 生成或复用。
```

### 2.2 `modelcontextprotocol/servers`

链接：

```text
https://github.com/modelcontextprotocol/servers
```

重点看：

```text
src/filesystem
```

可参考：

| 可参考 | 说明 |
|---|---|
| 官方服务器集合组织方式 | 多 server 的目录和 README 风格。 |
| ToolAnnotations | 标记 read-only、idempotent、destructive。 |
| 安全边界写法 | 文件系统 server 明确 allowed directories。 |

对我们的影响：

```text
validate_artifact / get_run_status / watch_run / get_evidence 应该标 read-only / destructive hints。
cancel_run / intervene_run 要明确 destructive 或 non-idempotent 风险。
```

不能借：

```text
不要做 filesystem-like 通用操作面。
不要把 evidence 文件任意读写暴露成 MCP tools。
```

### 2.3 `modelcontextprotocol/conformance`

链接：

```text
https://github.com/modelcontextprotocol/conformance
```

可参考：

| 可参考 | 说明 |
|---|---|
| MCP 协议兼容性测试 | 后续验证 server 行为是否符合 MCP spec。 |
| baseline 机制 | 已知失败可以显式记录，避免假绿。 |

注意：

```text
当前示例偏 HTTP server URL 测试。
如果 P0 只有 stdio MCP Server，需要确认 conformance 是否支持 stdio，或加薄测试 wrapper。
```

对我们的影响：

```text
P0 skeleton 后至少加 MCP tool contract tests。
P1 再接 conformance suite。
```

### 2.4 `vadimdemedes/ink`

链接：

```text
https://github.com/vadimdemedes/ink
```

可参考：

| 可参考 | 说明 |
|---|---|
| `Box` / `Text` layout | 适合 Run Cockpit 三栏布局。 |
| `useInput` | 快捷键 pause / resume / cancel / view switching。 |
| `useApp` | 退出和 cleanup。 |
| `Static` | 适合已完成 timeline 行；动态区域只更新当前状态。 |
| `renderToString` | 可做 TUI snapshot tests。 |

注意：

```text
renderToString 下 terminal hooks 是 no-op。
交互测试不能只靠 renderToString。
```

对我们的影响：

```text
TUI 状态层必须来自 Runtime API polling。
TUI 组件只渲染事实，不维护独立 run state。
```

### 2.5 `serialport/node-serialport`

链接：

```text
https://github.com/serialport/node-serialport
```

可参考：

| 可参考 | 说明 |
|---|---|
| Node serial stream | `watch_serial` adapter 的基础。 |
| parser 包 | line parser / delimiter parser 可用于 serial.log 分行。 |
| cross-platform 支持 | macOS / Linux / Windows 都可用。 |

对我们的影响：

```text
SerialAdapter 只负责读取、写 serial.log、按行喂 Rule Engine。
连接参数只来自 Target Profile。
不要让 LLM / TUI 注入 serial port。
```

### 2.6 `openai/openai-node`

链接：

```text
https://github.com/openai/openai-node
```

可参考：

| 可参考 | 说明 |
|---|---|
| Request ID | SDK response 有 `_request_id`，应写入 brain calls。 |
| retry / timeout | SDK 默认会 retry，P0 要显式配置，避免 Runtime timeout 失控。 |
| Node runtime | 当前 SDK 要求 Node.js 20 LTS+。 |

对我们的影响：

```text
OpenAIProvider 必须设置 timeout / retry。
Brain Output Store 记录 request_id。
OpenAI SDK 本身要求 Node.js 20 LTS+；但当前 Ink 要求更高，所以项目 Node 版本定为 Node.js 22 LTS+。
```

### 2.7 `anthropics/anthropic-sdk-typescript`

链接：

```text
https://github.com/anthropics/anthropic-sdk-typescript
```

可参考：

| 可参考 | 说明 |
|---|---|
| TypeScript SDK | `AnthropicProvider` 直接接。 |
| Node requirement | Node.js 18+，被 OpenAI 的 Node 20+ 要求覆盖。 |
| examples | provider adapter 实现前看官方 README。 |

对我们的影响：

```text
Provider Abstraction 层屏蔽 SDK 差异。
AnthropicProvider / OpenAIProvider 输出都转成统一 LlmCallResult。
```

### 2.8 Fastify

链接：

```text
https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
```

可参考：

| 可参考 | 说明 |
|---|---|
| JSON schema route validation | Runtime HTTP API 入参边界。 |
| shared schema | contracts 转 JSON schema 后注册复用。 |
| validator error handling | 自定义 validator 不应抛出未处理异常。 |

对我们的影响：

```text
Runtime HTTP API 不做业务逻辑 schema 自由发挥。
所有 route schema 由 packages/contracts 统一导出。
```

## 3. 本地 `embedclaw` 参考

路径：

```text
/Users/luozx/work/embedclaw/EmbedClaw/mcp-server
```

### 3.1 项目形态

本地实现是：

```text
Python MCP Server
+ Tauri Workbench
+ SSH / ADB / Serial / Debug Probe connection-level tools
```

关键依赖见：

```text
mcp-server/pyproject.toml
```

说明：

```text
它证明 connection-level MCP 能跑。
但我们的产品不能停在 connection-level。
```

### 3.2 MCP server 薄入口

参考文件：

```text
mcp-server/embedclaw_mcp/server.py
```

可借：

| 模式 | 价值 |
|---|---|
| `list_tools` 单点注册 | MCP surface 集中可审。 |
| `call_tool` 单点分发 | handler 统一执行、统一错误、统一截断。 |
| `list_resources` / `read_resource` | 可用于 run status、target capabilities、evidence index 的只读资源。 |
| `list_prompts` / `get_prompt` | 可用于 Planner / Observer / Reply prompt 暴露和复盘。 |
| `stdio_server` 启动 | 证明 stdio 是合理默认入口。 |
| `cleanup_runtime_resources` | 退出时清连接和状态。 |

不能借：

```text
MCP server 里直接持有 ConnectionManager。
MCP handler 直接执行设备命令。
```

我们应该改成：

```text
MCP handler -> Runtime HTTP API -> Runtime Orchestrator -> Adapter
```

### 3.3 Handler Registry

参考文件：

```text
mcp-server/embedclaw_mcp/handlers/__init__.py
```

可借：

```text
每个模块导出 TOOLS / HANDLERS。
中心 registry 汇总 tool definitions 和 handler functions。
支持 dynamic tool description。
```

对我们的实现：

```text
apps/mcp-server/src/tools/
  validate-artifact.ts
  run-status.ts
  evidence.ts
  intervention.ts
  target-capabilities.ts

每个文件导出 tool definition + handler。
统一 registry 汇总。
```

### 3.4 统一响应结构

参考文件：

```text
mcp-server/embedclaw_mcp/response.py
```

可借：

| 结构 | 价值 |
|---|---|
| `ToolResponse` | 所有 handler 返回统一 shape。 |
| `ExecResult` | 执行结果包含 success、exit_code、stdout、stderr、duration。 |
| `error_response` | 结构化错误统一转换。 |
| `to_text_content` | MCP TextContent 输出集中处理。 |

对我们的实现：

```text
contracts 中定义 PublicToolResponse / ApiError。
MCP Server 不允许 handler 返回自由文本。
```

### 3.5 输出截断与进度事件

参考文件：

```text
mcp-server/embedclaw_mcp/output_utils.py
```

可借：

```text
MCP response 截断，避免污染 agent context。
stderr progress / stream / connection prefix 事件。
```

对我们的实现：

```text
MCP tool response 只返回 summary + refs，不返回大日志。
大日志通过 get_evidence 返回 bounded window 或 path。
TUI 不依赖 MCP stderr，而是轮询 Runtime Event Stream。
```

### 3.6 错误脱敏

参考文件：

```text
mcp-server/embedclaw_mcp/errors.py
```

可借：

```text
StructuredError。
ErrorCode。
sanitize_error。
recoverable / suggestion。
```

对我们的实现：

```text
所有外部错误必须脱敏。
连接参数、绝对路径、token、device id 默认不进入 Agent Reply。
```

### 3.7 连接管理

参考文件：

```text
mcp-server/embedclaw_mcp/connection_manager.py
```

可借：

```text
single source of truth for active transport。
cleanup。
connection state event。
lazy client init。
```

不能借：

```text
把 connection state 放在 MCP server。
让 agent 直接选 transport 执行命令。
```

对我们的实现：

```text
Target Service 持有 target runtime state。
Adapter 内部管理连接，但状态必须写 Target Runtime State + Event Stream。
```

### 3.8 Cancellation

参考文件：

```text
mcp-server/embedclaw_mcp/cancellation.py
```

可借：

```text
cooperative cancellation token。
operation registry。
cancel_all on shutdown。
```

对我们的实现：

```text
cancel_run 不能暴力杀所有进程。
每个 running step 应有 cancellation token。
不可中断动作需要先记录 cancel requested，再在安全点退出。
```

### 3.9 测试方式

参考文件：

```text
mcp-server/tests/test_tools.py
```

可借：

```text
mock connection manager。
直接调用 call_tool。
断言 JSON payload。
覆盖 not connected / invalid params / exec result。
```

对我们的实现：

```text
MCP tool tests 不接真 Runtime。
先 mock Runtime HTTP client。
断言 validate_artifact / watch_run / get_evidence 的 response shape。
```

## 4. 借鉴清单

P0 应该借：

| 来源 | 模式 | 落地位置 |
|---|---|---|
| MCP TS SDK | tool / resource / prompt / stdio | `apps/mcp-server` |
| MCP servers filesystem | ToolAnnotations / 安全提示 | `apps/mcp-server/src/tools` |
| MCP conformance | protocol tests | P1 或 skeleton 后 |
| Ink | Run Cockpit TUI | `apps/tui` |
| node-serialport | serial stream | `packages/adapters` |
| OpenAI / Anthropic SDK | provider adapters | `packages/llm-integration` |
| Fastify | local HTTP schema validation | `apps/runtime-server` |
| embedclaw server.py | thin dispatch / registry | `apps/mcp-server` |
| embedclaw response.py | unified response | `packages/contracts` |
| embedclaw output_utils.py | truncation / progress | MCP response + Runtime events |
| embedclaw errors.py | structured error / sanitize | `packages/contracts` / `shared-utils` |
| embedclaw cancellation.py | cancellation token | `runtime-core` worker |

P0 不应该借：

| 模式 | 原因 |
|---|---|
| `device_exec` 作为主入口 | 会退化成通用 shell MCP。 |
| MCP server 持有设备状态 | 破坏 Runtime-first。 |
| 任意 transport 参数来自 tool input | 破坏 Target Profile 安全边界。 |
| stderr progress 作为唯一状态源 | 状态不可持久化；我们必须写 Event Stream。 |
| Python MCP 主体 | 当前栈已定 TypeScript-first。 |

## 5. 对 P0 实现顺序的影响

实现顺序建议微调为：

| 顺序 | 内容 | 参考 |
|---:|---|---|
| 1 | contracts + public response shape | embedclaw `ToolResponse` |
| 2 | file-store + event stream | Runtime-first 文档 |
| 3 | runtime-core state machine | Runtime contracts |
| 4 | Runtime HTTP API schema validation | Fastify docs |
| 5 | MCP thin adapter + registry | MCP TS SDK + embedclaw server.py |
| 6 | MCP tool annotations / resources | modelcontextprotocol/servers |
| 7 | TUI fixture Run Cockpit | Ink examples |
| 8 | fake target / fake adapters | local test-kit |
| 9 | serial / adb / fastboot adapters | node-serialport + subprocess |
| 10 | LLM providers | OpenAI / Anthropic SDK + Gateway |

## 6. 立即行动项

进入编码前先做：

```text
确认 Node.js 22 LTS+。
确认 MCP TypeScript SDK 当前稳定包名和版本线。
确认 Ink 当前 major 版本和 React peer dependency。
确认 serialport 当前 major 版本。
把 embedclaw 的 ToolResponse / sanitize / truncate / cancellation 思路翻译成 TypeScript contracts，不直接复制 Python。
```

## 7. 编码前强制检查

| 要写的代码 | 必须先看 |
|---|---|
| MCP server / tools / resources / prompts | `reference-repos/github/modelcontextprotocol-typescript-sdk`、`reference-repos/github/modelcontextprotocol-servers`、`/Users/luozx/work/embedclaw/EmbedClaw/mcp-server` |
| TUI / keyboard interaction / layout | `reference-repos/github/ink` |
| SerialAdapter | `reference-repos/github/node-serialport` |
| LLM providers | `reference-repos/github/openai-node`、`reference-repos/github/anthropic-sdk-typescript` |
| Runtime HTTP API / validation | `reference-repos/github/fastify` |
| MCP protocol compatibility | `reference-repos/github/modelcontextprotocol-conformance` |
| Error / response / cancellation / truncation | `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp` |

违反这条规则的实现不进入 review。

## 8. 收口

参考项目给我们的价值不是“代码可复制”。

价值是：

```text
把 MCP 做薄。
把响应做结构化。
把大输出截断。
把状态写到 Runtime。
把设备连接藏在 Adapter 后面。
```

只要实现时开始把 `device_exec` 暴露成主要产品能力，就偏离 Artifact Validation Agent。
