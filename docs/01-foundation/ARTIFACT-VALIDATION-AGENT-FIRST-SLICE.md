# Artifact Validation Agent 第一条 Demo 链

> 状态：Draft  
> 日期：2026-04-28  
> 目的：定义第一版最小 demo，避免再次发散。

## 1. 结论

第一条链只做一次受控真机验证：

```text
Coding Agent / Human 提交 artifact + context
-> Task Planner 或手写 Plan 生成验证计划
-> Runtime 根据 Target Profile 匹配能力
-> flash 到一块 board
-> watch serial
-> wait adb
-> adb shell smoke_test
-> Rule Engine 快速检测异常
-> Observer 低频或事件触发判断是否补采集
-> collect dmesg / logcat / serial window
-> evidence package
-> Agent Reply / validation report
```

实现顺序不是 LLM-first。

```text
先用手写 Plan 跑通 Runtime-only。
再接 Task Planner / Observer / Reply Generator。
```

## 2. 为什么选这条

因为它验证最核心的问题：

```text
产物真机验证这件重复工作，
能不能被系统稳定接住，
并且比普通 Runner 更会留现场和回传结论。
```

它不需要：

- 多 target。
- CI 认证。
- 远端存储。
- 完整 TUI Console / 多设备看板。
- labgrid / LAVA 集成。
- 完整调度系统。

完整形态需要一个受控 LLM Brain：

- Task Planner：任务开始时规划一次。
- Observer：运行中定期或事件触发观察。
- Reply Generator：结束时生成回复。

LLM 不直接执行工具。

## 3. 最小 Target Profile

```json
{
  "target_id": "board-01",
  "connections": {
    "serial": {
      "port": "/dev/ttyUSB0",
      "baud": 115200
    },
    "adb": {
      "device_id": "ABC123"
    }
  },
  "flash": {
    "method": "fastboot",
    "artifact_type": "firmware_img"
  },
  "target_hints": {
    "boot_markers": ["Booting Linux", "init started", "boot completed"],
    "fail_patterns": ["kernel panic", "kernel oops", "init service timeout"]
  },
  "safety": {
    "allow_flash": true,
    "allow_reboot": true,
    "allow_power_cycle": false
  }
}
```

Human 配置这些目标事实。  
Agent 不猜板子协议，也不猜连接参数。

## 4. 最小 validate_artifact 输入

```json
{
  "context": {
    "task": "验证 boot crash 是否修复",
    "what_changed": "调整 init service 启动顺序",
    "expected": "设备能启动完成，ADB 能回来，不再出现 kernel panic",
    "concerns": ["kernel panic", "init timeout", "adb offline"],
    "test_hint": {
      "kind": "adb_shell",
      "command": "/vendor/bin/smoke_test",
      "timeout_sec": 60,
      "expected_exit_code": 0
    }
  },
  "artifact": {
    "path": "/builds/latest/firmware.img",
    "type": "firmware_img"
  },
  "target": "board-01",
  "constraints": {
    "max_duration_sec": 600,
    "allow_flash": true,
    "allow_reboot": true,
    "allow_power_cycle": false
  }
}
```

## 5. 最小能力推断

Runtime 从 Target Profile 推断：

```json
{
  "target_id": "board-01",
  "available_capabilities": {
    "flash": true,
    "watch_serial": true,
    "wait_adb": true,
    "shell_exec": true,
    "check_process": true,
    "collect_logs": true,
    "save_snapshot": true,
    "power_cycle": false
  }
}
```

Task Planner 只在这些能力里规划。

## 6. 最小 Plan

```json
{
  "plan_id": "plan-001",
  "estimated_duration_sec": 360,
  "steps": [
    {
      "id": "step-1",
      "capability": "flash",
      "condition": "always",
      "input": {
        "artifact_ref": "firmware_img",
        "artifact_type": "firmware_img"
      },
      "timeout_sec": 300,
      "on_failure": "collect_and_fail"
    },
    {
      "id": "step-2",
      "capability": "watch_serial",
      "condition": "always",
      "input": {
        "duration_sec": 180,
        "patterns": ["kernel panic", "kernel oops", "init service timeout", "boot completed"]
      },
      "timeout_sec": 180,
      "on_failure": "collect_and_fail"
    },
    {
      "id": "step-3",
      "capability": "wait_adb",
      "condition": "always",
      "input": {
        "timeout_sec": 180
      },
      "timeout_sec": 180,
      "on_failure": "collect_and_fail"
    },
    {
      "id": "step-4",
      "capability": "shell_exec",
      "condition": "always",
      "input": {
        "command": "/vendor/bin/smoke_test",
        "timeout_sec": 60,
        "expected_exit_code": 0
      },
      "timeout_sec": 60,
      "on_failure": "collect_and_fail"
    },
    {
      "id": "step-5",
      "capability": "collect_logs",
      "condition": "on_failure",
      "input": {
        "items": ["serial_last_window", "dmesg", "logcat"]
      },
      "timeout_sec": 120
    }
  ],
  "success_criteria": ["boot completed", "adb online", "smoke_test exit code 0", "no kernel panic"],
  "failure_signals": ["kernel panic", "init service timeout followed by boot hang", "adb offline after timeout"],
  "observer_focus": [
    "kernel panic",
    "init service timeout",
    "adb offline too long",
    "smoke command hang"
  ]
}
```

