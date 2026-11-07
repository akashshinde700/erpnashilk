#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the ManuFlow Tally Connector (read-only: TallyPrime -> ManuFlow) so it starts with Windows.

.DESCRIPTION
  * Copies manuflow-tally-connector.mjs to C:\ProgramData\ManuFlowTallyConnector (or -InstallDir).
  * Restricts that folder to Administrators, SYSTEM and the LOCAL SERVICE account (the token file is in it).
  * Pairs the connector once if -Server and -Code are given (the one-time code from ManuFlow -> Import Center ->
    Import from Tally -> Connect Tally). Later restarts need no code.
  * Registers the scheduled task "ManuFlow Tally Connector":
      - runs as NT AUTHORITY\LOCAL SERVICE (no password stored, no administrator rights, no window);
      - starts at Windows startup, and is started again every 5 minutes if it is not running
        (a second copy exits at once: the connector allows one running copy per settings file);
      - no time limit; runs on battery.
  Nothing is opened to the network: the connector only connects OUT to ManuFlow over HTTPS. Tally's port 9000 stays
  closed to the internet. The connector sends Tally only read-only Export requests.

  This script was written for Windows 10 / 11 and Windows Server 2016+ with Windows PowerShell 5.1; it has NOT yet been
  run on a real Windows PC (docs/tally-connector-windows.md, "Status").

.EXAMPLE
  # First installation on the TallyPrime PC (PowerShell as administrator):
  .\install-connector.ps1 -Server https://www.example-manuflow.com -Code ABCDE-FGHJK

.EXAMPLE
  # Tally on another PC in the office:
  .\install-connector.ps1 -Server https://www.example-manuflow.com -Code ABCDE-FGHJK -Tally http://192.168.1.20:9000
#>
[CmdletBinding()]
param(
  [string]$Server,
  [string]$Code,
  [string]$Tally = 'http://127.0.0.1:9000',
  [string]$InstallDir = (Join-Path $env:ProgramData 'ManuFlowTallyConnector'),
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ManuFlow Tally Connector'
$RunAs = 'NT AUTHORITY\LOCAL SERVICE'
$Source = Join-Path (Split-Path -Parent $PSScriptRoot) 'manuflow-tally-connector.mjs'

# --- Node.js 18 or newer (an absolute path: the task does not use this window's PATH)
if (-not $NodePath) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'Node.js was not found. Install Node.js 18 LTS or newer from https://nodejs.org (for all users), then run this again.' }
  $NodePath = $cmd.Source
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node.js not found at $NodePath" }
$major = [int]((& $NodePath -p 'process.versions.node.split(".")[0]').Trim())
if ($major -lt 18) { throw "Node.js $major is too old; version 18 or newer is needed." }
if ($NodePath -like "$env:USERPROFILE*") {
  Write-Warning "Node.js is installed inside your user profile ($NodePath). The LOCAL SERVICE account may not be able to run it; install Node.js for all users (C:\Program Files\nodejs) if the connector does not start."
}
if (-not (Test-Path -LiteralPath $Source)) { throw "manuflow-tally-connector.mjs not found next to this script's folder ($Source)." }

# --- folder: Administrators + SYSTEM full control, LOCAL SERVICE modify (token rotation, log); nobody else
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $InstallDir 'manuflow-tally-connector.mjs') -Force
# Well-known SIDs, so this works in every Windows language: S-1-5-32-544 Administrators, S-1-5-18 SYSTEM, S-1-5-19 LOCAL SERVICE
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set the folder permissions (icacls).' }

$Script = Join-Path $InstallDir 'manuflow-tally-connector.mjs'
$Config = Join-Path $InstallDir 'connector.json'
$Log = Join-Path $InstallDir 'logs\connector.log'

# --- pair once (the code is single-use and expires after 10 minutes; it is not stored)
if ($Server -and $Code) {
  & $NodePath $Script pair --server $Server --code $Code --tally $Tally --config $Config
  if ($LASTEXITCODE -ne 0) { throw 'Pairing failed (see the message above). Create a new code in ManuFlow and run this again.' }
} elseif (-not (Test-Path -LiteralPath $Config)) {
  throw 'Not paired yet: run this again with -Server <ManuFlow address> -Code <code from ManuFlow>.'
} else {
  Write-Host 'Already paired: keeping the existing settings (no new code needed).'
}
# The pairing ran as this administrator: re-apply the folder's permissions to the settings file
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null

# --- scheduled task
$action = New-ScheduledTaskAction -Execute $NodePath -WorkingDirectory $InstallDir `
  -Argument ('"{0}" run --config "{1}" --log-file "{2}"' -f $Script, $Config, $Log)
$atStartup = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $watchdog) -Principal $principal -Settings $settings `
  -Description 'ManuFlow Tally Connector: reads TallyPrime (Export requests only) and sends the data to ManuFlow. Installed by install-connector.ps1.' `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 8
Write-Host ''
Write-Host "Installed: task '$TaskName' runs as LOCAL SERVICE, starts with Windows."
Write-Host "Settings and token: $Config (Administrators, SYSTEM and LOCAL SERVICE only)"
Write-Host "Log: $Log"
if (Test-Path -LiteralPath $Log) { Get-Content -LiteralPath $Log -Tail 5 }
Write-Host ''
Write-Host 'Check in ManuFlow: Import Center -> Import from Tally should show "Connected to Tally" within a minute.'
