# Embed Agent

**让嵌入式设备验证像 CI 一样自动化。**

刷镜像 → 看串口 → 发现异常 → 自动判断 → 收集证据 → 输出结论。全程不需要人盯。

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
pnpm check    # typecheck + 143 tests
```

### 配置

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
