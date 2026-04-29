# Tool 详细设计

> 状态：Draft / 日期：2026-04-29
> 对应架构: Section 11-13, 18

## 1. Connection 接口

```typescript
interface Connection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): "connected" | "disconnected" | "error";
  exec?(cmd: string, timeout: number): Promise<ExecResult>;
  stream?(timeout: number): AsyncIterable<string>;
  push?(src: string, dst: string): Promise<void>;
  flash?(image: string, partition: string): Promise<void>;
  onDisconnect?: (callback: () => void) => void;
}
```

| Connection | exec | stream | push | flash | connect |
|-----------|------|--------|------|-------|---------|
| Local | ✅ | - | ✅ | - | - |
| Serial | - | ✅ | - | - | ✅ |
| ADB | ✅ | - | ✅ | - | ✅ |
| Fastboot | ✅* | - | - | ✅ | ✅ |
| SSH | ✅ | - | ✅ | - | ✅ |

### Step → Connection 映射（action + capability）

```typescript
function getConnection(target: TargetProfile, step: Step): Connection {
  const { action, capability } = step;

  switch (action) {
    case "stream":
      return cm.get(targetId, "serial");  // stream 只走 serial

    case "flash":
      return cm.get(targetId, "fastboot");

    case "push":
      // capability 可能指定 transport
      return cm.get(targetId, capabilityTransport(capability));

    case "exec":
      // cap 决定走哪条链路，不只是看有没有 ADB
      // wait_adb    → ADB (polling, 不需要 shell_exec allow)
      // shell_exec  → ADB (优先) 或 SSH (备选)
      // collect_logs(dmesg/logcat) → ADB
      return cm.get(targetId, capabilityTransport(capability));
  }
}

// capability → transport 映射
function capabilityTransport(cap: string): string {
  switch (cap) {
    case "wait_adb":       return "adb";
    case "shell_exec":     return "adb";  // 也支持 SSH。由 Plan 指定。
    case "check_process":  return "adb";
    case "collect_logs":   return "adb";
    case "push":           return "adb";
    default:               return "local";
  }
}
```

## 2. SerialConnection

```typescript
class SerialConnection implements Connection {
  private port: SerialPort;
  private ringBuffer: RingBuffer;

  async connect(): Promise<void> {
    this.port = new SerialPort({ path: this.config.port, baudRate: this.config.baudRate, autoOpen: false });
    await this.port.open();
    this.port.on('close', () => this.handleDisconnect());
    this.port.on('error', () => this.handleDisconnect());
  }

  async *stream(timeout: number): AsyncIterable<string> {
    const parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    const endTime = Date.now() + timeout * 1000;
    for await (const line of parser) {
      if (this.interruptRequested) break;
      if (Date.now() > endTime) break;
      yield line;
    }
  }

  private handleDisconnect(): void { this.onDisconnect?.(); }
}
```

## 3. OutputPipe

```typescript
class OutputPipe {
  private lineBuffer = "";
  private ringBuffer: RingBuffer;
  private silenceTimer: Timer;
  private batchCounter = 0;

  // stream 模式: Serial
  feedStream(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.evidenceWriter.append(line + "\n");
      this.ringBuffer.push(line);              // ← 先进 ring buffer
      this.ruleDetector.detect(line, i);       // ← 再检测（此时命中行已在 buffer）
      this.aggregator.feed(line);
    }

    this.batchCounter += lines.length;
    if (this.batchCounter >= 100) {
      this.eventBus.emit({ type: "observation", lines: this.batchCounter });
      this.batchCounter = 0;
    }
    this.silenceTimer.reset();
  }

  // exec 模式: ADB/SSH/Local
  feedExec(stdout: string, stderr: string, exitCode: number): void {
    const lines = (stdout + "\n" + stderr).split("\n").filter(l => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.evidenceWriter.append(line + "\n");
      this.ringBuffer.push(line);              // ← exec 输出也进 buffer
      this.ruleDetector.detect(line, i);       // ← 这样命中窗口有稳定来源
      this.aggregator.feed(line);
    }

    this.ruleDetector.checkExitCode(exitCode);
    this.eventBus.emit({ type: "observation" });
    this.aggregator.onExecComplete(this.stepId);
  }
}
```

## 4. Rule Detector

```typescript
class RuleDetector {
  private systemRules: Rule[];          // Run 开始时加载，不变
  private targetPatterns: Rule[];       // Run 开始时加载
  private knownIssuePatterns: Rule[];   // Run 开始时加载
  private stepPatterns: Rule[];         // ← Step 级。Step 开始时加载，结束清空

  loadRunRules(system: Rule[], target: Rule[], known: Rule[]): void {
    this.systemRules = system;
    this.targetPatterns = target;
    this.knownIssuePatterns = known;
  }

  loadStepPatterns(patterns: string[]): void {
    // Step 开始时调用。Step 级 watch pattern 只在本 Step 执行期间生效。
    this.stepPatterns = patterns.map(p => ({ kind: "pattern", pattern: new RegExp(p), source: "plan" }));
  }

  clearStepPatterns(): void {
    this.stepPatterns = [];
  }

  get activeRules(): Rule[] {
    return [...this.systemRules, ...this.targetPatterns, ...this.knownIssuePatterns, ...this.stepPatterns];
  }

  detect(line: string, lineIndex: number): void {
    for (const rule of this.activeRules) {
      if (rule.kind === "pattern" && rule.pattern.test(line)) {
        // ringBuffer.push 已在 detect 之前执行。命中行已进 buffer。
        const window = this.ringBuffer.getWindow(lineIndex, rule.beforeLines, rule.afterLines);
        this.evidenceStore.saveWindow(window);
        this.eventBus.emit({
          type: "rule_matched", rule_id: rule.id,
          severity: rule.severity,
          evidence_refs: [window.ref]
        });
      }
    }
  }
}
```

