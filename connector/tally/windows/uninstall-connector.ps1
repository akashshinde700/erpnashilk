#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the ManuFlow Tally Connector: the scheduled task and the program. The pairing (token, device identity) and
  the log are kept unless -RemoveSettings is given.

.DESCRIPTION
  Only the connector's own files in its folder are touched (by name; never a recursive delete). TallyPrime, its data
  and ManuFlow's data are never affected. Stopping the connector here does not disconnect it in ManuFlow: if this
  computer should no longer read Tally, also click "Disconnect" in ManuFlow (Import Center -> Import from Tally),
  which ends the token at once.

  -WhatIf shows what would be removed and removes nothing. -RemoveSettings asks before deleting the pairing, unless
  -Force is given as well.

.EXAMPLE
  .\uninstall-connector.ps1                    # remove task + program; keep the pairing and the log (re-install keeps working)
.EXAMPLE
  .\uninstall-connector.ps1 -RemoveSettings    # also delete the pairing (token) and the log (asks first)
.EXAMPLE
  .\uninstall-connector.ps1 -RemoveSettings -WhatIf   # only show what would be removed
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$InstallDir = (Join-Path $env:ProgramData 'ManuFlowTallyConnector'),
  [switch]$RemoveSettings,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ManuFlow Tally Connector'
$Config = Join-Path $InstallDir 'connector.json'

# Removes one of the connector's files; says "Removed" only when it really is gone
function Remove-OwnFile([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ($PSCmdlet.ShouldProcess($Path, "Delete $What")) {
    Remove-Item -LiteralPath $Path -Force
    if (Test-Path -LiteralPath $Path) { Write-Warning "Could not delete $Path" } else { Write-Host "Removed $Path" }
  }
}

$PreviousOutputEncoding = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try {
  $whatIf = [bool]$WhatIfPreference

  # --- the task
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove the scheduled task')) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      $deadline = (Get-Date).AddSeconds(15)
      while ([string](Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Write-Warning "The task '$TaskName' is still registered." }
      else { Write-Host "Removed the task '$TaskName'." }
    }
  } else {
    Write-Host "The task '$TaskName' is not installed."
  }

  # --- the program files only (never anything else that may be in the folder)
  Remove-OwnFile (Join-Path $InstallDir 'manuflow-tally-connector.mjs') 'the connector program'
  Remove-OwnFile (Join-Path $InstallDir 'VERSION') 'the version file'

  # --- the lock: only if no connector is still running with it (e.g. one started by hand)
  $lock = "$Config.lock"
  if (Test-Path -LiteralPath $lock) {
    $lockPid = 0
    [void][int]::TryParse(([string](Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue)).Trim(), [ref]$lockPid)
    $proc = if ($lockPid -gt 0) { Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue } else { $null }
    if ($proc -and ($proc.Name -ieq 'node.exe') -and $proc.CommandLine -and
        ($proc.CommandLine.IndexOf('manuflow-tally-connector', [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      Write-Warning "A connector is still running (process $lockPid, probably started by hand); its lock file was left. Stop it with Stop-Process -Id $lockPid."
    } else {
      Remove-OwnFile $lock 'the lock file of the stopped connector'
    }
  }

  # --- the pairing and the log: only with -RemoveSettings, and after asking (unless -Force)
  if ($RemoveSettings) {
    $data = @('connector.json', 'connector.json.tmp', 'logs\connector.log', 'logs\connector.log.1') |
      ForEach-Object { Join-Path $InstallDir $_ } | Where-Object { Test-Path -LiteralPath $_ }
    if (-not $data) {
      Write-Host "No pairing or log found in $InstallDir."
    } elseif ($whatIf) {
      $data | ForEach-Object { [void]$PSCmdlet.ShouldProcess($_, 'Delete (pairing / log)') }
    } elseif ($Force -or $PSCmdlet.ShouldContinue("Delete the pairing (token, device identity) and the connector log in $InstallDir? This computer then has to be paired again with a new code.", 'Remove the ManuFlow Tally Connector settings')) {
      $data | ForEach-Object { Remove-OwnFile $_ 'pairing / log' }
      # empty folders only (never a recursive delete)
      foreach ($d in @((Join-Path $InstallDir 'logs'), $InstallDir)) {
        if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
          Remove-Item -LiteralPath $d -Force
          if (-not (Test-Path -LiteralPath $d)) { Write-Host "Removed the empty folder $d" }
        }
      }
    } else {
      Write-Host 'Kept the pairing and the log (not confirmed).'
    }
  } elseif (Test-Path -LiteralPath $Config) {
    Write-Host "Kept the pairing and the log in $InstallDir (run with -RemoveSettings to delete them)."
  }
  if ($whatIf) { Write-Host 'WhatIf: nothing was removed.' }
  Write-Host 'Remember: click "Disconnect" in ManuFlow too if this computer should no longer read Tally.'
} finally {
  try { [Console]::OutputEncoding = $PreviousOutputEncoding } catch { }
}
