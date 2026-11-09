#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs (or upgrades) the ManuFlow Tally Connector so it starts with Windows. Read-only: TallyPrime -> ManuFlow.

.DESCRIPTION
  * Checks Node.js 18 or newer, and that the LOCAL SERVICE account can really run it (a short test task).
  * Copies manuflow-tally-connector.mjs (and VERSION) to C:\ProgramData\ManuFlowTallyConnector (or -InstallDir).
    The connector uses only Node.js itself: there are no packages to download or install.
  * Makes that folder owned by Administrators and readable only by Administrators, SYSTEM and LOCAL SERVICE (the
    token file is in it). A folder that already exists is used only if it is safe: owned by Administrators or SYSTEM,
    holding only the connector's own files, and without links. Anything else is refused, never "fixed" blindly.
  * Pairs the connector once with the one-time code from ManuFlow (Import Center -> Import from Tally -> Connect
    Tally). The code is typed in at a hidden prompt (or given with -Code) and handed to the connector on its
    standard input, never on its command line, and never saved.
  * An existing pairing is NEVER replaced unless -Repair is given. It is used only if its folder was protected, the
    file is a valid connector settings file, and its ManuFlow address is the one given with -Server.
  * Registers the scheduled task "ManuFlow Tally Connector":
      - runs as LOCAL SERVICE (no password stored, no administrator rights, no window);
      - starts at Windows startup, and is started again every 5 minutes if it is not running (this "watchdog"
        trigger is what brings the connector back after it stops; a second copy exits at once);
      - no time limit; runs on battery.
    Then checks that the task really is running; the installation is reported as done only if it is.
  Running the script again without -Repair is an upgrade: the task is stopped, the program replaced, the task
  re-registered and started; the pairing (token and device identity) is kept. -Tally given on an upgrade changes the
  Tally address of the existing pairing.

  Nothing is opened to the network: the connector only connects OUT to ManuFlow over HTTPS (certificate checked).
  Tally's port 9000 stays inside the office. The connector sends Tally only read-only Export requests.

  Written for Windows 10 / 11 and Windows Server 2016+, Windows PowerShell 5.1 or PowerShell 7.

.EXAMPLE
  .\install-connector.ps1                       # first installation: asks for the code; upgrade: keeps the pairing
.EXAMPLE
  .\install-connector.ps1 -Tally http://192.168.1.20:9000      # TallyPrime on another PC in the office
.EXAMPLE
  .\install-connector.ps1 -Repair               # pair this computer again with a new code (e.g. after "Authentication failed")
