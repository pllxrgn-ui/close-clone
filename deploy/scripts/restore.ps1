# Scripted RESTORE DRILL for the Switchboard compose stack (ARCHITECTURE section 8).
# Windows-host equivalent of restore.sh.
#
#   powershell -File deploy\scripts\restore.ps1 [path\to\dump]
#
# Restores the dump into a fresh SCRATCH database, runs a row-count sanity query,
# prints a PASS/FAIL verdict, then drops the scratch db. It NEVER touches the
# production database. Exit code 0 = PASS, 1 = FAIL (wire into monitoring to
# catch silent backup rot). A real overwrite-prod restore is the README runbook.
param([string]$DumpPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployDir = Split-Path -Parent $ScriptDir

function Get-EnvOr([string]$Name, [string]$Default) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrEmpty($v)) { return $Default } else { return $v }
}

$BackupDir = Get-EnvOr 'BACKUP_DIR' (Join-Path $DeployDir 'backups')
$PgUser = Get-EnvOr 'PGUSER' (Get-EnvOr 'POSTGRES_USER' 'switchboard')
$PgDatabase = Get-EnvOr 'PGDATABASE' (Get-EnvOr 'POSTGRES_DB' 'switchboard')
$PgService = Get-EnvOr 'PG_SERVICE' 'postgres'
$ComposeFile = Join-Path $DeployDir 'docker-compose.yml'
$EnvFile = Join-Path $DeployDir '.env'

# Core tables whose presence proves a meaningful restore (C1 spine).
$CoreTables = @('users', 'leads', 'contacts', 'activities')

function Invoke-InPg {
  param([string[]]$PgArgs, [string]$StdInFile, [string]$StdOutFile)
  $dockerArgs = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'exec', '-T', $PgService) + $PgArgs
  $sp = @{ FilePath = 'docker'; ArgumentList = $dockerArgs; NoNewWindow = $true; Wait = $true; PassThru = $true }
  if (-not [string]::IsNullOrEmpty($StdInFile)) { $sp['RedirectStandardInput'] = $StdInFile }
  if (-not [string]::IsNullOrEmpty($StdOutFile)) { $sp['RedirectStandardOutput'] = $StdOutFile }
  $p = Start-Process @sp
  return $p.ExitCode
}

function Get-RowCount([string]$Db, [string]$Table) {
  $out = & docker compose -f $ComposeFile --env-file $EnvFile exec -T $PgService `
    psql -U $PgUser -d $Db -tAc "SELECT count(*) FROM $Table"
  if ($LASTEXITCODE -ne 0) { return 'ERR' }
  return ($out | Out-String).Trim()
}

# Pick the dump: explicit arg, else newest in BACKUP_DIR.
$Dump = $DumpPath
if ([string]::IsNullOrEmpty($Dump)) {
  $newest = Get-ChildItem -Path $BackupDir -Filter 'switchboard-*.dump' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -ne $newest) { $Dump = $newest.FullName }
}
if ([string]::IsNullOrEmpty($Dump) -or -not (Test-Path $Dump)) {
  Write-Error "[restore] no dump found (looked in $BackupDir); pass a path explicitly"
  exit 1
}

$Scratch = 'switchboard_restore_drill_' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
$verdict = 'PASS'
$note = ''

try {
  Write-Host "[restore] drill: $Dump -> scratch db '$Scratch' (prod db '$PgDatabase' untouched)"
  $null = Invoke-InPg -PgArgs @('createdb', '-U', $PgUser, $Scratch)

  $code = Invoke-InPg -PgArgs @('pg_restore', '--no-owner', '--no-privileges', '-U', $PgUser, '-d', $Scratch) -StdInFile $Dump
  if ($code -ne 0) { $verdict = 'FAIL'; $note = 'pg_restore reported errors' }

  $total = 0
  foreach ($t in $CoreTables) {
    $prod = Get-RowCount $PgDatabase $t
    $scratch = Get-RowCount $Scratch $t
    Write-Host "[restore]   $t`: prod=$prod scratch=$scratch"
    if ($scratch -eq 'ERR' -or [string]::IsNullOrEmpty($scratch)) {
      $verdict = 'FAIL'; $note = "core table '$t' not queryable in restored db"
    }
    else {
      $total += [int]$scratch
    }
  }
  # Parity (prod vs scratch) is reported above but NOT a hard gate — live prod
  # legitimately drifts ahead of an older dump. The gate is: restore succeeded
  # and every core table is present + queryable.
}
finally {
  $null = Invoke-InPg -PgArgs @('dropdb', '--if-exists', '-U', $PgUser, $Scratch)
}

Write-Host '[restore] ================================================'
if ($verdict -eq 'PASS') {
  Write-Host "[restore] RESTORE DRILL VERDICT: PASS (core schema restored; $total rows across core tables)"
}
else {
  Write-Host "[restore] RESTORE DRILL VERDICT: FAIL - $note"
}
Write-Host '[restore] ================================================'

if ($verdict -ne 'PASS') { exit 1 }
