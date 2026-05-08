param(
  [string]$InstallDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-InstallDir {
  param([string]$ExplicitInstallDir)
  if ($ExplicitInstallDir) {
    return [System.IO.Path]::GetFullPath($ExplicitInstallDir)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
}

function Add-UserPathEntry {
  param([string]$Entry)

  $currentValue = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if (-not [string]::IsNullOrWhiteSpace($currentValue)) {
    $parts = $currentValue.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
  }

  foreach ($part in $parts) {
    if ([string]::Equals($part.TrimEnd("\"), $Entry.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }

  $updatedValue = if ([string]::IsNullOrWhiteSpace($currentValue)) {
    $Entry
  } else {
    "$currentValue;$Entry"
  }
  [Environment]::SetEnvironmentVariable("Path", $updatedValue, "User")
}

function Send-EnvironmentRefresh {
  $signature = @"
using System;
using System.Runtime.InteropServices;

public static class NativeMethods {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd,
    int Msg,
    UIntPtr wParam,
    string lParam,
    int fuFlags,
    int uTimeout,
    out UIntPtr lpdwResult
  );
}
"@

  Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null
  $result = [UIntPtr]::Zero
  [NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result) | Out-Null
}

$resolvedInstallDir = Resolve-InstallDir -ExplicitInstallDir $InstallDir
$wrapperSourceDir = Join-Path $resolvedInstallDir "desktop-runtime\integrations\windows\bin"
$binDir = Join-Path $resolvedInstallDir "bin"
$baseLocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$dataDir = Join-Path $baseLocalAppData "EmbedAgent\data"

New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -Path (Join-Path $wrapperSourceDir "*.cmd") -Destination $binDir -Force

[Environment]::SetEnvironmentVariable("EMBED_AGENT_HOME", $resolvedInstallDir, "User")
[Environment]::SetEnvironmentVariable("EMBED_AGENT_DATA", $dataDir, "User")
[Environment]::SetEnvironmentVariable("EMBED_AGENT_SERVER_URL", "http://127.0.0.1:8787", "User")
Add-UserPathEntry -Entry $binDir
Send-EnvironmentRefresh

try {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $resolvedInstallDir "desktop-runtime\integrations\setup-claude-code.ps1") -InstallDir $resolvedInstallDir -Scope user | Out-Null
} catch {
  Write-Host "EmbedAgent installed. Claude Code auto-registration skipped: $($_.Exception.Message)"
}