**severity:** Run 开始时加载 RulePolicy 填入。Event 发布时完整。

## 5. Ring Buffer

```typescript
class RingBuffer {
  private buffer: string[] = [];
  private head = 0;
  private maxLines = 500;

  push(line: string): void {
    this.buffer[this.head % this.maxLines] = line;
    this.head++;
  }

  getWindow(hitIndex: number, before: number, after: number): string[] {
    // 命中行在 buffer 中的索引 → 取前后各 N 行
  }

  getRecent(limit: number): string[] { /* Aggregator 跨源关联读窗口 */ }
}
```

## 6. Aggregator

```typescript
class Aggregator {
  feed(line: string): void { this.lineCount++; this.detectStage(line); this.extractMetrics(line); }
  async onExecComplete(stepId: string): Promise<void> { /* 跨源关联 + 基线对比 */ }
  async checkpoint(step: Step): Promise<CheckpointEvent> { /* 周期采样 */ }
}
```

## 7. Connection Manager

```typescript
class ConnectionManager {
  private pool: Map<string, Connection> = new Map();

  getConnection(targetId: string, transport: string): Connection {
    const key = `${targetId}:${transport}`;
    if (this.pool.has(key)) return this.pool.get(key)!;
    const target = this.targetStore.get(targetId);
    const conn = this.createConnection(target, transport);
    if (conn) {
      // 状态变化 → 完整的 TargetStateChanged Event
      conn.onDisconnect = () => this.eventBus.emit({
        type: "target_state_changed",
        target_id: targetId,
        target_state: this.targetManager.getState(targetId),
        serial: conn instanceof SerialConnection ? "disconnected" : undefined,
        adb: conn instanceof AdbConnection ? "offline" : undefined,
        fastboot: conn instanceof FastbootConnection ? "disconnected" : undefined,
      });
      this.pool.set(key, conn);
    }
    return conn;
  }
}
```

## 8. Target Manager

```typescript
class TargetManager {
  constructor(private cm: ConnectionManager) {}

  async preflight(targetId: string, requiredTransports: string[], artifactPath: string): Promise<PreflightResult> {
    const target = this.targetStore.get(targetId);
    const checks: PreflightCheck[] = [];

    // 遍历 Plan 实际需要的所有 transport（不只是 serial/adb）
    for (const transport of requiredTransports) {
      try {
        const conn = this.cm.getConnection(targetId, transport);
        await conn.connect();
        checks.push({ check: `${transport}_open`, passed: true });
      } catch (e) {
        checks.push({ check: `${transport}_open`, passed: false, error: e.message });
      }
    }

    // 镜像文件
    try {
      await this.cm.getConnection(targetId, "local").exec(`test -f ${artifactPath}`);
      checks.push({ check: "artifact_exists", passed: true });
    } catch {
      checks.push({ check: "artifact_exists", passed: false });
    }

    const failed = checks.filter(c => !c.passed);
    const failureType = failed.some(c => c.check.includes("serial") || c.check.includes("adb") || c.check.includes("fastboot"))
      ? "device" : "host";
    return { allPassed: failed.length === 0, checks, failureType };
  }

  async recover(targetId: string): Promise<boolean> {
    const target = this.targetStore.get(targetId);

    // 1. 重启（通过 CM 取连接，不走模块级变量）
    if (target.recovery.rebootMethod === "adb") {
      try { await this.cm.getConnection(targetId, "adb").exec("reboot", 30); } catch { return false; }
    } else if (target.recovery.rebootMethod === "fastboot") {
      try { await this.cm.getConnection(targetId, "fastboot").exec("reboot", 30); } catch { return false; }
    }

    // 2. 重刷稳定版
    if (target.recovery.stableArtifact) {
      await this.cm.getConnection(targetId, "fastboot").flash(target.recovery.stableArtifact, "boot");
    }

    // 3. 验证基本功能（按 Target 实际配置检查，不强制 ADB+Serial 都成功）
    const hasAdb = !!target.connections.adb;
    const hasSerial = !!target.connections.serial;
    const adbOk = hasAdb ? await this.waitForAdb(targetId, 180) : true;
    const serialOk = hasSerial ? await this.waitForSerial(targetId, 30) : true;
    return adbOk && serialOk;
  }
}
```

### Target 状态迁移

```
idle      → preparing   Run admission
preparing → busy        Pre-flight 全部通过
preparing → idle        Pre-flight 失败, Host 问题
preparing → offline     Pre-flight 失败, 设备问题
busy      → cleaning    Run 结束
busy      → dirty       Run 崩溃
cleaning  → idle        清理完成
cleaning  → dirty       清理失败
dirty     → recovery    下次 Run 前
recovery  → idle        恢复成功, 无 pending Run
recovery  → preparing   恢复成功, 有 pending Run
recovery  → offline     恢复失败
```
