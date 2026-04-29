# 参考实现映射

> 状态：Draft / 日期：2026-04-29
> 原则：学习模式、借鉴结构、不照抄命名

## 规则

```
✅ 可以:     学架构模式、学接口拆分、学错误处理方式、学时序编排
❌ 不可以:   照抄变量名函数名、照搬文件结构、复制粘贴代码
```

---

## 模块 → 参考来源

### Phase 1: 地基

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| contracts (Zod schema) | `reference-repos/github/modelcontextprotocol-typescript-sdk` | Tool/Resource/Prompt 的 Zod schema 定义方式 | MCP 协议专属的类型名 |
| EventStore (append-only JSONL) | Claude Code `src/state/store.ts` | append-only 事件存储模式、seq cursor 分页 | `AppState` 的领域概念 |
| ConfigLoader (YAML+Zod) | OpenCode `packages/opencode/src/config` | YAML 加载 + Zod 校验 + 明确错误行号 | OpenCode 的 Agent/Tool 配置结构 |

### Phase 2: 设备层

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| SerialConnection | `reference-repos/github/node-serialport` 的 `examples/` | SerialPort 打开/关闭/流读取/错误事件 | 示例里的变量命名 |
| AdbConnection | EmbedClaw `mcp-server/embedclaw_mcp/adapters/adb_adapter.py` | adb shell/exec-out/push 的命令拼接、wait_adb 轮询逻辑 | Python 风格的类名 |
| FastbootConnection | Android 官方 fastboot 协议文档 | fastboot flash/getvar/reboot 的命令格式 | — |
| OutputPipe + RingBuffer | 我们自己设计 | 行拼接模式、循环数组 | — |
| RuleDetector | 我们自己设计 | 6 种检测类型 | — |
| Aggregator | 我们自己设计 | 阶段识别/跨源关联/基线对比 | — |
| ConnectionManager | EmbedClaw `mcp-server/embedclaw_mcp/connection_manager.py` | Connection 池化复用、per-target 隔离、状态回调 | Python 的 `__init__`/`@property` 风格 |
| TargetManager | EmbedClaw `connection_manager.py` 的 `ensure_connected()` | Profile-based 连接恢复、状态检查顺序 | — |

### Phase 3: 运行时

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| EventBus | Node.js `EventEmitter` | on/emit/once 的 API 风格、同 Run 分区保证 | 不做通配符匹配 |
| StepExecutor | Claude Code `src/services/tools/toolExecution.ts` | 工具执行流水线(validate→permission→call→hook)、中断机制 | Claude Code 的 Tool 接口定义 |
| DecisionHandler | Claude Code `src/utils/permissions/` | 多级权限检查管道、denial 计数器(CB 的参考) | Claude Code 的 YOLO classifier |
| RunManager | OpenCode `src/session/prompt.ts` 的 `runLoop` | Agent 循环的状态机管理 | OpenCode 的 session 模型 |
| ContextAssembler | Claude Code `src/constants/prompts.ts` 的 `getSystemPrompt()` | 多节 prompt 组装、static/dynamic 分层、缓存边界标记 | Claude Code 的 system prompt 具体文案 |
| TaskManager | 标准 Cron 调度库 (`node-cron`) | Cron 表达式解析、触发时机计算 | — |
| HookManager | Claude Code `src/utils/hooks.ts` | Hook 事件点定义、子进程 spawn + JSON stdout、按事件点限制返回值 | Claude Code 的具体 HookEvent 名称 |

### Phase 4: 智能

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| LLMCallManager | Claude Code `src/services/api/withRetry.ts` | Provider 抽象、retry+backoff、model fallback | Claude Code 的 Anthropic-specific header |
| Planner | Claude Code `src/constants/prompts.ts` Planner 的角色定义 | prompt 结构(身份+规则+输出格式) | Claude Code 的具体 prompt 文本 |
| Observer | 我们自己设计 | Signal→Decision 的判断逻辑 | — |
| ReplyGenerator | 我们自己设计 | Event+Evidence→人话提取 | — |
| Memory | ark-runtime `crates/ark-agent/src/memory.rs` | WorkingMemory/Episode/SemanticFact 三分法、forbidden reasoning 检测 | Rust 的 `Result<T>` 模式 |
| SkillRegistry | Claude Code `src/tools/SkillTool/` | 渐进加载(Tier1 name+desc → Tier2 完整内容)、1% context budget | Claude Code 的 Skill 文件格式 |

### Phase 5: 辅助

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| NotificationFilter | Claude Code 的通知通道抽象 | 语义分类(事件→通知类型)、模板渲染、去重策略 | Claude Code 的企业通知逻辑 |
| Views (只读投影) | OpenCode `src/session/compaction.ts` | Event Store → 结构化投影的查询模式 | — |

### Phase 6: 入口

| 模块 | 参考 | 学什么 | 不照抄什么 |
|-----|------|-------|-----------|
| CLI | Claude Code `src/commands.ts` | 命令注册、--json 输出双模式 | Claude Code 的命令集 |
| MCP Server | `reference-repos/github/modelcontextprotocol-typescript-sdk` | `server.tool()` 注册、inputSchema 定义 | — |
| TUI | `reference-repos/github/ink` 的 `examples/` | 组件拆分、useInput/useStdout、SSE 订阅更新 | Ink 示例的 UI 布局 |

---

## 本地参考仓库

```
reference-repos/github/
  modelcontextprotocol-typescript-sdk   # MCP SDK
  modelcontextprotocol-servers          # MCP Server 示例
  node-serialport                       # SerialPort 库
  openai-node                           # OpenAI SDK
  anthropic-sdk-typescript              # Anthropic SDK
  ink                                   # React TUI 框架
  fastify                               # HTTP 框架

/Users/luozx/work/template/
  claude-code-source-code               # Claude Code CLI 源码
  opencode                              # OpenCode agent 源码

/Users/luozx/work/embedclaw/EmbedClaw/
  mcp-server/embedclaw_mcp/             # 嵌入式设备 MCP Server

/Users/luozx/work/ark-runtime/
  crates/ark-agent/src/                 # Rust Agent 实现
  docs/archive/reverse-analysis/        # 反向分析文档
```

---

## 我们自己设计的模块（无外部参考）

```
OutputPipe          行拼接 + feedStream/feedExec 分流
RingBuffer          定长循环数组 + 命中切窗
RuleDetector        6 种检测 + RulePolicy severity 预填
Aggregator          阶段识别/输出模式/跨源关联/基线对比/主动采样
Observer            事件驱动 + 周期 Checkpoint 双模式
Circuit Breaker     4 熔断器独立计数
Target 状态机       7 状态 + Pre-flight + 环境恢复
Run 状态机          8 状态 + finalizing 收口
```

这些是我们的核心差异化能力。不参考外部实现，从零设计。