#>
[CmdletBinding()]
param(
  [string]$Server = 'https://www.menu.aetherdevsolutions.online',
  [string]$Code,
  [string]$Tally = 'http://127.0.0.1:9000',
  [string]$InstallDir = (Join-Path $env:ProgramData 'ManuFlowTallyConnector'),
  [string]$NodePath,
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ManuFlow Tally Connector'
$ProbeTaskName = 'ManuFlow Tally Connector - account check'
$Here = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Here 'manuflow-tally-connector.mjs'
$VersionFile = Join-Path $Here 'VERSION'

# Well-known SIDs, so this works in every Windows language
$SidAdmins = 'S-1-5-32-544'
$SidSystem = 'S-1-5-18'
$SidLocalService = 'S-1-5-19'
$SidMe = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value   # the administrator running this
$TrustedOwners = @($SidAdmins, $SidSystem, $SidMe)
$LocalService = (New-Object System.Security.Principal.SecurityIdentifier($SidLocalService)).Translate([System.Security.Principal.NTAccount]).Value

# Task Scheduler result codes
$TaskRunning = 267009     # 0x41301: the task is running
$TaskNotRunYet = 267011   # 0x41303: the task has not run yet

# The only names the connector keeps in its folder (anything else there means it is not the connector's folder)
$OwnFiles = @('manuflow-tally-connector.mjs', 'VERSION', 'connector.json', 'connector.json.tmp', 'connector.json.lock', 'logs')
$OwnLogFiles = @('connector.log', 'connector.log.1')
$TokenPattern = '^mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$'
$DeviceIdPattern = '^[a-f0-9]{32}$'

# ---------------------------------------------------------------- helpers

function Get-Sid([string]$Account) {
  (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-OwnerSid([string]$Path) {
  (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

function Test-IsLink([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Get-NodeMajor([string]$Exe) {
  # "node -v" prints e.g. v20.11.1. (No quotes in the arguments: Windows PowerShell 5.1 passes embedded quotes to
  # programs unescaped, so an expression such as -p "...split('.')..." can reach Node.js damaged.)
  $out = @()
  try { $out = @(& $Exe -v) } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or $out.Count -eq 0) { return $null }
  $m = [regex]::Match([string]$out[0], '^\s*v(\d+)\.\d+\.\d+')
  if (-not $m.Success) { return $null }
  return [int]$m.Groups[1].Value
}

function Get-ProfilesDirectory {
  $dirs = @()
  try {
    $p = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -Name ProfilesDirectory).ProfilesDirectory
    if ($p) { $dirs += [Environment]::ExpandEnvironmentVariables($p) }
  } catch { }
  if ($env:USERPROFILE) { $dirs += (Split-Path -Parent $env:USERPROFILE) }
  $dirs | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Select-Object -Unique
}

function Test-UnderFolder([string]$Path, [string]$Folder) {
  $p = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $f = [IO.Path]::GetFullPath($Folder).TrimEnd('\')
  return ($p -ieq $f) -or $p.StartsWith($f + '\', [StringComparison]::OrdinalIgnoreCase)
}

# Every place node.exe really lives: the file and each folder above it, following links (nvm-windows links
# C:\Program Files\nodejs into a user profile, where LOCAL SERVICE cannot read it)
function Get-NodeRealPaths([string]$Exe) {
  $found = New-Object System.Collections.Generic.List[string]
  $p = [IO.Path]::GetFullPath($Exe)
  while ($p) {
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType) {
      $target = @($item.Target)[0]
      if ($target) {
        if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $p) $target }
        $found.Add([IO.Path]::GetFullPath($target))
      }
    }
    $parent = Split-Path -Parent $p
    if (-not $parent -or $parent -eq $p) { break }
    $p = $parent
  }
  $found.Add([IO.Path]::GetFullPath($Exe))
  return $found
}

# Runs Exe once as LOCAL SERVICE in a temporary task and returns its exit code (or $null if it did not finish)
function Invoke-AsLocalService([string]$Exe, [string]$Arguments, [string]$WorkingDirectory) {
  Unregister-ScheduledTask -TaskName $ProbeTaskName -Confirm:$false -ErrorAction SilentlyContinue
  try {
    $a = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $WorkingDirectory
    $p = New-ScheduledTaskPrincipal -UserId $LocalService -LogonType ServiceAccount -RunLevel Limited
    $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $ProbeTaskName -Action $a -Principal $p -Settings $s -Force | Out-Null
    Start-ScheduledTask -TaskName $ProbeTaskName
    $deadline = (Get-Date).AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 500
      $state = [string](Get-ScheduledTask -TaskName $ProbeTaskName).State
      $result = [int64](Get-ScheduledTaskInfo -TaskName $ProbeTaskName).LastTaskResult
      $finished = ($state -eq 'Ready') -and ($result -ne $TaskNotRunYet) -and ($result -ne $TaskRunning)
    } while (-not $finished -and (Get-Date) -lt $deadline)
    if ($finished) { return $result } else { return $null }
  } finally {
    Unregister-ScheduledTask -TaskName $ProbeTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

# The install folder must be a folder of its own: never a drive, a Windows or profile folder, or a folder with
# anything else in it. (Its permissions are replaced, so a wrong path here would lock other programs out.)
function Assert-SafeInstallDir([string]$Dir) {
  if (-not [IO.Path]::IsPathRooted($Dir)) { throw "-InstallDir must be a full path such as C:\ProgramData\ManuFlowTallyConnector (got '$Dir')." }
  if ($Dir.StartsWith('\\')) { throw '-InstallDir must be on this computer, not a network path.' }
  $full = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
  $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ($full -ieq $root) { throw "-InstallDir must not be a drive ($full). Use a folder of its own, e.g. C:\ProgramData\ManuFlowTallyConnector." }
  $special = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, $env:ProgramData, $env:PUBLIC,
    $env:USERPROFILE, $env:ALLUSERSPROFILE, $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP) + @(Get-ProfilesDirectory)
  foreach ($s in ($special | Where-Object { $_ })) {
    if ($full -ieq [IO.Path]::GetFullPath($s).TrimEnd('\')) { throw "-InstallDir must not be the system folder $full. Use a folder of its own inside it." }
  }
  if ($env:SystemRoot -and (Test-UnderFolder $full $env:SystemRoot)) { throw "-InstallDir must not be inside $($env:SystemRoot)." }
  if (Test-Path -LiteralPath $full -PathType Leaf) { throw "-InstallDir $full is a file, not a folder." }
  if (Test-Path -LiteralPath $full) {
    if (Test-IsLink $full) { throw "$full is a link (junction or symbolic link). Refused: use a real folder." }
    foreach ($e in @(Get-ChildItem -LiteralPath $full -Force)) {
      if ($OwnFiles -notcontains $e.Name) { throw "$full already contains '$($e.Name)', which is not part of the connector. Refused: choose an empty folder of its own." }
      if (Test-IsLink $e.FullName) { throw "$($e.FullName) is a link (junction or symbolic link). Refused: remove it first." }
      if ($e.Name -eq 'logs') {
        if (-not $e.PSIsContainer) { throw "$($e.FullName) should be a folder." }
        foreach ($l in @(Get-ChildItem -LiteralPath $e.FullName -Force)) {
          if ($OwnLogFiles -notcontains $l.Name -or $l.PSIsContainer) { throw "$($l.FullName) is not a connector log. Refused: choose an empty folder of its own." }
          if (Test-IsLink $l.FullName) { throw "$($l.FullName) is a link. Refused: remove it first." }
        }
      }
    }
  }
  return $full
}

# Was this existing folder protected the way this script leaves it? (owned by Administrators or SYSTEM, no inherited
# entries, nobody but Administrators, SYSTEM and LOCAL SERVICE in it; every file owned by one of those three).
# If not, other users could have put a settings file there, so its contents are not trusted.
function Test-ProtectedFolder([string]$Dir) {
  $acl = Get-Acl -LiteralPath $Dir
  if ($TrustedOwners -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { return $false }
  if (-not $acl.AreAccessRulesProtected) { return $false }
  foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if (@($SidAdmins, $SidSystem, $SidLocalService) -notcontains $r.IdentityReference.Value) { return $false }
  }
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Force -Recurse)) {
    if (@($TrustedOwners + $SidLocalService) -notcontains (Get-OwnerSid $f.FullName)) { return $false }
  }
  return $true
}

# Owner Administrators; Administrators + SYSTEM full control, LOCAL SERVICE modify (token renewal, log, lock);
# nothing inherited from ProgramData. Set in one step on the folder (never a moment with wider access), then every
# item inside (already checked: the connector's own files, no links) is reset to inherit only that.
function New-ConnectorFolderSecurity([switch]$WithOwner) {
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $none = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  if ($WithOwner) { $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($SidAdmins))) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($grant in @(@($SidAdmins, 'FullControl'), @($SidSystem, 'FullControl'), @($SidLocalService, 'Modify'))) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($grant[0])
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $grant[1], $inherit, $none, $allow)))
  }
  return $acl
}

