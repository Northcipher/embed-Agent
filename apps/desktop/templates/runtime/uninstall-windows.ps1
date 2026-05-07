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

function Remove-UserPathEntry {
  param([string]$Entry)

  $currentValue = [Environment]::GetEnvironmentVariable("Path", "User")
  if ([string]::IsNullOrWhiteSpace($currentValue)) {
    return
  }

  $parts = $currentValue.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
    Where-Object { -not [string]::Equals($_.TrimEnd("\"), $Entry.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase) }
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
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
$binDir = Join-Path $resolvedInstallDir "bin"
$baseLocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$defaultDataDir = Join-Path $baseLocalAppData "Embed Agent\data"

Remove-UserPathEntry -Entry $binDir

if ([string]::Equals([Environment]::GetEnvironmentVariable("EMBED_AGENT_HOME", "User"), $resolvedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  [Environment]::SetEnvironmentVariable("EMBED_AGENT_HOME", $null, "User")
}

if ([string]::Equals([Environment]::GetEnvironmentVariable("EMBED_AGENT_DATA", "User"), $defaultDataDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  [Environment]::SetEnvironmentVariable("EMBED_AGENT_DATA", $null, "User")
}

if ([string]::Equals([Environment]::GetEnvironmentVariable("EMBED_AGENT_SERVER_URL", "User"), "http://127.0.0.1:8787", [System.StringComparison]::OrdinalIgnoreCase)) {
  [Environment]::SetEnvironmentVariable("EMBED_AGENT_SERVER_URL", $null, "User")
}

try {
  & (Join-Path $resolvedInstallDir "resources\desktop-runtime\integrations\setup-claude-code.ps1") -InstallDir $resolvedInstallDir -Scope user -Remove | Out-Null
} catch {
  Write-Host "Embed Agent uninstall cleanup skipped Claude Code deregistration: $($_.Exception.Message)"
}

Send-EnvironmentRefresh
