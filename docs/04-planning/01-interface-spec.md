# 接口规范

> 状态：Draft / 日期：2026-04-29
> 范围：CLI 命令签名、MCP Tool Schema、Event Payload、模块间接口契约

## 1. CLI 命令签名

### 1.1 验证 & 执行

```
va validate
  --artifact <path>          必填。镜像路径
  --target <id>              必填。Target ID
  --expected <string>        必填。一句话描述验证目标
  [--concerns <list>]        可选。担心的风险，逗号分隔
  [--test-hint <string>]     可选。adb_shell:<command>
  [--max-duration <seconds>] 可选。最大时长。默认 600
  [--no-flash]               可选。跳过刷机
  [--continuous]             可选。持续模式（不自动结束）
  [--observe-interval <sec>] 可选。checkpoint 间隔。默认 300
  [--observe-metrics <list>] 可选。监控指标，逗号分隔

va run
  --skill <name>             必填。Skill 名称
  [--param k=v...]           可选。Skill 参数

va task create
  --name <name>              必填。任务名称
  (--cron <expr> | --watch <path>) 必选一。触发方式
  --skill <name>             必填。Skill 名称
  [--param k=v...]           可选。Skill 参数

va task list / show <name> / pause <name> / resume <name> / delete <name>
```

### 1.2 查询

```
va status --run-id <id>
  → { run_id, state, current_step?, target_state, elapsed_sec, last_event_seq }

va watch --run-id <id> [--after <seq>] [--wait <sec>]
  → 实时输出 Timeline 格式

va events --run-id <id> [--after <seq>] [--limit <n>] [--types <list>]
  → { events: [...], next_after_seq, has_more }

va result --run-id <id>
  → { run_id, status, summary, key_evidence: [...], suggested_next, evidence_path }

va evidence --run-id <id> [--ref <ref>] [--grep <pattern>] [--head <n>]
  → EvidenceIndex 或窗口内容
```

### 1.3 干预

```
va pause --run-id <id>
va resume --run-id <id>
va cancel --run-id <id> [--reason <string>]
va intervene --run-id <id> --instruction <string>
va ignore-rule --run-id <id> --rule-id <id>
va override --run-id <id> --decision <continue|stop|cancel>
```

### 1.4 知识 & 技能 & 设备

```
va memory add --target <id> --category <known_issue|threshold|...> "<statement>"
va memory ls [--target <id>] [--category <category>]
va memory confirm <fact-id>
va memory delete <fact-id>

va skill list [--category <cat>]
va skill show <name>
va skill create --from-run <run-id> --name <name>

va target add --file <path> | (--id <id> --serial <port> --adb <dev> --flash-method <method> ...)
va target ls / show <id> / remove <id>

va hook list [--run-id <id>]
va hook show <name>
va hook test <name> [--point <point>]

va export --run-id <id> --output <path>
va import --file <path>
```

---

## 2. MCP Tool Schema

### 2.1 validate_artifact

```typescript
Input: {
  context: {
    task: string;              // 必填
    expected: string;          // 必填
    concerns?: string[];       // 可选
    what_changed?: string;     // 可选
    test_hint?: {
      kind: "adb_shell";
      command: string;
      timeout_sec?: number;
      expected_exit_code?: number;
    };
  };
  artifact: {
    path: string;              // 必填
    type: string;              // 必填
    version?: string;
    build_id?: string;
    sha256?: string;
  };
  target: string;              // 必填。Target ID
  constraints?: {
    max_duration_sec?: number;
    allow_flash?: boolean;
    allow_shell_exec?: boolean;
    no_flash?: boolean;           // 跳过刷机（等价 CLI --no-flash）
    continuous?: boolean;         // 持续模式
    observe_interval?: number;    // checkpoint 间隔
    observe_metrics?: string[];   // 监控指标
  };
}

Output: {
  status: "accepted" | "target_busy" | "artifact_invalid" | "clarification_needed"
       | "plan_rejected" | "target_not_found" | "target_not_ready";
  run_id?: string;             // accepted 时有
  state?: string;              // accepted 时有
  reasons?: string[];          // 拒绝时有
  missing_info?: string[];     // clarification_needed 时有
  suggested_next?: string;
  failed_checks?: { check: string; error: string }[];  // target_not_ready 时有
}
```

### 2.2 get_run_status

```typescript
Input:  { run_id: string }
Output: {
  run_id: string;
  state: string;
  current_step?: { id: string; capability: string; started_at: string; timeout_sec: number };
  target: { target_id: string; state: string; serial: string; adb: string };
  elapsed_sec: number;
  last_event_seq: number;
  evidence_path: string;
}
```

### 2.3 watch_run

```typescript
Input:  { run_id: string; after_seq?: number; limit?: number; wait_sec?: number }
Output: {
  run_id: string;
  status: string;
  events: Event[];
  next_after_seq: number;
}
```

### 2.4 get_run_events / get_evidence / get_run_result