# A new folder is created with its protection already in place (no moment in which other users could write to it)
function New-ProtectedFolder([string]$Dir) {
  $sec = New-ConnectorFolderSecurity
  $ext = 'System.IO.FileSystemAclExtensions' -as [type]
  if ($ext) { [void]$ext::Create((New-Object System.IO.DirectoryInfo($Dir)), $sec) }   # PowerShell 7 (.NET)
  else { [void][System.IO.Directory]::CreateDirectory($Dir, $sec) }                    # Windows PowerShell 5.1 (.NET Framework)
}

function Set-ConnectorFolderAcl([string]$Dir) {
  Set-Acl -LiteralPath $Dir -AclObject (New-ConnectorFolderSecurity -WithOwner)
  foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Force -Recurse)) {
    & icacls.exe $item.FullName /setowner "*$SidAdmins" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not set the owner of $($item.FullName) (icacls)." }
    & icacls.exe $item.FullName /reset /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not set the permissions of $($item.FullName) (icacls)." }
  }
}

# Reads connector.json; returns $null if it is not a valid connector settings file
function Read-ConnectorConfig([string]$Path) {
  try { $c = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  if (-not $c) { return $null }
  if ([string]$c.token -notmatch $TokenPattern) { return $null }
  if ($c.deviceId -and ([string]$c.deviceId -notmatch $DeviceIdPattern)) { return $null }
  if ([string]$c.server -notmatch '^https://[^/\s]+$') { return $null }
  return $c
}

function Get-Origin([string]$Url) { ([Uri]$Url).GetLeftPart([UriPartial]::Authority).ToLowerInvariant() }

# A connector.json.lock left by a stopped task is removed; one held by a connector that is really running is not
function Remove-StaleLock([string]$ConfigPath) {
  $lock = "$ConfigPath.lock"
  if (-not (Test-Path -LiteralPath $lock)) { return }
  $lockPid = 0
  [void][int]::TryParse(([string](Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue)).Trim(), [ref]$lockPid)
  if ($lockPid -gt 0) {
    $deadline = (Get-Date).AddSeconds(15)
    do {
      $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue
      $isConnector = $proc -and ($proc.Name -ieq 'node.exe') -and $proc.CommandLine -and
        ($proc.CommandLine.IndexOf('manuflow-tally-connector', [StringComparison]::OrdinalIgnoreCase) -ge 0)
      if ($isConnector) { Start-Sleep -Milliseconds 500 }
    } while ($isConnector -and (Get-Date) -lt $deadline)
    if ($isConnector) {
      throw "A connector is still running (process $lockPid, probably started by hand). Stop it (Task Manager -> node.exe, or Stop-Process -Id $lockPid), then run this again."
    }
  }
  Remove-Item -LiteralPath $lock -Force
  Write-Host 'Removed the lock file left by the stopped connector.'
}

function Get-LogTail([string]$Path, [int]$Lines = 5) {
  if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8 }
}

