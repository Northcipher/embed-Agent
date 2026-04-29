# Hook 系统 详细设计

> 状态：Draft / 日期：2026-04-29
> 对应架构: Section 9

## 1. 设计决定

```
Hook = 人配的 shell 脚本，在系统生命周期事件点自动执行。
不进 Runtime 核心代码。失败不阻塞主流程。

借鉴: Claude Code 的 Hook 系统（PreToolUse/PostToolUse/SessionStart/...）。
简化: 8 个事件点。按点限制返回值类型。
```

## 2. Hook 配置

```yaml
# configs/hooks.yml
hooks:
  - name: "pre-flash-check"
    on: PreStepExecute
    match: { capability: "flash" }
    command: "./scripts/pre-flash-check.sh {{target_id}} {{artifact_path}}"
    timeout: 30

  - name: "notify-on-failure"
    on: PostRunEnd
    match: { state: "failed" }
    command: "./scripts/notify-failure.sh {{run_id}} {{failure_reason}}"
    timeout: 10

  - name: "collect-extra-logs"
    on: OnFinalizing
    command: "./scripts/collect-extra-logs.sh {{evidence_root}}"
    timeout: 60
```

## 3. Hook 执行流程

```typescript
class HookManager {
  private hooks: Hook[] = [];

  load(config: HookConfig): void {
    this.hooks = config.hooks.map(h => ({
      ...h,
      match: h.match ?? {},
    }));
  }

  async execute(point: HookPoint, context: HookContext): Promise<HookResult> {
    const matched = this.hooks.filter(h =>
      h.on === point && this.matchesFilter(h.match, context)
    );

    for (const hook of matched) {
      const result = await this.runHook(hook, context);
      if (result.decision !== "proceed") return result;
    }
    return { decision: "proceed" };
  }

  private async runHook(hook: Hook, ctx: HookContext): Promise<HookResult> {
    const cmd = this.interpolate(hook.command, ctx);
    const start = Date.now();
    try {
      const { stdout } = await exec(cmd, { timeout: hook.timeout * 1000 });
      const parsed = this.parseJSON(stdout);
      const decision = ALLOWED_DECISIONS[hook.on].includes(parsed.decision)
        ? parsed.decision : "proceed";
      // 成功也发审计事件
      this.emitAudit(hook, decision, Date.now() - start);
      return { decision, reason: parsed.reason, additionalContext: parsed.additionalContext };
    } catch (e) {
      this.emitAudit(hook, "proceed", Date.now() - start, e.message);
      return { decision: "proceed" };
    }
  }

  private emitAudit(hook: Hook, decision: string, durationMs: number, error?: string): void {
    this.eventBus.emit({
      type: "hook_executed",
      run_id: this.currentRunId,
      hook_name: hook.name,
      point: hook.on,
      decision,
      duration_ms: durationMs,
      error,
    });
  }
}
```

## 4. 按事件点限制返回值

```typescript
const ALLOWED_DECISIONS: Record<HookPoint, string[]> = {
  PreRunStart:       ["proceed"],
  PostRunEnd:        ["proceed"],
  PreStepExecute:    ["proceed", "block", "retry"],
  PostStepComplete:  ["proceed"],
  PostStepFailed:    ["proceed"],
  OnStopDecision:    ["proceed", "block"],
  OnFinalizing:      ["proceed"],    // 只做补采。不改变流程结局。
  RuntimeStart:      ["proceed"],
};

// block → 调用方暂停/阻止操作。Run → paused。
// retry → 调用方重试当前操作（最多 1 次）。
// proceed → 继续。
// 不支持的值 → 忽略。视为 proceed。

// 执行顺序: hooks.yml 中定义顺序。首个非 proceed 即短路，后续同点 hook 不执行。
// 多团队共享 hooks: 用 hooks.d/ 目录，按文件名排序。`10-security.yml`, `20-custom.yml`。
// 审计事件记录每个 hook 的执行结果（包括被短路的）。
```

## 5. Hook Context（传给脚本的环境变量）

```typescript
interface HookContext {
  run_id?: string;
  target_id?: string;
  step_id?: string;
  capability?: string;
  state?: string;          // Run 状态。PostRunEnd/OnFinalizing 时存在
  failure_reason?: string; // 仅 OnFinalizing(failed)/PostRunEnd(failed) 时存在
  evidence_root?: string;  // OnFinalizing/PostRunEnd 时存在
  artifact_path?: string;  // PreRunStart/PreStepExecute 时存在
}

// 命令模板用 {{variable}} 引用。缺失的变量替换为空字符串。
// 不同 hook 点可用字段见事件点触发方表格。

// ⚠️ PostRunEnd 在标记终态之后触发。此时 reply.json、result_ready 已生成。
//    补采证据、影响结果内容 → 请用 OnFinalizing。PostRunEnd 只做通知/清理。
```

## 6. 事件点触发方

```
PreRunStart       → Run Manager (createRun 后)
PostRunEnd        → Run Manager (标记终态后)
PreStepExecute    → Step Executor (执行 Step 前)
PostStepComplete  → Step Executor (Step 成功后)
PostStepFailed    → Step Executor (Step 失败后)
OnStopDecision    → Decision Handler (Decision(stop) 执行前)
OnFinalizing      → Run Manager (finalizing 阶段, Reply 调用前)
RuntimeStart      → Runtime 启动
```

## 7. 审计

```typescript
// Hook 执行后 → 发 HookExecuted Event（无论成功/失败）。
// Store 持久化。人可通过 CLI 查询: va hook list --run-id xxx。

interface HookExecutedEvent {
  type: "hook_executed";
  run_id?: string;
  hook_name: string;
  point: HookPoint;
  decision: "proceed" | "block" | "retry";
  duration_ms: number;
  error?: string;
}
```
