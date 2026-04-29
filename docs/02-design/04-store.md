# Store 详细设计

> 状态：Draft / 日期：2026-04-29
> 对应架构: Section 24

## 1. 存储布局

```
.embed-agent/
  events.jsonl                    # 全局/system 级 Event（无 run_id 的事件）
  runs/{run_id}/
    run.json                      # Run 状态
    events.jsonl                  # Run 级 Event Stream
    evidence-index.json
    serial.log / dmesg.log / ...
    snapshots/...
    brain/ {planner,observer}*.json, reply.json

  targets/{target_id}/
    profile.yml
    runtime-state.json

  memory/
    episodes.jsonl
    semantic-facts.jsonl
    working-memory/{run_id}.json  # Working Memory
    run-profiles/{run_id}.json    # RunProfile

  skills/
    validate-boot.yml
    custom/
```

---

## 2. Event Store

```typescript
interface EventStore {
  // Run 级事件（有 run_id）
  append(runId: string, event: Event): Promise<{ seq: number }>;
  // 自动分配 run 内递增 seq。填 time + elapsed_sec。
  // 写 runs/{run_id}/events.jsonl

  // 全局事件（无 run_id: target_state_changed, notification_sent, RuntimeStart hook_executed...）
  appendGlobal(event: Event): Promise<{ seq: number }>;
  // 写 events.jsonl。用全局递增 seq。

  read(runId: string, afterSeq?: number, limit?: number): Promise<Event[]>;
  readGlobal(afterSeq?: number, limit?: number): Promise<Event[]>;
}
```

**持久化：** Event Store 订阅 Event Bus。有 run_id → append；无 → appendGlobal。

```typescript
eventBus.subscribe(["*"], (event) => {
  if (event.run_id) {
    const { seq } = eventStore.append(event.run_id, event);
    // 回写 lastEventSeq 到 Run Store
    runStore.updateLastEventSeq(event.run_id, seq);
  } else {
    eventStore.appendGlobal(event);
  }
});
```

---

## 3. Evidence Store

```typescript
interface EvidenceStore {
  write(runId: string, ref: string, data: string | Buffer): Promise<{ path: string; bytes: number }>;
  read(runId: string, ref: string): Promise<{ path: string; size: number; available: boolean }>;
  getIndex(runId: string): Promise<EvidenceIndex>;
  updateKeyEvents(runId: string, keyEvent: KeyEvent): Promise<void>;
}

// KeyEvent: Rule 命中或关键检查点对应的证据索引条目
interface KeyEvent {
  seq: number;           // 对应的 Event seq
  summary: string;       // 人可读描述
  evidenceRefs: string[];// 关联证据 refs
}

interface EvidenceIndex {
  runId: string;
  partial: boolean;
  updatedAt: string;
  rootPath: string;
  refs: { ref: string; kind: "log" | "window" | "snapshot"; path: string; available: boolean; bytes?: number }[];
  keyEvents: KeyEvent[];
}
```

文件层（write/read 流式大文件）+ 索引层（updateKeyEvents/getIndex 原子覆盖）。先写文件再更新索引。

---

## 4. Run Store

```typescript
interface RunStore {
  create(run: RunRecord): Promise<void>;
  update(runId: string, patch: Partial<RunRecord>): Promise<void>;
  updateLastEventSeq(runId: string, seq: number): Promise<void>;  // Event Store 回调
  get(runId: string): Promise<RunRecord>;
  listNonTerminal(): Promise<RunRecord[]>;
}

interface RunRecord {
  runId: string;
  state: "planning" | "running" | "paused" | "collecting_evidence" | "finalizing" | "completed" | "failed" | "cancelled";
  targetId: string;
  artifact: { path: string; type: string; version?: string; buildId?: string };
  currentStepId?: string;
  elapsedSec: number;
  lastEventSeq: number;      // Event Store append 时回写
  evidenceRoot: string;
  failureReason?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}
```

**listNonTerminal():** 返回状态为 planning/running/paused/collecting_evidence/finalizing 的 Run。
Host 启动时遍历，判定 stale 并恢复。

---

## 5. Target Store

```typescript
interface TargetStore {
  get(targetId: string): Promise<TargetProfile>;
  getState(targetId: string): Promise<TargetRuntimeState>;
  updateState(targetId: string, patch: Partial<TargetRuntimeState>): Promise<void>;
  listAll(): Promise<TargetProfile[]>;
  listStates(): Promise<TargetRuntimeState[]>;  // 批量运行时状态。恢复/锁清理用。
  add(profile: TargetProfile): Promise<void>;
}

interface TargetRuntimeState {
  targetId: string;
  state: "idle" | "preparing" | "busy" | "cleaning" | "dirty" | "recovery" | "offline";
  currentRunId?: string;
  serial: "connected" | "disconnected";
  adb: "online" | "offline" | "disconnected";
  fastboot: "connected" | "disconnected";
  lastHeartbeatAt?: string;
  updatedAt: string;
}
```

---

## 6. Memory Store

```typescript
interface MemoryStore {
  writeWorkingMemory(runId: string, entries: WorkingMemoryEntry[]): Promise<void>;
  readWorkingMemory(runId: string): Promise<WorkingMemoryEntry[]>;

  writeEpisode(episode: Episode): Promise<void>;
  listByTarget(targetId: string, limit?: number): Promise<Episode[]>;

  writeFact(fact: SemanticFact): Promise<void>;
  updateFact(factId: string, patch: Partial<SemanticFact>): Promise<void>;
  queryFacts(scope: string, scopeId: string, category?: string, verifiedOnly?: boolean): Promise<SemanticFact[]>;
  deleteFact(factId: string): Promise<void>;

  writeProfile(profile: RunProfile): Promise<void>;
  getLatestProfile(targetId: string): Promise<RunProfile | null>;
}
```

**落盘位置：**
- Working Memory → `memory/working-memory/{run_id}.json`
- Episode → `memory/episodes.jsonl`
- SemanticFact → `memory/semantic-facts.jsonl`
- RunProfile → `memory/run-profiles/{run_id}.json`

---

## 7. Skill Store

```typescript
interface SkillStore {
  loadAll(): Promise<Skill[]>;
  load(name: string): Promise<Skill>;
  loadByTarget(targetId: string): Promise<Skill[]>;
  save(name: string, skill: Skill): Promise<void>;
}
```

---

## 8. 持久化原则

```
1. 先写原始 evidence，再写 index ref
2. Event.append 后立即回写 lastEventSeq 到 Run Store
3. 先写 event，再推进状态
4. LLM 输出单独落盘(brain/)，不混入原始 evidence
5. Evidence Index 更新失败必须发 event
6. 原子写入: 临时文件 + rename
7. Event 分区: 有 run_id → runs/{id}/；无 run_id → events.jsonl
```