# ---------------------------------------------------------------- main

# Node.js writes UTF-8; show its messages (and read its log) as UTF-8 in this window
$PreviousOutputEncoding = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  # --- ManuFlow address: https only (the token and the pairing code travel over it)
  if ($Server -notmatch '^https://[^/\s]+/?$') { throw "The ManuFlow address must be https://... (got '$Server')." }
  $Server = $Server.TrimEnd('/')

  # --- install folder (S6), before anything is changed
  $InstallDir = Assert-SafeInstallDir $InstallDir
  $Script = Join-Path $InstallDir 'manuflow-tally-connector.mjs'
  $Config = Join-Path $InstallDir 'connector.json'
  $Log = Join-Path $InstallDir 'logs\connector.log'

  # --- Node.js 18 or newer (an absolute path: the task does not use this window's PATH)
  if (-not $NodePath) {
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $NodePath = $cmd.Source }
    elseif ($env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) { $NodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  }
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw ('Node.js was not found. Install Node.js 18 LTS or newer from https://nodejs.org (for all users), then open a NEW ' +
      'PowerShell window as administrator (a window that was already open does not see the new installation) and run this again.')
  }
  $NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
  $major = Get-NodeMajor $NodePath
  if ($null -eq $major) { throw "'$NodePath -v' did not answer with a version. Reinstall Node.js 18 LTS or newer from https://nodejs.org (for all users)." }
  if ($major -lt 18) { throw "Node.js $major is too old ($NodePath): version 18 or newer is needed. Install the LTS version from https://nodejs.org." }
  if (-not (Test-Path -LiteralPath $Source)) { throw "manuflow-tally-connector.mjs not found in the package folder ($Here)." }

  # --- Node.js inside a user profile (directly or through a link): LOCAL SERVICE usually cannot run it (S3)
  $profiles = @(Get-ProfilesDirectory)
  $inProfile = @(Get-NodeRealPaths $NodePath | Where-Object { $p = $_; @($profiles | Where-Object { Test-UnderFolder $p $_ }).Count -gt 0 })
  if ($inProfile.Count -gt 0) {
    Write-Warning ("Node.js is (or links to) a folder inside a user profile: $($inProfile -join ', '). The connector runs as LOCAL SERVICE, " +
      'which normally cannot read user profiles. Install Node.js for all users (C:\Program Files\nodejs, not through nvm) if the check below fails.')
  }

  # --- existing installation: is its folder trustworthy, and is its pairing valid and for this ManuFlow? (S1, S4)
  $existed = Test-Path -LiteralPath $InstallDir
  if ($existed) {
    $owner = Get-OwnerSid $InstallDir
    if ($TrustedOwners -notcontains $owner) {
      throw ("$InstallDir already exists and is owned by $owner, not by Administrators, SYSTEM or you: another user may have created it. " +
        'Refused. Check what it is; if it is not needed, delete it and run this again.')
    }
  }
  $protected = $existed -and (Test-ProtectedFolder $InstallDir)
  $hasConfig = Test-Path -LiteralPath $Config
  $saved = if ($hasConfig) { Read-ConnectorConfig $Config } else { $null }
  $Paired = $false
  if ($hasConfig -and -not $protected) {
    if (-not $Repair) {
      throw ("$Config exists, but its folder was not protected (other users could have written it), so it is not trusted. " +
        'Run again with -Repair and a new code from ManuFlow to pair this computer from scratch.')
    }
    Write-Warning 'The existing settings file is not trusted (unprotected folder): it is set aside and this computer gets a new device identity.'
  } elseif ($hasConfig -and -not $saved) {
    if (-not $Repair) { throw "$Config is not a valid connector settings file. Run again with -Repair and a new code from ManuFlow." }
    Write-Warning 'The existing settings file is not valid: it is set aside and this computer gets a new device identity.'
  } elseif ($saved) {
    $Paired = $true
    if ((Get-Origin $saved.server) -ne (Get-Origin $Server)) {
      $how = if ($PSBoundParameters.ContainsKey('Server')) { 'given with -Server' } else { 'the default; give another with -Server' }
      if (-not $Repair) {
        throw ("This computer is paired with $($saved.server), but the ManuFlow address here is $Server ($how). Nothing was changed. " +
          "To keep the pairing, run again with -Server $($saved.server). To pair with $Server instead, run with -Repair and a new code from that ManuFlow.")
      }
      Write-Warning "Repair: the pairing with $($saved.server) is replaced by a pairing with $Server."
    }
  }
  $setAside = $hasConfig -and $Repair -and (-not $protected -or -not $saved)

  # --- before anything is changed: the code, if one is needed (so a refused code changes nothing)
  $needPairing = $Repair -or -not $Paired
  if ($needPairing) {
    if (-not $Code) {
      $secure = Read-Host 'One-time pairing code from ManuFlow (Import Center -> Import from Tally -> Connect Tally)' -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $Code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($Code -notmatch '^\s*[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}\s*$') { throw 'That does not look like a pairing code (it has 10 letters and digits, e.g. ABCDE-FGHJK).' }
  } elseif ($Code) {
    Write-Warning 'This computer is already paired: the code was NOT used. To pair it again, run with -Repair.'
  }

  # --- upgrade: stop the running connector before its program is replaced, and clear its lock (S2)
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ([string](Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Write-Host 'Stopped the running connector for the upgrade.'
  }
  Remove-StaleLock $Config

  # --- folder and program; permissions set before the program or any settings are written
  if (-not $existed) { New-ProtectedFolder $InstallDir }
  Set-ConnectorFolderAcl $InstallDir
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $InstallDir 'logs') | Out-Null }
  if ($setAside) {
    $aside = Join-Path $env:TEMP ('manuflow-connector.json.untrusted-{0:yyyyMMdd-HHmmss}' -f (Get-Date))
    Move-Item -LiteralPath $Config -Destination $aside -Force
    Write-Host "Moved the old settings file to $aside (delete it once you have checked it)."
  }
  Copy-Item -LiteralPath $Source -Destination $Script -Force
  if (Test-Path -LiteralPath $VersionFile) { Copy-Item -LiteralPath $VersionFile -Destination (Join-Path $InstallDir 'VERSION') -Force }
  Set-ConnectorFolderAcl $InstallDir

  # --- can LOCAL SERVICE really run Node.js and the connector? (before a pairing code is used) (S3)
  $probe = Invoke-AsLocalService $NodePath ('"{0}" version' -f $Script) $InstallDir
  if ($null -eq $probe) {
    Write-Warning 'Could not confirm in 30 seconds that LOCAL SERVICE can run Node.js (Task Scheduler is slow?). Continuing; the task check at the end decides.'
  } elseif ($probe -ne 0) {
    $msg = ('LOCAL SERVICE cannot run Node.js or the connector (test task result 0x{0:X}). Install Node.js for all users in ' +
      'C:\Program Files\nodejs (not inside a user profile and not through nvm), open a new PowerShell window as administrator and run this again.') -f $probe
    throw $msg
  }

  # --- pairing: once; an existing pairing is kept unless -Repair
  if ($needPairing) {
    if ($Paired) { Write-Host 'Repair: this computer is paired again with a new code (its device identity is kept).' }
    # the code goes to the connector on its standard input, not on its command line
    $Code | & $NodePath $Script pair --server $Server --code-stdin --tally $Tally --config $Config
    $pairExit = $LASTEXITCODE
    $Code = $null
    if ($pairExit -ne 0) { throw 'Pairing failed (see the message above). Create a new code in ManuFlow and run this again.' }
  } else {
    Write-Host "Already paired with $($saved.server): keeping the existing pairing (token and device identity)."
    if ($PSBoundParameters.ContainsKey('Tally')) {
      & $NodePath $Script set-tally --tally $Tally --config $Config
      if ($LASTEXITCODE -ne 0) { throw 'The Tally address was not changed (see the message above).' }
    }
  }
  # The pairing / set-tally ran as this administrator: give the new settings file the folder's permissions
  Set-ConnectorFolderAcl $InstallDir

  # --- scheduled task (re-registered on every run, so an upgrade also updates its settings)
  $action = New-ScheduledTaskAction -Execute $NodePath -WorkingDirectory $InstallDir `
    -Argument ('"{0}" run --config "{1}" --log-file "{2}"' -f $Script, $Config, $Log)
  $atStartup = New-ScheduledTaskTrigger -AtStartup
  # the watchdog: starts the connector again within 5 minutes whenever it is not running (Task Scheduler's own
  # "restart on failure" does not apply when the program exits by itself)
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId $LocalService -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $watchdog) -Principal $principal -Settings $settings `
    -Description 'ManuFlow Tally Connector: reads TallyPrime (Export requests only) and sends the data to ManuFlow. Installed by install-connector.ps1.' `
    -Force | Out-Null

  # --- verify the task: registered as LOCAL SERVICE with both triggers, started, and still running (S5)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { throw "The task '$TaskName' was not registered." }
  $uid = [string]$task.Principal.UserId
  $runsAsLocalService = $false
  try { $runsAsLocalService = (Get-Sid $uid) -eq $SidLocalService }
  catch { $runsAsLocalService = ($uid -ieq $LocalService) -or $LocalService.EndsWith('\' + $uid, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $runsAsLocalService) { throw "The task '$TaskName' does not run as LOCAL SERVICE ($uid)." }
  if (@($task.Triggers).Count -ne 2) { throw "The task '$TaskName' has $(@($task.Triggers).Count) triggers instead of 2 (startup + every 5 minutes)." }
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 10
  $state = [string](Get-ScheduledTask -TaskName $TaskName).State
  $result = [int64](Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
  if ($state -ne 'Running' -or $result -ne $TaskRunning) {
    Write-Host ''
    Write-Host 'Last lines of the connector log:'
    Get-LogTail $Log 10
    $why = switch ($result) { 2 { 'the connector is not paired, or was disconnected in ManuFlow' } 3 { 'another copy of the connector is already running' } default { 'see the log above' } }
    $msg = 'The connector task is not running (state {0}, last result 0x{1:X}: {2}). The installation is NOT complete.' -f $state, $result, $why
    throw $msg
  }

  Write-Host ''
  Write-Host ("Installed: {0} - task '{1}' runs as {2}, starts with Windows, and is running." -f ((& $NodePath $Script version) -join ' '), $TaskName, $LocalService)
  Write-Host "Settings and token: $Config (Administrators, SYSTEM and LOCAL SERVICE only)"
  Write-Host "Log: $Log"
  Get-LogTail $Log 5
  Write-Host ''
  Write-Host 'Check in ManuFlow: Import Center -> Import from Tally connects by itself within a minute.'
} finally {
  $Code = $null
  try { [Console]::OutputEncoding = $PreviousOutputEncoding } catch { }
}
