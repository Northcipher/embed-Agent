param(
  [string]$InstallDir,
  [ValidateSet("user", "project")]
  [string]$Scope = "user",
  [string]$ProjectDir,
  [switch]$Remove,
  [switch]$PrintProjectConfig
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

function Get-UserServerConfig {
  param([string]$ResolvedInstallDir)
  return [ordered]@{
    type = "stdio"
    command = "cmd"
    args = @("/c", ('"{0}"' -f (Join-Path $ResolvedInstallDir "bin\embedagent-mcp.cmd")))
    env = @{}
  }
}

function Get-ProjectServerConfig {
  return [ordered]@{
    type = "stdio"
    command = "cmd"
    args = @("/c", '"%EMBED_AGENT_HOME%\bin\embedagent-mcp.cmd"')
    env = @{}
  }
}

function ConvertTo-OrderedMap {
  param([object]$Value)

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [System.Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $result[$key] = ConvertTo-OrderedMap $Value[$key]
    }
    return $result
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = @()
    foreach ($item in $Value) {
      $items += ,(ConvertTo-OrderedMap $item)
    }
    return $items
  }

  if ($Value -is [pscustomobject]) {
    $result = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = ConvertTo-OrderedMap $property.Value
    }
    return $result
  }

  return $Value
}

function Write-ProjectConfig {
  param(
    [string]$ResolvedProjectDir,
    [switch]$DeleteEntry
  )

  New-Item -ItemType Directory -Path $ResolvedProjectDir -Force | Out-Null
  $configPath = Join-Path $ResolvedProjectDir ".mcp.json"
  $config = [ordered]@{}

  if (Test-Path $configPath) {
    $parsed = Get-Content -Path $configPath -Raw | ConvertFrom-Json
    $config = ConvertTo-OrderedMap $parsed
  }

  if (-not $config.Contains("mcpServers") -or $null -eq $config["mcpServers"]) {
    $config["mcpServers"] = [ordered]@{}
  }

  if ($DeleteEntry) {
    $config["mcpServers"].Remove("embed-agent") | Out-Null
  } else {
    $config["mcpServers"]["embed-agent"] = Get-ProjectServerConfig
  }

  $json = $config | ConvertTo-Json -Depth 20
  Set-Content -Path $configPath -Value ($json + "`n") -Encoding UTF8
  return $configPath
}

$resolvedInstallDir = Resolve-InstallDir -ExplicitInstallDir $InstallDir

if ($PrintProjectConfig) {
  ([ordered]@{ mcpServers = [ordered]@{ "embed-agent" = Get-ProjectServerConfig } } | ConvertTo-Json -Depth 20)
  exit 0
}

if ($Scope -eq "project") {
  $resolvedProjectDir = if ($ProjectDir) {
    [System.IO.Path]::GetFullPath($ProjectDir)
  } else {
    (Get-Location).Path
  }
  $path = Write-ProjectConfig -ResolvedProjectDir $resolvedProjectDir -DeleteEntry:$Remove
  if ($Remove) {
    Write-Host "Removed Embed Agent MCP entry from $path"
  } else {
    Write-Host "Wrote Claude Code project MCP config to $path"
  }
  exit 0
}

$claude = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $claude) {
  throw "Claude Code CLI ('claude') was not found on PATH."
}

try {
  & $claude.Source mcp remove embed-agent --scope user | Out-Null
} catch {
}

if ($Remove) {
  Write-Host "Removed Embed Agent from Claude Code user MCP config."
  exit 0
}

$serverConfigJson = (Get-UserServerConfig -ResolvedInstallDir $resolvedInstallDir) | ConvertTo-Json -Depth 10 -Compress
& $claude.Source mcp add-json embed-agent $serverConfigJson --scope user | Out-Null
Write-Host "Installed Embed Agent into Claude Code (user scope). Restart Claude Code if it is already running."