Run Orchestrator 校验 Plan 后才调 Tool Adapter。

## 7. 最小观察规则

Rule Engine：

```json
{
  "rules": [
    {
      "source": "serial",
      "pattern": "panic|kernel oops|segfault",
      "event": "boot_crash_signal",
      "default_action": "snapshot_and_escalate"
    },
    {
      "source": "adb_shell",
      "exit_code_not": 0,
      "event": "smoke_failed",
      "default_action": "collect_logs_and_fail"
    }
  ],
  "timeouts": {
    "total_sec": 600,
    "serial_silence_sec": 60,
    "adb_offline_sec": 180
  }
}
```

Observer 输入不是完整日志，而是事件摘要：

```json
{
  "phase": "watch_serial",
  "elapsed_sec": 42,
  "recent_events": [
    { "time": "+30s", "event": "serial_line", "summary": "init service timeout" },
    { "time": "+42s", "event": "boot_crash_signal", "summary": "kernel panic matched" }
  ],
  "target_state": {
    "serial": "active",
    "adb": "offline"
  }
}
```

Observer 输出意图：

```json
{
  "intent": "stop",
  "reason": "kernel panic detected after init service timeout",
  "confidence": 0.95,
  "requested_actions": [
    {
      "capability": "collect_logs",
      "input": {
        "items": ["serial_last_window"]
      }
    },
    {
      "capability": "save_snapshot",
      "input": {
        "reason": "kernel panic detected",
        "include": ["serial_last_window", "target_state", "events"]
      }
    }
  ],
  "report_to_caller": true
}
```

## 8. 最小输出

```json
{
  "run_id": "run-001",
  "status": "failed",
  "phase": "collecting_evidence",
  "target": "board-01",
  "artifact": {
    "path": "/builds/latest/firmware.img",
    "sha256": "optional"
  },
  "summary": "刷机成功，启动 42 秒后 serial 出现 kernel panic。panic 前 12 秒出现 init service timeout。",
  "key_evidence": [
    {
      "source": "serial",
      "time": "+30s",
      "summary": "init service timeout"
    },
    {
      "source": "serial",
      "time": "+42s",
      "summary": "kernel panic"
    }
  ],
  "suggested_next": "优先检查 init service 启动顺序和 timeout 设置。",
  "evidence_path": "/var/artifact-validation/runs/run-001",
  "report_path": "/var/artifact-validation/runs/run-001/report.json"
}
```

## 9. Evidence 目录

```text
run-001/
  request.json
  target-profile.json
  inferred-capabilities.json
  plan.json
  timeline.json
  events.jsonl
  observer-notes.jsonl
  flash.log
  serial.log
  adb-smoke_test.json
  dmesg.log
  logcat.log
  snapshots/
  report.json
  agent-reply.json
```

## 10. 验收标准

Runtime-only 验收必须先满足：

- 能配置一个 Target Profile。
- 能从 Target Profile 推断能力。
- 能调用 `validate_artifact` 创建 run。
- 能接收或加载一份手写 Plan。
- 能由 Runtime 校验 Plan。
- 能执行 flash。
- 能抓 serial。
- 能等 ADB。
- 能执行 smoke command。
- 能采 dmesg / logcat。
- 能由 Rule Engine 标记 pattern / timeout / exit code。
- 能保存 evidence package。
- 能生成规则版 Agent Reply / validation report。

LLM-enhanced 验收在 Runtime-only 跑通后再做：

- 能用 Task Planner 生成结构化 Plan。
- 能在关键事件后触发 Observer。
- 能按 Observer 意图补采集，但动作必须由 Runtime 校验。
- 能用 Reply Generator 生成更完整的 Agent Reply / validation report。

## 11. 故意不覆盖

第一条 demo 不覆盖：

- 定时任务。
- CI artifact 下载。
- 多 target。
- target reservation。
- remote storage。
- 完整 TUI Console。
- labgrid adapter。
- 权限系统。
- baseline 趋势。
- 代码根因定位。

## 12. Go / No-Go

跑完 demo 后只问一个问题：

```text
这是否明显比普通 Runner / cron + shell 脚本更稳定、更可追踪、更少丢现场？
```

如果答案是否，项目暂停。  
如果答案是，再继续做 P1。
