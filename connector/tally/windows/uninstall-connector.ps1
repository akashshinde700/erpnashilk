#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the ManuFlow Tally Connector scheduled task. With -RemoveSettings also deletes its folder (token and log).

.DESCRIPTION
  Stopping the connector here does not disconnect it in ManuFlow. If this computer is lost, replaced or should no longer
  read Tally, also click "Disconnect" in ManuFlow (Import Center -> Import from Tally): that ends the token at once.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$InstallDir = (Join-Path $env:ProgramData 'ManuFlowTallyConnector'),
  [switch]$RemoveSettings
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ManuFlow Tally Connector'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the task '$TaskName'."
} else {
  Write-Host "The task '$TaskName' is not installed."
}

if ($RemoveSettings -and (Test-Path -LiteralPath $InstallDir)) {
  if ($PSCmdlet.ShouldProcess($InstallDir, 'Delete the connector folder (token, settings, log)')) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "Deleted $InstallDir."
  }
}
Write-Host 'Remember: click "Disconnect" in ManuFlow too if this computer should no longer read Tally.'
