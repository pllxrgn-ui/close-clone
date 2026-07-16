# Nightly Postgres backup for the Switchboard compose stack (ARCHITECTURE section 8).
# Windows-host equivalent of backup.sh: compressed custom-format dump
# (pg_dump -Fc) taken INSIDE the postgres container via `docker compose exec`,
# streamed to a host directory, with newest-N rotation (default 14).
#
#   powershell -File deploy\scripts\backup.ps1
#   # schedule via Task Scheduler for a nightly run.
#
# Restore + verification drill: deploy\scripts\restore.ps1.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployDir = Split-Path -Parent $ScriptDir

function Get-EnvOr([string]$Name, [string]$Default) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrEmpty($v)) { return $Default } else { return $v }
}

$BackupDir = Get-EnvOr 'BACKUP_DIR' (Join-Path $DeployDir 'backups')
$Retention = [int](Get-EnvOr 'BACKUP_RETENTION' '14') # nightly dumps to keep
$PgUser = Get-EnvOr 'PGUSER' (Get-EnvOr 'POSTGRES_USER' 'switchboard')
$PgDatabase = Get-EnvOr 'PGDATABASE' (Get-EnvOr 'POSTGRES_DB' 'switchboard')
$PgService = Get-EnvOr 'PG_SERVICE' 'postgres'
$ComposeFile = Join-Path $DeployDir 'docker-compose.yml'
$EnvFile = Join-Path $DeployDir '.env'

# Run a pg client tool inside the postgres container. Binary-safe stdout via
# Start-Process -RedirectStandardOutput (PowerShell's `>` would corrupt the dump).
function Invoke-InPg {
  param([string[]]$PgArgs, [string]$StdInFile, [string]$StdOutFile)
  $dockerArgs = @('compose', '-f', $ComposeFile, '--env-file', $EnvFile, 'exec', '-T', $PgService) + $PgArgs
  $sp = @{ FilePath = 'docker'; ArgumentList = $dockerArgs; NoNewWindow = $true; Wait = $true; PassThru = $true }
  if (-not [string]::IsNullOrEmpty($StdInFile)) { $sp['RedirectStandardInput'] = $StdInFile }
  if (-not [string]::IsNullOrEmpty($StdOutFile)) { $sp['RedirectStandardOutput'] = $StdOutFile }
  $p = Start-Process @sp
  return $p.ExitCode
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + 'Z'
$dest = Join-Path $BackupDir "switchboard-$timestamp.dump"

Write-Host "[backup] pg_dump -Fc db=$PgDatabase -> $dest"
$code = Invoke-InPg -PgArgs @('pg_dump', '-Fc', '-U', $PgUser, '-d', $PgDatabase) -StdOutFile $dest
if ($code -ne 0) { throw "[backup] pg_dump failed (exit $code)" }

# Integrity gate: a valid custom-format archive lists its table of contents.
$toc = "$dest.toc"
$code = Invoke-InPg -PgArgs @('pg_restore', '-l') -StdInFile $dest -StdOutFile $toc
Remove-Item -Force -ErrorAction SilentlyContinue $toc
if ($code -ne 0) {
  Remove-Item -Force -ErrorAction SilentlyContinue $dest
  throw '[backup] FAILED integrity check (pg_restore -l)'
}
$size = (Get-Item $dest).Length
Write-Host "[backup] ok ($size bytes)"

# --- rotation: keep the newest $Retention dumps, delete older ---
Write-Host "[backup] rotation: keep newest $Retention"
$dumps = @(Get-ChildItem -Path $BackupDir -Filter 'switchboard-*.dump' | Sort-Object LastWriteTime -Descending)
if ($dumps.Count -gt $Retention) {
  $dumps | Select-Object -Skip $Retention | ForEach-Object {
    Write-Host "[backup] rotate: rm $($_.FullName)"
    Remove-Item -Force $_.FullName
  }
}
Write-Host '[backup] done'
