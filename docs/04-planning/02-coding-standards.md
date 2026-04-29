# 编码规范

> 状态：Draft / 日期：2026-04-29

## 1. TypeScript

```
- strict mode。noUncheckedIndexedAccess、noImplicitOverride 全开
- 优先 type 别名而非 interface（只有需要 extends 时才用 interface）
- 禁止 any。unknown + type guard
- 返回值显式声明类型（不依赖推断作为公开契约）
- async/await。不混用 Promise.then()
- 单文件原则：一个文件只导出一个主要类/模块
```

## 2. 目录与文件

```
packages/<module>/src/
  index.ts              # 公开 API 导出
  <component>.ts        # 一个组件一个文件
  <component>.test.ts   # 同目录测试文件

命名:
  文件: kebab-case  (step-executor.ts, event-bus.ts)
  类:   PascalCase   (StepExecutor, EventBus)
  函数: camelCase    (createRun, executeStep)
  常量: UPPER_SNAKE  (MAX_RETRY_COUNT)
  接口: PascalCase, I 前缀 (IRunManager)  或 无前缀直接 type alias
```

## 3. 错误处理

```
- 内部 helper: 可用 `Result<T, E>`。不 throw 业务错误。
  type Result<T, E> = { ok: true; value: T } | { ok: false; error: E; message: string };

- 公开接口: 使用显式 status union / 专用 payload。
  例: validate_artifact → { status: "accepted", run_id } | { status: "target_busy" } | ...
  不把 structured payload (missing_info, failed_checks, reasons) 压扁成 error message。

- 真异常 (bug/不可恢复): throw Error。最外层 catch → log + internal_error 返回。

- Error 消息: "什么是错的 + 为什么 + 建议"。
  ❌ "Connection failed"
  ✅ "无法连接 ADB 设备 ABC123: device offline。建议检查 USB 连接或 adb kill-server。"

- 不吞错误。try-catch 后必须 log 或返回 error。
```

## 4. 日志

```
级别:
  ERROR   需要人工介入 (Target offline, LLM 连续失败, 磁盘满)
  WARN    自动恢复的异常 (Hook timeout, retry, debounce skip)
  INFO    关键状态变化 (Run started/completed, step started/completed)
  DEBUG   调试细节 (Event payload, Decision reason, Connection state)

格式:
  [LEVEL] [timestamp] [module] message { key: value, ... }
  例: [INFO] [10:00:01.234] [run-manager] Run created { run_id: "run-042", target: "board-01" }

不 log:
  - API key / token / password
  - 完整的 serial.log 内容（那是 evidence，不是 log）
  - 用户输入的 shell command（可能是敏感信息）
```

## 5. 测试

```
文件:   同目录下 <name>.test.ts
命名:   describe("模块名") + it("场景: 期望")
        it("RuleDetector: should emit fatal event on kernel panic pattern")
        it("StepExecutor: should retry flash on USB timeout, up to 3 times")

Mock:   设备边界 (Connection)、LLM API、FileSystem 用 fake/stub。
        编排测试 (RunManager/DecisionHandler) 的协作者 (Planner/Observer/Reply/HookManager)
        用可控 stub 覆盖 early-fail/cancel/finalizing/recovery 路径。
        纯逻辑组件 (RuleDetector/Aggregator/breaker) 不 mock 内部状态。

覆盖率: 不追求数字。核心路径必须覆盖:
        - RuleDetector 每种 kind 至少 2 条 rule
        - DecisionHandler 每种 Decision 至少 1 条
        - 每个 CircuitBreaker 的激活/恢复路径
```

## 6. Git

```
分支:   main  (唯一长期分支)
        feat/<name>  功能分支

Commit:
  <type>: <简短描述>
  例: feat: add RuleDetector pattern matching
      fix: StepExecutor interrupt not clearing queue
      refactor: extract OutputPipe from Connection adapters

  一个 commit 只做一件事。

PR:   小 PR (< 500 行)。一个可验证的行为切片一个 PR。
      跨 package 的契约变更 (新增 event、修改接口) 可以同时改多个 package，
      只要这个 PR 是"一个逻辑变更 + 可独立验证"。
      PR 描述: "做了什么 + 为什么 + 怎么验证"
```

## 7. 异步与并发

```
- 所有 I/O (Connection, Store, LLM) 必须 async。
- Observer 是 DH 的同步依赖: DH await Observer.decide() 拿到 Decision 后才继续。
  不阻塞的是 Event Bus 分发线程: Observer 不作为 Event Bus 订阅者，DH 的 await 不占住总线。
- Step Executor 内部串行执行 Step。多 Target 的 Run 之间并行。
- 共享状态 (Target 锁, Step Queue) 用 async-mutex 或单线程保证。
```

## 8. 安全

```
- shell_exec: command 必须在 allowed_shell_commands 白名单内。白名单外 → 拒绝。
- push: dst 路径不能匹配 blocked_push_paths 黑名单。
- flash: artifact 路径必须存在且可读。不接受 URL/远程路径。
- Hook command: 必须本地脚本路径。不接受内联 shell。
- Config: API key 只从环境变量读取。不硬编码。不 log。
- Evidence: 不包含调用方的 shell command 原文（防止注入）。
```
