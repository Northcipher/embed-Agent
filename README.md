# Embed Agent

**让嵌入式设备验证像 CI 一样自动化。**

刷镜像 → 看串口 → 发现异常 → 自动判断 → 收集证据 → 输出结论。全程不需要人盯。

## 仓库状态

- GitHub CI：`pnpm typecheck` + `pnpm test`
- 默认不提交本地运行数据：`.embed-agent/`、`.env*`、`dist/`、`node_modules/`
- 没有真实设备和 API key 也可以先跑基础验证

## 为什么存在

传统嵌入式设备验证：
1. 人把镜像刷到板子上
2. 人盯着串口输出看有没有报错
3. 人凭经验判断 kernel panic 是不是已知无害变体
4. 人手动截图存证据
5. 下一个版本再来一遍

Embed Agent 把这个流程自动化了：

| 传统方式 | Embed Agent |
|---------|-------------|
| 人盯串口 | RuleDetector 全天候规则匹配 |
| 凭经验判断 | Observer(LLM) 分析上下文做决策 |
| 手动截图 | EvidenceStore 自动采集证据窗口 |
| 靠记忆判断是否是已知问题 | MemoryStore 已确认 known issue 自动跳过 |
| 无记录可回溯 | EventStore 完整事件流，每个 Run 可审计 |

## 怎么工作

```
用户敲 embedagent validate →
  Planner(LLM) 生成验证计划 →
    StepExecutor 逐步执行(刷机/等开机/跑命令/采日志) →
      串口输出 → RuleDetector(规则) + Aggregator(阶段+基线) →
        异常 → Observer(LLM) 决策(stop/continue/collect_more) →
          Reply(LLM) 出最终结论 → result_ready 事件
```

4 个断路器保证系统不失控：

| 断路器 | 触发条件 | 效果 |
|--------|---------|------|
| CB1 | 人 override 了 3 次 stop | 后续 auto-stop 降级为 suggest |
| CB2 | 同类型失败 3 次 | 熔断，标记 possible_hardware_issue |
| CB3 | 5 个不同 warning | escalation，Observer 收到升级信号 |
| CB4 | LLM 连续 3 次失败 | 降级到规则模式，5 分钟后探测恢复 |

## Quick Start

```bash
pnpm install
pnpm build
pnpm check
```

### 开箱即用

第一次拿到仓库，直接用这个入口最快：

- macOS: 双击 [Open Embed Agent.command](/Users/luozx/work/embed-Agent/Open%20Embed%20Agent.command)
- Windows: 双击 [Open Embed Agent.bat](/Users/luozx/work/embed-Agent/Open%20Embed%20Agent.bat)

它会自动完成：

1. 安装依赖
2. 构建 CLI / MCP / HTTP Server / Web UI
3. 生成 `.embed-agent/` 默认配置
4. 更新项目级 `.mcp.json`
5. 拉起本地服务并打开浏览器

