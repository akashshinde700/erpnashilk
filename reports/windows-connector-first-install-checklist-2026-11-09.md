# ManuFlow Tally Connector 0.3.2 — Windows manual test checklist (Windows PowerShell 5.1 and PowerShell 7)

**Status: PENDING — none of this has been run.** PowerShell is not available on the Linux development machine. On
Linux the scripts were only checked statically:
- the text and the order of steps;
- brackets and strings balanced;
- cmdlet names known;
- the scripts' regexes run against sample inputs.

Package: `manuflow-tally-connector-0.3.2-windows.zip`
SHA-256: `5b7b561760657b1a6501745bfd40088c8c1a9691b58eb3f849393858bab5a6c6`

Rules:
- Use a **test** company, a **new** pairing code made for this test, and a test PC; never a customer's computer.
- Run the whole list once in **Windows PowerShell 5.1** ("Windows PowerShell (Admin)") and once in **PowerShell 7**
  ("pwsh" as admin). Uninstall with `-RemoveSettings` between the two runs.
- Record for every step: pass/fail, the exact message, and a screenshot where useful.
- `[A]` means the step needs an administrator window. Every installer and uninstaller step needs one.

| Run | Windows edition / build | PowerShell | Node.js (version, path) | Tester / date |
|---|---|---|---|---|
| 1 | | 5.1.x | | |
| 2 | | 7.x | | |

## 0. Environment
- [ ] `$PSVersionTable.PSVersion`, `[Environment]::OSVersion`, `node -v`, `(Get-Command node.exe).Source`
- [ ] `(Get-Item (Split-Path (Get-Command node.exe).Source)).LinkType` is empty. If not, expect the user-profile
      warning in step 3.
- [ ] TallyPrime "acts as Server/Both", port 9000, test company loaded.

## 1. Package integrity
- [ ] `Get-FileHash .\manuflow-tally-connector-0.3.2-windows.zip` matches the SHA-256 above. Get that value through a
      different channel than the zip.
- [ ] Explorer → Extract All: 6 files in `manuflow-tally-connector-0.3.2\`.
- [ ] In that folder, every line of this must say True:
      ```powershell
      Get-Content .\SHA256SUMS | % { $h,$p = $_ -split '  '; '{0} {1}' -f ((Get-FileHash $p).Hash -eq $h), $p }
      ```

## 2. Refusals — each must stop with a clear message and change nothing `[A]`
For each case, check afterwards that no task "ManuFlow Tally Connector" exists and no folder was created or changed.
- [ ] Not administrator (normal window): refused by `#Requires -RunAsAdministrator`.
- [ ] B1 / C5: rename `node.exe` out of PATH, or use a window opened before Node.js was installed. Expect "Node.js was
      not found … open a NEW PowerShell window".
- [ ] B1: `-NodePath` pointing at a Node.js 16 `node.exe` (portable zip): "Node.js 16 is too old".
- [ ] B1: `-NodePath C:\Windows\System32\whoami.exe`: "did not answer with a version".
- [ ] S6, one at a time:
  - `-InstallDir C:\` → "must not be a drive";
  - `-InstallDir C:\Windows\Temp\x` → "must not be inside";
  - `-InstallDir $env:ProgramData` → "must not be the system folder";
  - `-InstallDir \\server\share\x` → "network path";
  - `-InstallDir` a folder containing `notes.txt` → "not part of the connector";
  - `-InstallDir` a junction (`cmd /c mklink /J C:\mf-link C:\Temp`) → "is a link".
- [ ] S1: as a **standard user**, run `mkdir C:\ProgramData\ManuFlowTallyConnector`. Then, as admin, run
      `.\install-connector.ps1`. Expect "owned by …, not by Administrators, SYSTEM or you … Refused". Delete the folder
      afterwards.
- [ ] Server: `-Server http://example.com` → "must be https://".
- [ ] Code: type `hello` at the prompt → "does not look like a pairing code". Check that nothing was changed.

## 3. First install `[A]`
- [ ] `Set-ExecutionPolicy -Scope Process Bypass` (answer Y), then `.\install-connector.ps1`. The prompt hides the code.
- [ ] S3: no failure from the LOCAL SERVICE account check. During the install, the temporary task
      "ManuFlow Tally Connector - account check" may appear; afterwards it must be gone (`Get-ScheduledTask`).
- [ ] S5: the output ends with "Installed: ManuFlow Tally Connector 0.3.2 … and is running".
- [ ] C1: "—" and "…" in the output show correctly (not "ΓÇö"). After the script ends, the console encoding is back:
      `[Console]::OutputEncoding` is the same as before.
- [ ] Look for the code in the PowerShell history
      (`Get-Content (Get-PSReadLineOption).HistorySavePath -Tail 20`), in `connector.json` and in the log. It is in
      none of them.
- [ ] S1 permissions:
  - `icacls C:\ProgramData\ManuFlowTallyConnector` shows exactly Administrators F, SYSTEM F and LOCAL SERVICE M, all
    (OI)(CI), and no `(I)` entries.
  - `(Get-Acl C:\ProgramData\ManuFlowTallyConnector).Owner` is BUILTIN\Administrators.
  - `icacls` on `connector.json` and `manuflow-tally-connector.mjs` shows only the inherited `(I)` entries of those
    three accounts.
  - As a standard user, `Get-Content C:\ProgramData\ManuFlowTallyConnector\connector.json` gives Access denied.
