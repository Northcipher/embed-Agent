# Circuit Breaker 详细设计

> 状态：Draft / 日期：2026-04-29
> 对应架构: Section 8

## 1. 设计决定

```
4 个独立熔断器。各自计数，不共享状态，不相互影响。
借鉴: Claude Code 连续拒绝计数 + OpenCode doom loop 检测。
作用: 无人值守时防止循环犯错、浪费资源、不通知人。
```

## 2. CB1: Observer 覆盖计数器

```typescript
class ObserverOverrideBreaker {
  private count = 0;
  private readonly THRESHOLD = 3;

  onOverride(): void { this.count++; }
  isActive(): boolean { return this.count >= this.THRESHOLD; }

  // 重置: DecisionHandler 在每次 Run 创建时 new ObserverOverrideBreaker()。
  // 不跨 Run。
}
```

## 3. CB2: Step 重试同因计数器

```typescript
class StepRetryBreaker {
  private lastFailureType?: string;
  private consecutiveSameFailure = 0;
  private readonly THRESHOLD = 3;

  shouldRetry(failureType: string): boolean {
    if (failureType === this.lastFailureType) {
      this.consecutiveSameFailure++;
    } else {
      this.lastFailureType = failureType;
      this.consecutiveSameFailure = 1;
    }
    return this.consecutiveSameFailure < this.THRESHOLD;
  }

  // 重置: StepExecutor 在每个 Step 开始执行前 new StepRetryBreaker()。
  // 不跨 Step。reset() 就是创建新实例。
}
```

## 4. CB3: Warning 累加器

```typescript
class WarningAccumulator {
  private ruleIds = new Set<string>();
  private readonly THRESHOLD = 5;

  record(ruleId: string): void { this.ruleIds.add(ruleId); }
  isEscalated(): boolean { return this.ruleIds.size >= this.THRESHOLD; }

  // 重置: DecisionHandler 在每次 Run 创建时 new WarningAccumulator()。
  // 不跨 Run。
}
```

## 5. CB4: LLM 降级器

```typescript
class LLMDegradationBreaker {
  private failures: Map<string, number> = new Map();
  private degradedSince: Map<string, number> = new Map(); // timestamp
  private readonly THRESHOLD = 3;
  private readonly RECOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟后尝试恢复

  recordSuccess(role: string): void {
    this.failures.set(role, 0);
    this.degradedSince.delete(role);
  }

  recordFailure(role: string): void {
    const count = (this.failures.get(role) ?? 0) + 1;
    this.failures.set(role, count);
    if (count >= this.THRESHOLD) {
      this.degradedSince.set(role, Date.now());
    }
  }

  isDegraded(role: string): boolean {
    if ((this.failures.get(role) ?? 0) < this.THRESHOLD) return false;
    // 降级后每 RECOVERY_INTERVAL 允许一次探测调用
    const since = this.degradedSince.get(role) ?? 0;
    if (Date.now() - since > this.RECOVERY_INTERVAL_MS) {
      this.degradedSince.set(role, Date.now()); // 重置探测窗口
      return false; // 本次允许尝试 LLM 调用
    }
    return true; // 仍在降级
  }

  // 恢复路径: 每 5 分钟允许一次 LLM 调用。
  //   成功 → recordSuccess → 降级解除。
  //   失败 → recordFailure → 重置探测窗口，5 分钟后再试。
}
```

### CB4 恢复流程

```typescript
class LLMCallManager {
  private breaker = new LLMDegradationBreaker();

  async call(role: string, prompt: string): Promise<LLMResult> {
    if (this.breaker.isDegraded(role)) {
      // 降级中。返回 fallback。不调 LLM。
      return this.fallbackFor(role);
    }
    try {
      const result = await this.provider.complete(prompt);
      this.breaker.recordSuccess(role);
      return result;
    } catch (e) {
      this.breaker.recordFailure(role);
      if (this.breaker.isDegraded(role)) {
        // 刚进入降级。发告警（内部 log，非 Event Bus 事件）。
        this.logger.warn(`LLM degraded for role: ${role}`);
      }
      return this.fallbackFor(role);
    }
  }

  private fallbackFor(role: string): LLMResult {
    switch (role) {
      case "planner": return DEFAULT_PLAN_TEMPLATE;
      case "observer":
        // 纯规则决策。接收 context（触发事件、severity），不只返回 continue。
        // fatal → stop, target_disconnected → pause, 其他 → continue
        return { decision: "continue" }; // 调用方（DH）补全具体逻辑
      case "reply": return MINIMAL_REPLY_TEMPLATE;
    }
  }
}
```

**注：** Observer fallback 返回 `{ decision: "continue" }` 简化值。Decision Handler 在收到 continue 后会继续执行——这等价于"不干预"。如果事件是 fatal，DH 已在调 Observer 之前直接 stop 了，不会走到这里。如果事件是 target_disconnected，RM 已在 DH 之前 pause 了。所以 continue 对降级场景是安全的默认值。

## 6. 归属与生命周期

```
Decision Handler:  每 Run 创建 → new CB1 + new CB3。Run 结束 → GC。
Step Executor:     每 Step 创建 → new CB2。Step 结束 → GC。
LLM Call Manager:  全局单例 CB4。持久存在。每 5 分钟自动探测恢复。
```