默认地址是 [http://127.0.0.1:8787/#/start](http://127.0.0.1:8787/#/start)。

命令行等价入口：

```bash
pnpm desktop:open
```

只做初始化，不启动浏览器：

```bash
pnpm desktop:setup
```

第一次把仓库拉到 GitHub 或本地新环境时，先跑这个：

```bash
pnpm install
pnpm typecheck
pnpm test
```

这一步不需要真实设备，也不需要 LLM API key。

### 配置

本地配置文件和运行数据都放在 `.embed-agent/`，这个目录已经被 `.gitignore` 忽略，不应该提交到 GitHub。

**llm.yml**（必需）：
```yaml
default_provider: anthropic
providers:
  anthropic:
    type: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models:
      planner: claude-sonnet-4-6
      observer: claude-haiku-4-5
      reply: claude-haiku-4-5
    timeout: { planner: 120, observer: 60, reply: 60 }
observer_policy:
  debounce_sec: 30
  max_concurrent_per_run: 1
  default_checkpoint_interval: 300
```

**system.yml**（可选，有默认值）：
```yaml
runtime:
  retry: { max_retries: 3, intervals_sec: [2, 5, 10], retryable: ["timeout","connection_lost"] }
  rule_policy:
    fatal_patterns: ["Kernel panic", "Watchdog reset"]
    warning_patterns: ["error", "FAILED"]
    silence_timeout_sec: 60
  ring_buffer: { max_lines: 500, default_before: 200, default_after: 80 }
security:
  allowed_shell_commands: ["uname", "dmesg", "logcat", "echo"]
  max_command_length: 1000
observer:
  debounce_sec: 30
  circuit_breaker: { max_failures: 3, probe_after_sec: 300 }
  warning_escalation: { threshold: 5, window_sec: 600 }
```

**targets.yml**（可选）：
```yaml
target_id: board-01
connections:
  adb: { device_id: "abc123" }
  serial: { port: "/dev/ttyUSB0", baud: 115200 }
safety:
  allow_flash: true
  allow_reboot: true
  allow_shell_exec: true
  allow_power_cycle: false
```

### 启动

```bash
# 只读查询（不需要 LLM）
node apps/cli/dist/main.js targets --json

# 完整模式（需要 LLM API key）
ANTHROPIC_API_KEY=sk-xxx node apps/cli/dist/bootstrap.js

# TUI 面板
node apps/tui/dist/main.js

# MCP Server
node apps/mcp-server/dist/main.js
```

### Web UI

```bash
pnpm --filter @embed-agent/webui dev
```

开发模式地址通常是 [http://127.0.0.1:5173](http://127.0.0.1:5173)；如果端口被占用，Vite 会自动换一个端口。

构建后的正式 Web UI 由 HTTP server 直接托管，地址是 [http://127.0.0.1:8787/#/start](http://127.0.0.1:8787/#/start)。

### CLI 命令

```
validate      --artifact <path> --type <type> --target <id> --expected <desc>
status        --run-id <id>
events        --run-id <id> [--after <seq>] [--limit <n>] [--types <list>]
watch         --run-id <id> [--after <seq>] [--wait <sec>]
result        --run-id <id>
evidence      --run-id <id> [--ref <ref>]
pause         --run-id <id> [--reason <text>]
resume        --run-id <id>
cancel        --run-id <id> [--reason <text>]
intervene     --run-id <id> --action <action> [--instruction <text>]
targets
target        --show <id>
history       --target <id> [--limit <n>]
task          --list | --show <name>
memory        --add <stmt> --target <id> --category <cat> | --ls | --confirm <id> | --delete <id>
skill         --list | --show <name>
hook          --list | --show <name>
```

## 架构

```
contracts（类型 + Zod schema）
  ↓
stores（Event/Evidence/Run/Target/Memory/Skill/Task 持久化）
  ↓
tools（设备连接/规则检测/输出聚合）+ runtime（EventBus/StepQueue/DecisionHandler/RunManager/Hook）
  ↓
agent（Planner/Observer/Reply/LLMCallManager/Memory/SkillRegistry）
  ↓
apps（CLI/MCP Server/TUI）+ notify（Slack/Email）+ views（只读投影）
```

核心设计约束：
- **Event-first**：所有状态变更前先写 Event，再推进状态
- **Reply 是唯一 result_ready 发布者**：只有一个终态事件源
- **DecisionHandler 不订阅 DecisionMade**：决策链单向无循环
- **fatal 反射 bypass Observer**：致命信号不经过 LLM，直接 stop

## 测试

```
143 tests / 22 test files
├── 单元测试:      87  (Store/CB/Connection/Component)
├── 安全回归:      11  (白名单/路径穿越/execFile)
├── 类型兼容:       5  (contracts vs stores 对齐)
├── EventBus 集成:  4  (持久化/分区/顺序)
├── E2E 路径:       4  (正常/LLM故障/连接故障/空计划)
├── 场景矩阵:      10  (步骤失败/安全约束/取消/CB2/stream/flash/崩溃恢复)
└── RuleDetector:   3  (规则匹配→事件到达)
```

## 文档

| 目录 | 内容 |
|------|------|
| `docs/01-foundation/` | 架构设计、需求、设计洞察 |
| `docs/02-design/` | 运行时、工具、Agent、Store、观察、Hook、断路器详细设计 |
| `docs/04-planning/` | 接口规范、编码标准、功能清单、测试计划 |

## GitHub 集成

适合先放到 GitHub 的形态是：

- 主仓库保存源码、文档、测试、GitHub Actions
- 每个开发者本地维护自己的 `.embed-agent/llm.yml`、`.embed-agent/system.yml`、`.embed-agent/targets.yml`
- 真实设备、串口、ADB、Fastboot、API key 不进入仓库
- CI 只跑静态检查和单元测试，不连真实设备

## Desktop Installer

Windows 安装包现在是一个完整分发，而不只是桌面壳。

安装 `Embed Agent Desktop` 之后，安装器会同时放好：

- Desktop UI
- 内置 Runtime
- `embedagent` CLI
- `embedagent-mcp` 的 Claude Code 接入脚本

安装器还会做两件事：

1. 写入用户级环境变量：
   - `EMBED_AGENT_HOME`
   - `EMBED_AGENT_DATA`
   - `EMBED_AGENT_SERVER_URL`
2. 把 `<InstallDir>\bin` 加入用户 `PATH`

安装完成后可直接在新终端里使用：

```powershell
embedagent targets
embedagent validate --artifact C:\tmp\fw.bin --type firmware --target demo --expected "device boots"
```

如果本机安装了 `claude` CLI，安装器还会自动把 `embed-agent` 注册到 Claude Code 的用户级 MCP 配置里。

手动补装 Claude Code 集成：

```powershell
embedagent-claude-setup.cmd --scope user
```

如果想把 MCP 写到当前项目的 `.mcp.json`，在项目目录里执行：

```powershell
embedagent-claude-setup.cmd --scope project
```

### Claude Code / MCP

项目根目录的 `.mcp.json` 会注册 `embed-agent` 这个 MCP server。`pnpm desktop:setup` 或双击启动器会自动把下面这些参数写进去：

- `apps/mcp-server/dist/main.js`
- `EMBED_AGENT_DATA=<repo>/.embed-agent`
- `EMBED_AGENT_SERVER_URL=http://127.0.0.1:8787`
- `EMBED_AGENT_WEB_DIST=<repo>/apps/webui/dist`

如果当前机器已安装 `claude` CLI，setup 会再执行一次 `claude mcp get embed-agent` 做连通性确认。

### CLI

仓库根目录附带了本地包装脚本，方便直接使用：

- macOS / Linux: [embedagent](/Users/luozx/work/embed-Agent/embedagent)
- Windows: [embedagent.cmd](/Users/luozx/work/embed-Agent/embedagent.cmd)

例如：

```bash
./embedagent targets
./embedagent validate --artifact /tmp/test.img --type firmware --target demo --expected "device boots"
```