```typescript
get_run_events Input:  { run_id: string; after_seq?: number; limit?: number; types?: string[] }
get_run_events Output: { run_id: string; events: Event[]; next_after_seq: number; has_more: boolean }

get_evidence Input:      { run_id: string; ref?: string }
get_evidence Output:     EvidenceIndex | { ref: string; content: string }

get_run_result Input:    { run_id: string }
get_run_result Output:   AgentReply | { run_id: string; state: string; result_available: false }
// 非终态: state = planning | running | paused | collecting_evidence | finalizing
```

### 2.5 intervene_run / cancel_run / get_target_capabilities

```typescript
intervene_run Input: {
  run_id: string;
  action: "pause" | "resume" | "cancel" | "add_instruction" | "ignore_rule" | "override";
  instruction?: string;       // add_instruction 时
  rule_id?: string;           // ignore_rule 时
  decision?: "continue" | "stop" | "cancel";  // override 时
  reason?: string;
}
intervene_run Output: { run_id: string; accepted: boolean; action: string; event_seq?: number }

cancel_run Input:    { run_id: string; reason?: string }
cancel_run Output:   { run_id: string; accepted: boolean; status: string }
// accepted=true 表示 cancel 已被接受，Run 进入 finalizing→cancelled。
// 最终 cancelled 要在 result_ready 后才能确认。调用方用 get_run_result 轮询终态。

get_target_capabilities Input:  { target: string }
get_target_capabilities Output: { target: string; runtime_state: {...}; capabilities: Capability[] }
```

---

## 3. Event Payload Schema

```typescript
// 基础 Event
interface Event {
  seq: number;              // 有 run_id: Run 内递增; 无 run_id: 全局递增
  run_id?: string;          // 全局事件(target_state_changed/notification_sent/RuntimeStart hook_executed)可无
  time: string;             // ISO timestamp
  elapsed_sec?: number;     // Run 开始后的相对时间。全局事件为空
  type: EventType;
  severity?: "fatal" | "warning" | "info";
  source: string;
  step_id?: string;
  summary: string;
  payload: Record<string, any>;
  evidence_refs?: string[];
}

// 全局事件写入 events.jsonl（不分 Run 分区）。使用全局递增 seq。
// Run 级事件写入 runs/{run_id}/events.jsonl。使用 Run 内递增 seq。

// Lifecycle
type LifecycleEventType =
  "run_started" | "plan_generated" | "step_started" | "step_completed" |
  "step_failed" | "run_completed" | "run_failed" | "run_cancelled" |
  "run_paused" | "run_resumed" | "result_ready";

// Observation
type ObservationEventType =
  "observation" | "target_state_changed" | "human_note";

// Rule
type RuleEventType =
  "rule_matched" | "step_timeout";

// Periodic / Signal
type SignalEventType =
  "checkpoint" | "correlated" | "baseline_diff" | "stage_transition";

// Decision
type DecisionEventType =
  "decision_made" | "decision_rejected" | "suggestion_generated" | "rule_ignored" | "decision_overridden";

// Evidence / Hook / Task / Notify
type EvidenceEventType = "evidence_collected";
type HookEventType = "hook_executed";
type TaskEventType = "skipped_run";
type NotifyEventType = "notification_sent";

type EventType = LifecycleEventType | ObservationEventType | RuleEventType
  | SignalEventType | DecisionEventType | EvidenceEventType | HookEventType
  | TaskEventType | NotifyEventType;
```

---

## 4. 关键 Payload Schema

### 4.1 result_ready（Reply 发布）

```typescript
interface ResultReadyPayload {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  suggested_next: string;
  evidence_path: string;
  key_evidence: { summary: string; evidence_refs: string[] }[];
}
// RM/NotificationFilter/Store 共用此 payload
```

### 4.2 Decision（Observer 输出）

```typescript
interface Decision {
  decision: "stop" | "continue" | "collect_more" | "extend_wait" | "pause"
           | "suggest" | "observe_more_frequent" | "observe_again_at";
  reason: string;
  confidence: number;
  reasoning_trace: string;
  evidence_refs: string[];
  params?: {
    extra_wait_sec?: number;
    logs?: string[];
    observe_interval?: number;
    observe_at?: number;
  };
  suggestion?: string;
}
```

### 4.3 Plan（Planner 输出）

```typescript
interface Plan {
  plan_id: string;
  estimated_duration_sec: number;
  steps: Step[];
  evidence_policy: {
    always: string[];
    on_failure: string[];
  };
  success_criteria: string[];
  failure_signals: string[];
}
```

---

## 5. 模块间接口契约

### 4.1 Runtime → Tool

```typescript
interface RunManager {
  createRun(req: ValidateRequest): Promise<{ run_id: string; state: string }>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
}

interface StepExecutor {
  executeStep(step: Step): Promise<StepResult>;
  interrupt(): void;
  extendTimeout(seconds: number): void;
}

interface DecisionHandler {
  handleEvent(event: Event): Promise<void>;
  onOverride(runId: string, decision: string): void;
}

interface EventBus {
  emit(event: Event): void;
  subscribe(types: string[], handler: (e: Event) => void): () => void;
}

interface ContextAssembler {
  assemblePlannerInput(runId: string): Promise<{ staticPrompt: string; dynamicContext: object }>;
  assembleObserverInput(runId: string, event: Event): Promise<{ staticPrompt: string; input: object }>;
}
```

