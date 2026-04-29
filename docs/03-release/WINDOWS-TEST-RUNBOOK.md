# Windows Test Runbook

> Release: `v0.1.0-alpha.1`
> Date: 2026-04-29
> Audience: Windows 10/11 tester using PowerShell.

## 1. Prerequisites

Install these first:

| Tool | Required | Notes |
|---|---:|---|
| Git for Windows | Yes | Use PowerShell or Windows Terminal. |
| Node.js | Yes | Use Node `22.x` or `24.x`; repo requires `>=22 <26`. |
| pnpm | Yes | Use Corepack to activate pnpm `10.33.0`. |
| Android platform-tools | Optional | Only needed for real ADB/Fastboot testing. |
| USB serial driver | Optional | Only needed for real serial testing. |

PowerShell setup:

```powershell
node --version
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm --version
```

Expected:

```text
node version starts with v22 or v24
pnpm version is 10.33.0
```

## 2. Clone And Install

```powershell
git clone <repo-url> embed-Agent
cd embed-Agent
git checkout v0.1.0-alpha.1
pnpm install --frozen-lockfile
```

If you are testing before the tag is available, checkout `main` after Codex reports the release commit and tag push.

## 3. Run Quality Gates

Run these from the repo root:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Pass criteria:

```text
typecheck exits 0
test exits 0
build exits 0
```

Do not continue to fake smoke testing if any gate fails.

## 4. Start Runtime Server

Open Terminal A:

```powershell
pnpm --filter @artifact-validation/runtime-server dev -- --adapter fake --demo-plan --execute-inline --no-targets --root-dir .artifact-agent-windows
```

This command overrides the default runtime data directory so Windows smoke-test files stay under `.artifact-agent-windows`.

Expected output:

```text
Artifact Validation Runtime listening on http://127.0.0.1:3456
Runtime data root: <repo>\.artifact-agent-windows
```

Keep Terminal A running.

## 5. Create A Fake Artifact Request

Open Terminal B in the same repo root:

```powershell
New-Item -ItemType Directory -Force .\tmp | Out-Null
Set-Content -Path .\tmp\firmware.img -Value "fake firmware"

$artifactPath = (Resolve-Path .\tmp\firmware.img).Path
$request = @{
  context = @{
    task = "Validate fake boot smoke path on Windows"
    what_changed = "Windows release smoke test"
    expected = "fake target completes validation"
    concerns = @("kernel panic", "adb offline")
    test_hint = @{
      kind = "adb_shell"
      command = "/vendor/bin/smoke_test"
      timeout_sec = 60
      expected_exit_code = 0
    }
  }
  artifact = @{
    path = $artifactPath
    type = "firmware_img"
  }
  target = "board-01"
  constraints = @{
    max_duration_sec = 600
    allow_flash = $true
    allow_reboot = $true
    allow_power_cycle = $false
  }
} | ConvertTo-Json -Depth 10

$request | Set-Content -Path .\tmp\validate.json -Encoding utf8
```

## 6. Submit Validation

Use the Runtime HTTP API directly:

```powershell
$response = Invoke-RestMethod `
  -Uri "http://127.0.0.1:3456/api/validate-artifact" `
  -Method Post `
  -ContentType "application/json" `
  -InFile .\tmp\validate.json

$response | ConvertTo-Json -Depth 10
$runId = $response.run_id
```

Expected:

```text
status = accepted
state = completed
target = board-01
run_id is present
evidence_path is present
```

## 7. Inspect Status, Events, Evidence, Result

```powershell
Invoke-RestMethod "http://127.0.0.1:3456/api/runs/$runId/status" |
  ConvertTo-Json -Depth 10

Invoke-RestMethod "http://127.0.0.1:3456/api/runs/$runId/events?after_seq=0&limit=50" |
  ConvertTo-Json -Depth 10

Invoke-RestMethod "http://127.0.0.1:3456/api/runs/$runId/evidence" |
  ConvertTo-Json -Depth 10

Invoke-RestMethod "http://127.0.0.1:3456/api/runs/$runId/result" |
  ConvertTo-Json -Depth 10
```

Expected evidence refs include:

```text
flash:log
serial:full
adb:step-smoke
log:dmesg
```

Files are written under:

```text
.artifact-agent-windows\runs\<run_id>\
```

## 8. Optional CLI Check

After `pnpm build`, the CLI can call the same Runtime Server:

```powershell
node .\apps\cli\dist\index.js --runtime-url http://127.0.0.1:3456 status $runId
node .\apps\cli\dist\index.js --runtime-url http://127.0.0.1:3456 events $runId --limit 20
node .\apps\cli\dist\index.js --runtime-url http://127.0.0.1:3456 evidence $runId
node .\apps\cli\dist\index.js --runtime-url http://127.0.0.1:3456 result $runId
```

## 9. Optional TUI Fixture Check

The current TUI is a Run Cockpit fixture, not live polling yet:

```powershell
node .\apps\tui\dist\index.js
```

Pass criteria:

```text
Terminal renders Run, Target, Current Step, Timeline, Evidence, and Result sections.
```

## 10. Optional MCP Server Configuration

Start Runtime Server first. Then configure an MCP host to launch:

```json
{
  "mcpServers": {
    "artifact-validation": {
      "command": "node",
      "args": ["C:\\path\\to\\embed-Agent\\apps\\mcp-server\\dist\\index.js"],
      "env": {
        "ARTIFACT_VALIDATION_RUNTIME_URL": "http://127.0.0.1:3456"
      }
    }
  }
}
```

The MCP server is a thin adapter. It does not own device state and requires Runtime Server to be running.

## 11. Real Hardware Notes

For this release, default testing should stay on fake adapter.

Real hardware testing is not certified on Windows yet. If you test it anyway:

- Install Android platform-tools and ensure `adb.exe` / `fastboot.exe` are in `PATH`.
- Install the board USB serial driver and confirm the COM port in Windows Device Manager.
- Update target profiles to use Windows serial ports such as `COM3`.
- Start with `--adapter real` only after confirming the target profile has one target.
- Keep `allow_power_cycle=false`; power control is out of P0 scope.

Example shape:

```powershell
pnpm --filter @artifact-validation/runtime-server dev -- --adapter real --targets-dir configs/targets --root-dir .artifact-agent-real
```

## 12. Failure Collection

If anything fails, collect:

```powershell
node --version
pnpm --version
git rev-parse HEAD
git status --short --branch
pnpm typecheck
pnpm test
pnpm build
```

Also zip or copy:

```text
.artifact-agent-windows\runs\<run_id>\
tmp\validate.json
```

Do not include real API keys, real serial numbers, or private device logs when sharing externally.
