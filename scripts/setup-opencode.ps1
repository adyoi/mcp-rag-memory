# Re-assert the opencode global config this repo depends on:
# mcp.rag-memory, plugin, lsp, instructions, model, permission.
# opencode updates have been observed to reset/wipe the global config.
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup-opencode.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-opencode.ps1 --check
#
# Merges into the existing config without clobbering other keys; rewrites both
# opencode.json and opencode.jsonc so whichever the new opencode reads is set.

$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot
$GLOBAL_DIR = Join-Path $HOME '.config\opencode'
$CONFIG_JSON = Join-Path $GLOBAL_DIR 'opencode.json'
$CONFIG_JSONC = Join-Path $GLOBAL_DIR 'opencode.jsonc'

function ConvertTo-WebPath([string]$p) { return $p.Replace('\', '/') }

$instructions = ConvertTo-WebPath (Join-Path $ROOT '.opencode\instructions.md')
$pluginUrl = 'file:///' + (ConvertTo-WebPath (Join-Path $ROOT '.opencode\plugin\session-logger.ts'))
$server = ConvertTo-WebPath (Join-Path $ROOT 'src\mcp\rag-server.ts')
$store = ConvertTo-WebPath (Join-Path $ROOT '.rag-data')

function New-ManagedConfig {
  return [ordered]@{
    '$schema' = 'https://opencode.ai/config.json'
    model = 'anthropic/claude-sonnet-4-6'
    lsp = $true
    instructions = @($instructions)
    plugin = @($pluginUrl)
    permission = [ordered]@{
      edit = 'allow'
      bash = [ordered]@{ 'git *' = 'allow'; '*' = 'ask' }
    }
    mcp = [ordered]@{
      'rag-memory' = [ordered]@{
        type = 'local'
        command = @('node', '--import', 'tsx', $server)
        cwd = (ConvertTo-WebPath $ROOT)
        environment = [ordered]@{ RAG_DB_DIR = $store }
      }
    }
  }
}

function Is-Dict($v) {
  if ($null -eq $v) { return $false }
  if ($v -is [string] -or $v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return $false }
  if ($v -is [System.Collections.IList]) { return $false }
  return $true
}

function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    return $null
  }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Merge-Config($base, $patch) {
  $out = [ordered]@{}
  $inBase = @{}
  if ($null -ne $base -and (Is-Dict $base)) {
    if ($base -is [System.Collections.IDictionary]) {
      foreach ($k in $base.Keys) { $inBase[[string]$k] = $base[$k] }
    } else {
      foreach ($p in $base.PSObject.Properties) { $inBase[$p.Name] = $p.Value }
    }
  }
  foreach ($k in $patch.Keys) {
    $p = $patch[$k]
    $present = $inBase.ContainsKey([string]$k)
    $b = $inBase[[string]$k]
    if ($present -and (Is-Dict $p) -and (Is-Dict $b)) {
      $out[$k] = (Merge-Config $b $p)
    } elseif ($present -and $p -is [System.Collections.IList] -and $b -is [System.Collections.IList]) {
      $out[$k] = @((@($b) + @($p)) | Sort-Object -Unique)
    } elseif ($present) {
      $out[$k] = $b
    } else {
      $out[$k] = $p
    }
  }
  foreach ($k in $inBase.Keys) {
    if (-not $out.Contains($k)) { $out[$k] = $inBase[$k] }
  }
  return $out
}

function Test-ConfigEqual($a, $b) {
  if ((Is-Dict $a) -and (Is-Dict $b)) {
    $ka = @()
    if ($a -is [System.Collections.IDictionary]) { foreach ($k in $a.Keys) { $ka += [string]$k } } else { foreach ($p in $a.PSObject.Properties) { $ka += $p.Name } }
    $kb = @()
    if ($b -is [System.Collections.IDictionary]) { foreach ($k in $b.Keys) { $kb += [string]$k } } else { foreach ($p in $b.PSObject.Properties) { $kb += $p.Name } }
    if ($ka.Count -ne $kb.Count) { return $false }
    foreach ($k in $ka) {
      if ($kb -notcontains $k) { return $false }
      if (-not (Test-ConfigEqual (Get-Prop $a $k) (Get-Prop $b $k))) { return $false }
    }
    return $true
  }
  if ($a -is [System.Collections.IList] -and $b -is [System.Collections.IList]) {
    $aa = @($a); $bb = @($b)
    if ($aa.Count -ne $bb.Count) { return $false }
    for ($i = 0; $i -lt $aa.Count; $i++) {
      if (-not (Test-ConfigEqual $aa[$i] $bb[$i])) { return $false }
    }
    return $true
  }
  return ("$a" -ceq "$b") -or ($a -eq $null -and $b -eq $null)
}

function Write-JsonValue($v) {
  if ($null -eq $v) { return 'null' }
  $t = $v.GetType()
  if ($t.Name -eq 'String') {
    $esc = $v.Replace('\', '\\').Replace('"', '\"')
    $esc = $esc -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t'
    return '"' + $esc + '"'
  }
  if ($t.Name -eq 'Boolean') { return ($v.ToString().ToLowerInvariant()) }
  if ($t.Name -in @('Int32', 'Int64', 'Single', 'Double', 'Decimal')) {
    return $v.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($v -is [System.Collections.IList]) {
    $items = @(); foreach ($i in $v) { $items += (Write-JsonValue $i) }
    return '[' + ($items -join ',') + ']'
  }
  $props = @()
  if ($v -is [System.Collections.IDictionary]) {
    foreach ($k in $v.Keys) { $props += (Write-JsonValue ([string]$k)) + ':' + (Write-JsonValue $v[$k]) }
  } else {
    foreach ($p in $v.PSObject.Properties) { $props += (Write-JsonValue ([string]$p.Name)) + ':' + (Write-JsonValue $p.Value) }
  }
  return '{' + ($props -join ',') + '}'
}

function Read-Config([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try {
    $obj = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($null -eq $obj) { return $null }
    return $obj
  } catch {
    return $null
  }
}

function Write-ConfigFile([string]$file, $value) {
  $text = (Write-JsonValue $value) + "`r`n"
  [System.IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Backup-Broken([string]$file) {
  $backup = "$file.bak-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  Move-Item -LiteralPath $file -Destination $backup
  Write-Warning "unreadable opencode config, moved to $backup"
}

$check = $args -contains '--check'

$missing = @()
if (-not (Test-Path -LiteralPath $instructions)) { $missing += 'instructions.md' }
if (-not (Test-Path -LiteralPath (Join-Path $ROOT '.opencode\plugin\session-logger.ts'))) { $missing += 'session-logger.ts plugin' }
if (-not (Test-Path -LiteralPath $server)) { $missing += 'src/mcp/rag-server.ts' }
if ($missing.Count -gt 0) {
  Write-Error "setup-opencode: missing repo files (run from this repo): $($missing -join ', ')"
  exit 1
}

New-Item -ItemType Directory -Force -Path $GLOBAL_DIR | Out-Null

$jsonBase = $null
$jsoncBase = $null
if (Test-Path -LiteralPath $CONFIG_JSON) {
  $jsonBase = Read-Config $CONFIG_JSON
  if ($null -eq $jsonBase) { Backup-Broken $CONFIG_JSON }
}
if (Test-Path -LiteralPath $CONFIG_JSONC) {
  $jsoncBase = Read-Config $CONFIG_JSONC
  if ($null -eq $jsoncBase) { Backup-Broken $CONFIG_JSONC }
}

# Union both existing files (either may hold user keys) then fill gaps with the
# managed defaults. Managed keys never clobber existing values.
$merged = Merge-Config $jsonBase (New-ManagedConfig)
if ($null -ne $jsoncBase) { $merged = Merge-Config $jsoncBase $merged }

if ($check) {
  $upToDate = (Test-ConfigEqual (Read-Config $CONFIG_JSON) $merged) -and (Test-ConfigEqual (Read-Config $CONFIG_JSONC) $merged)
  if ($upToDate) {
    Write-Output 'global opencode config is up to date'
    exit 0
  }
  Write-Output 'global opencode config is out of date (run without --check to apply)'
  exit 1
}

$written = @()
foreach ($file in @($CONFIG_JSON, $CONFIG_JSONC)) {
  if (Test-ConfigEqual (Read-Config $file) $merged) { continue }
  Write-ConfigFile $file $merged
  $written += $file
}
if ($written.Count -eq 0) {
  Write-Output 'global opencode config is up to date'
  exit 0
}
Write-Output "wrote opencode config: $($written -join ', ')"
Write-Output 'restart opencode to load: plugin, mcp rag-memory, lsp, instructions'