### 4.2 Tool → Store

```typescript
interface Connection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): "connected" | "disconnected" | "error";
}

interface ConnectionManager {
  getConnection(targetId: string, transport: string): Connection;
}

interface OutputPipe {
  feedStream(chunk: string): void;
  feedExec(stdout: string, stderr: string, exitCode: number): void;
}

interface RuleDetector {
  loadRunRules(system: Rule[], target: Rule[], known: Rule[]): void;
  loadStepPatterns(patterns: string[]): void;
  clearStepPatterns(): void;
  detect(line: string, lineIndex: number): void;
}
```

### 4.3 Agent → Runtime

```typescript
interface Planner {
  call(staticPrompt: string, dynamicContext: object): Promise<PlanResult>;
}

interface Observer {
  decide(staticPrompt: string, input: object): Promise<Decision>;
}

interface ReplyGenerator {
  generate(runId: string): Promise<AgentReply>;
  generateMinimal(runId: string, reason: string): Promise<AgentReply>;
  generateCancelled(runId: string, reason: string): Promise<AgentReply>;
}
```

### 4.4 Agent → Memory

```typescript
interface Memory {
  writeWorkingMemory(runId: string, entry: object): Promise<void>;
  readWorkingMemory(runId: string): Promise<object[]>;
  recallEpisodes(targetId: string, limit?: number): Promise<object[]>;
  recordEpisode(episode: object): Promise<void>;
  queryFacts(scope: string, scopeId: string, cat?: string): Promise<object[]>;
  writeFact(fact: object): Promise<void>;
  confirmFact(factId: string): Promise<void>;
  recordRunProfile(profile: object): Promise<void>;
  getLatestProfile(targetId: string): Promise<object | null>;
}
```

---

## 5. 公共错误码

```typescript
type ErrorCode =
  | "invalid_request"        // 参数缺失或格式错误
  | "target_not_found"       // Target 不存在
  | "target_busy"            // Target 被占用
  | "target_not_ready"       // Pre-flight 失败
  | "run_not_found"          // Run 不存在
  | "artifact_invalid"       // Artifact 不存在/不可读/类型不匹配
  | "plan_rejected"          // Plan 校验失败
  | "clarification_needed"   // 缺关键信息
  | "unsupported_action"     // intervene action 不支持
  | "internal_error";        // 系统内部错误

interface ErrorResponse {
  status: "error";
  error_code: ErrorCode;
  message: string;
  details?: Record<string, any>;
}
```

---

## 6. 配置 Schema

```typescript
// Target Profile
const TargetProfileSchema = z.object({
  target_id: z.string(),
  display_name: z.string().optional(),
  connections: z.object({
    serial: z.object({ port: z.string(), baud: z.number() }).optional(),
    adb: z.object({ device_id: z.string() }).optional(),
    fastboot: z.object({ device_id: z.string() }).optional(),
    ssh: z.object({ host: z.string(), port: z.number() }).optional(),
  }),
  flash: z.object({ method: z.enum(["fastboot","custom_command"]), artifact_type: z.string() }).optional(),
  recovery: z.object({ reboot_method: z.enum(["adb","fastboot","custom_command"]).optional(), stable_artifact: z.string().optional() }).optional(),
  safety: z.object({
    allow_flash: z.boolean(), allow_reboot: z.boolean(),
    allow_shell_exec: z.boolean(), allow_power_cycle: z.boolean(),
  }),
  target_hints: z.object({
    boot_markers: z.string().array().optional(),
    boot_sequence: z.object({ stage: z.string(), expected_duration: z.number() }).array().optional(),
    fail_patterns: z.string().array().optional(),
    known_quirks: z.string().array().optional(),
    recommended_checks: z.string().array().optional(),
  }).optional(),
  skills: z.string().array().optional(),
});

// LLM Config（配置侧使用嵌套结构。AgentModelConfig 是运行时拆分的版本）
const LLMConfigSchema = z.object({
  default_provider: z.string(),
  providers: z.record(z.object({
    type: z.string(), api_key_env: z.string(),
    models: z.object({ planner: z.string(), observer: z.string(), reply: z.string() }),
    timeout: z.object({ planner: z.number(), observer: z.number(), reply: z.number() }),
  })),
  observer_policy: z.object({
    debounce_sec: z.number(), max_concurrent_per_run: z.number(), default_checkpoint_interval: z.number(),
  }),
});

// Hook Config
const HookConfigSchema = z.object({
  hooks: z.object({
    name: z.string(), on: z.enum(HOOK_POINTS), match: z.record(z.string()).optional(),
    command: z.string(), timeout: z.number(),
  }).array(),
});
```