- [ ] Task (`Get-ScheduledTask 'ManuFlow Tally Connector'`):
  - Principal: LOCAL SERVICE, ServiceAccount, Limited;
  - two triggers: Boot, and a time trigger with Repetition Interval PT5M and an **empty (indefinite)** Duration;
  - ExecutionTimeLimit PT0S, MultipleInstances IgnoreNew;
  - `Get-ScheduledTaskInfo` LastTaskResult 267009.
- [ ] Task Manager → Details: `node.exe` runs as LOCAL SERVICE.
- [ ] Log (`Get-Content …\logs\connector.log -Tail 20 -Encoding UTF8`): "0.3.2 started", "Tally: connected".
- [ ] In ManuFlow, Import from Tally goes Connecting → company list, without pressing Connect. Do a masters
      **preview** only; nothing changes in TallyPrime.

## 4. Recovery (C2: the watchdog trigger, not "restart on failure")
- [ ] End `node.exe` in Task Manager. It runs again within 5 minutes. Record the time:
- [ ] S2: restart Windows **without signing in**. Within 5 minutes, ManuFlow shows the connector online (Tally not
      reachable is expected until someone signs in and opens Tally). The log shows "started", not "Another copy …
      already running". Record the time:
- [ ] Sign in and open TallyPrime: Connected, with no action needed.
- [ ] Network unplugged for 10 minutes: Offline / Reconnecting. Plug it back in: Connected within about 5 minutes.
- [ ] `[A]` Start a second copy by hand (`node …\manuflow-tally-connector.mjs run --config …\connector.json`). It
      exits with "already running" (exit code 3).
- [ ] `[A]` `status` and `check` print no token. The device id is shown shortened (8 characters + "…").

## 5. Upgrade and existing pairing `[A]`
- [ ] Run `.\install-connector.ps1` again:
  - "Stopped the running connector for the upgrade";
  - "Removed the lock file left by the stopped connector";
  - "Already paired with … keeping the existing pairing";
  - no code prompt; "and is running".
  The device id from `status` is unchanged.
- [ ] S2: start a second copy by hand (it exits with code 3). Then start one by hand **after stopping the task**, so
      it holds the lock. Run the installer: it stops with "A connector is still running (process N …)" and leaves the
      lock. Stop that process and run the installer again: it succeeds.
- [ ] S4: `.\install-connector.ps1 -Tally http://127.0.0.1:9000` prints "Tally address set to …". The token is
      unchanged: compare the file's SHA-256 before and after, ignoring the tally field, or compare `status`.
- [ ] S4: `.\install-connector.ps1 -Code ABCDE-FGHJK` (dummy) gives the warning "the code was NOT used".
- [ ] S1 / S4: `.\install-connector.ps1 -Server https://example.com` gives "This computer is paired with … Nothing was
      changed". The task is still running, unchanged.
- [ ] S1: as admin, run `icacls C:\ProgramData\ManuFlowTallyConnector /grant *S-1-5-32-545:(OI)(CI)M` (Users). Then
      `.\install-connector.ps1` gives "its folder was not protected … not trusted … -Repair". Run it with `-Repair`
      and a new test code: the old file is moved to `%TEMP%`, there is a new device id, and the Users entry is gone.
- [ ] S1: replace the token in `connector.json` with `mftc_fake`. Then `.\install-connector.ps1` gives "not a valid
      connector settings file". `-Repair` with a new code repairs it.
- [ ] Upgrade test with a 0.3.3 test build: the pairing is kept and the log shows "0.3.3 started".

## 6. Repair `[A]`
- [ ] New test code, then `.\install-connector.ps1 -Repair`. The device id is unchanged, and ManuFlow shows the same
      computer as Connected.
- [ ] `-Repair` with a wrong code: "Pairing failed". The old pairing still works, and the task is running again within
      5 minutes.

## 7. Uninstall `[A]`
- [ ] C4: `.\uninstall-connector.ps1 -RemoveSettings -WhatIf` prints only "What if: …" lines and "WhatIf: nothing was
      removed". Check that the task, the program and `connector.json` all still exist.
- [ ] Run `.\uninstall-connector.ps1`:
  - the task is removed and `node.exe` has stopped;
  - "Removed …" appears for the program, VERSION and the lock;
  - `connector.json` and the log are kept.
- [ ] Reinstall without a code: it works with the kept pairing.
- [ ] `.\uninstall-connector.ps1 -RemoveSettings`: it asks; answer **N**, and "Kept the pairing" appears with nothing
      deleted. Run it again and answer **Y**: everything is deleted and the folder is gone.
- [ ] Click **Disconnect** in ManuFlow. TallyPrime and its data are untouched.

## 8. Network exposure
- [ ] `Get-NetTCPConnection -State Listen | ? OwningProcess -in (Get-Process node).Id` returns nothing.
- [ ] No firewall rule was added for node.exe, and no router forward for port 9000. If Tally is on another PC, its
      inbound 9000 rule is limited to the office subnet / Private profile.
