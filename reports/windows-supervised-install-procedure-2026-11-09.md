# ManuFlow Tally Connector 0.3.2 — supervised first installation on the Windows Tally PC

| | |
|---|---|
| Windows Tally PC | `10.248.233.150` (the connector is installed **on this PC**, so its Tally address is `http://127.0.0.1:9000`) |
| ManuFlow (production) | `https://www.menu.aetherdevsolutions.online` |
| Package | `manuflow-tally-connector-0.3.2-windows.zip` (97,410 bytes) |
| SHA-256 | `5b7b561760657b1a6501745bfd40088c8c1a9691b58eb3f849393858bab5a6c6` |
| Production compatibility | The live build accepts connectors 0.2.0 and newer. The pair, heartbeat, ping and result endpoints are live. The connector's requests are unchanged since that build. |

The procedure has two halves, marked with these labels:

- 🟢 **BEFORE PAIRING**: no pairing code and no Tally data are needed. If something fails here, stop; nothing has been
  installed or paired yet.
- 🔵 **REAL TALLYPRIME**: needs a new pairing code (part 4) and a running TallyPrime with a **test** company loaded.

Steps marked **[Admin]** need a PowerShell window opened *as administrator*. The commands are the same in Windows
PowerShell 5.1 and PowerShell 7. Where they differ, both forms are given.

Ground rules:
- Do everything by hand at the PC, with the supervisor present. Nothing is installed remotely.
- Use **only a new pairing code**, created in part 4 at the moment the installer asks for it. Never use a code that
  was shown earlier, an expired code, or a code sent by chat or e-mail.
- Never paste the code into a command line. Type it only at the installer's hidden prompt.
- Do **not** import data into production ManuFlow during this test. Stop at the company list and the preview
  ("Review"). Importing is a separate business decision.
- Record every result in the table at the end.

---

## Part 0 — Before going to the PC (development machine) 🟢

1. Copy the zip to a USB stick or an internal share; do not use public file-sharing.
2. Send the SHA-256 above to the tester **through a different channel** than the zip, e.g. read it out or put it in
   the ticket.
3. Check that a ManuFlow **administrator** login for the test company is available. Only administrators can create
   pairing codes.

## Part 1 — Prepare the Windows PC 🟢

### 1.1 Open the right window
- **Windows PowerShell 5.1:** Start → type `Windows PowerShell` → right-click → **Run as administrator**.
- **PowerShell 7:** Start → type `PowerShell 7` (or `pwsh`) → right-click → **Run as administrator**.

The title bar must say **Administrator**. Record the version:

```powershell
$PSVersionTable.PSVersion; [Environment]::OSVersion.VersionString; whoami
```

Do the first installation in **Windows PowerShell 5.1**, which is what customers will mostly have. To test
PowerShell 7 as well, uninstall with `-RemoveSettings` (part 9), Disconnect in ManuFlow, and repeat parts 4–9 in
PowerShell 7 **with another new code**.

### 1.2 Node.js 18 or newer, installed for all users

```powershell
node -v                                                              # must print v18.x or newer (v20/v22 LTS recommended)
(Get-Command node.exe).Source                                        # expected: C:\Program Files\nodejs\node.exe
(Get-Item (Split-Path (Get-Command node.exe).Source)).LinkType       # expected: empty (no link)
```

- `node` not found: install the **LTS** from https://nodejs.org with the default options (for all users). Then **close
  this window and open a new administrator window**: an already-open window does not see the new installation.
- The path is inside `C:\Users\...`, or LinkType says `SymbolicLink`/`Junction` (nvm-windows): the connector's
  background account (LOCAL SERVICE) cannot run it. Install Node.js normally for all users before continuing. The
  installer would warn about this and stop at its account check.

### 1.3 Unzip and check the package

```powershell
cd $env:USERPROFILE\Downloads                     # wherever the zip was copied
(Get-FileHash .\manuflow-tally-connector-0.3.2-windows.zip -Algorithm SHA256).Hash
# must equal 5B7B561760657B1A6501745BFD40088C8C1A9691B58EB3F849393858BAB5A6C6 (PowerShell prints it in capitals)
Expand-Archive .\manuflow-tally-connector-0.3.2-windows.zip -DestinationPath . -Force
cd .\manuflow-tally-connector-0.3.2
Get-ChildItem -Recurse -File | Select-Object FullName, Length                 # 6 files
Get-Content .\SHA256SUMS | ForEach-Object { $h, $p = $_ -split '  '; '{0}  {1}' -f ((Get-FileHash $p -Algorithm SHA256).Hash -eq $h), $p }
# all five lines must start with True
Get-Content .\VERSION                                                         # 0.3.2
node .\manuflow-tally-connector.mjs version
# ManuFlow Tally Connector 0.3.2 (Node.js ...) - reads TallyPrime with Export requests only
```

Any mismatch: **stop** and get a fresh copy of the zip.

### 1.4 Execution policy (this window only)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass      # answer Y if asked; affects only this window
Get-ExecutionPolicy -List                                       # if MachinePolicy/UserPolicy is set, Group Policy wins: record it and stop
```

## Part 2 — TallyPrime Server mode and port 9000 🟢 (TallyPrime running; no ManuFlow pairing)

### 2.1 Set it in TallyPrime
- **TallyPrime 2.x and later:** press **F1 (Help) → Settings → Connectivity → Client/Server configuration**. Set
  "TallyPrime is acting as" to **Server** (or **Both**) and **Port** to **9000**. Accept, then restart TallyPrime if it
  asks.
- **Older releases:** **Exchange → Data Synchronization** (or F12 → Advanced Configuration). Set "TallyPrime act as"
  to **Server** and port **9000**.
- Load the **test company** (Alt+F3 / Select Company).
- If Windows Firewall asks about `tally.exe`, allow **Private networks only**. Never allow Public networks.

### 2.2 Check that port 9000 is listening, from this PC only

```powershell
Get-NetTCPConnection -LocalPort 9000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess,
  @{n='Process'; e={(Get-Process -Id $_.OwningProcess).ProcessName}}
# expected: a line whose Process is tally (TallyPrime)
Test-NetConnection 127.0.0.1 -Port 9000 | Select-Object TcpTestSucceeded      # True
```

### 2.3 Read-only check of TallyPrime and ManuFlow with the connector (no pairing, no token)

```powershell
node .\manuflow-tally-connector.mjs check --tally http://127.0.0.1:9000 --server https://www.menu.aetherdevsolutions.online
```

- **Tally:** "connected" means TallyPrime answered a read-only *Export* health request. "not reachable" means
  TallyPrime is closed, not in Server mode, or on another port.
- **ManuFlow:** "can be reached" means HTTPS works with a valid certificate, the connector feature is on, and version
  0.3.2 is accepted.
- This check sends **no token and no code** and changes nothing in Tally or ManuFlow.

### 2.4 Port 9000 must not be reachable from the internet
- `Get-NetFirewallRule -Direction Inbound -Enabled True | Where-Object DisplayName -match 'tally' | Select DisplayName, Profile, Action`.
  Any rule for Tally should be **Private/Domain only**, not Public.
- Ask whoever manages the office router to confirm there is **no port forward** to `10.248.233.150:9000`. The
  connector never needs one: it only connects *out* to ManuFlow over HTTPS 443.

## Part 3 — Optional safety checks before pairing 🟢 [Admin]

Each of these must **stop with a clear message and change nothing**. Run any you have time for:

```powershell
cd .\windows
.\install-connector.ps1 -InstallDir C:\                           # "must not be a drive"
.\install-connector.ps1 -InstallDir $env:ProgramData              # "must not be the system folder"
.\install-connector.ps1 -Server http://example.com                # "must be https://"
```

For a refusal of a bad code, run `.\install-connector.ps1` and type `hello` at the code prompt. Expect "does not look
like a pairing code". This creates no folder and no task.

Afterwards these must both be empty / False:
`Get-ScheduledTask -TaskName 'ManuFlow Tally Connector' -ErrorAction SilentlyContinue` and
`Test-Path C:\ProgramData\ManuFlowTallyConnector`.

## Part 4 — Pair with live ManuFlow using a NEW one-time code 🔵 [Admin]

Do these steps in this order, so the code is used within its 10 minutes:

1. **On the PC:** the administrator PowerShell window is open in the package's `windows` folder, and TallyPrime is open
   with the test company (part 2).
2. **In the browser**, as a ManuFlow administrator: open `https://www.menu.aetherdevsolutions.online` → **Import
   Center → Import from Tally**. The dialog shows "Authorize the Tally connector (one time)".
   - Status "Not connected": click **Connect Tally**.
   - Status "Waiting for pairing" (a code was created earlier): click **New code**. Any older code is then useless;
     never use it.
   - Status "Connected" or "Offline" (paired before): this test is not a first installation. Click **Disconnect**
     first, then **Connect Tally**.
3. ManuFlow shows **Pairing code: XXXXX-XXXXX** and "Valid until …".
   - **Ignore the on-screen line "Run: node manuflow-tally-connector.mjs pair … --code …"**. It would put the code on a
     command line. Use the installer instead.
4. **On the PC:**
   ```powershell
   .\install-connector.ps1
   ```
   It uses the production address and Tally at `http://127.0.0.1:9000` by default. At the prompt **"One-time pairing
   code from ManuFlow…"**, type the code. Nothing is shown while typing. Press Enter.
5. Expected output, roughly in this order:
   - the Node.js check passes, with no user-profile warning;
   - a short pause while the "account check" task runs Node.js as LOCAL SERVICE;
   - `Paired. Settings saved in C:\ProgramData\ManuFlowTallyConnector\connector.json …`;
   - `Installed: ManuFlow Tally Connector 0.3.2 (Node.js …) … task 'ManuFlow Tally Connector' runs as NT AUTHORITY\LOCAL SERVICE, starts with Windows, and is running.`;
   - the last log lines: `… 0.3.2 started`, `Tally: connected`.
6. If it says **"Pairing failed …"**: the code was mistyped, expired or already used. Click **New code** in ManuFlow and
   run `.\install-connector.ps1` again.
   If it says **"The installation is NOT complete"**: record the message and the log lines it prints, then go to part
   10.
7. The code is now used up. Do not write it down anywhere.

## Part 5 — Checks after installation that do not need Tally data 🟢 [Admin]

```powershell
$T = 'ManuFlow Tally Connector'; $D = 'C:\ProgramData\ManuFlowTallyConnector'; $N = (Get-Command node.exe).Source
# Scheduled Task
Get-ScheduledTask -TaskName $T | Select-Object TaskName, State
(Get-ScheduledTask -TaskName $T).Principal | Select-Object UserId, LogonType, RunLevel       # LOCAL SERVICE, ServiceAccount, Limited
(Get-ScheduledTask -TaskName $T).Triggers | Select-Object @{n='Type';e={$_.CimClass.CimClassName}}, StartBoundary,
  @{n='Every';e={$_.Repetition.Interval}}, @{n='For';e={$_.Repetition.Duration}}             # Boot; Time PT5M with an EMPTY "For"
(Get-ScheduledTask -TaskName $T).Settings | Select-Object ExecutionTimeLimit, MultipleInstances  # PT0S, IgnoreNew
Get-ScheduledTaskInfo -TaskName $T | Select-Object LastRunTime, LastTaskResult                   # 267009 = running
Get-ScheduledTask -TaskName "$T - account check" -ErrorAction SilentlyContinue                   # nothing (removed)
# The process runs as LOCAL SERVICE (5.1 and 7)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { '{0}  {1}' -f $_.ProcessId, (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User }
# Folder protection
icacls $D                                          # only Administrators (F), SYSTEM (F), LOCAL SERVICE (M), all (OI)(CI), no (I)
(Get-Acl $D).Owner                                 # BUILTIN\Administrators
icacls "$D\connector.json"                         # the same three, inherited (I)
# Status and log (never show the token)
& $N "$D\manuflow-tally-connector.mjs" status --config "$D\connector.json"
Get-Content "$D\logs\connector.log" -Tail 20 -Encoding UTF8
# The pairing code is nowhere
Select-String -Path (Get-PSReadLineOption).HistorySavePath -Pattern '[A-Z0-9]{5}-[A-Z0-9]{5}' | Select-Object -Last 5   # no match for the code
```

- The "Every 5 minutes" trigger's **For** must be empty, which means indefinitely. Record it if it shows a duration.
- As a **standard user** (another login, or `runas /user:<standarduser> powershell`), run
  `Get-Content C:\ProgramData\ManuFlowTallyConnector\connector.json`. It must give **Access denied**.
- No listening port: `Get-NetTCPConnection -State Listen | Where-Object OwningProcess -in (Get-Process node).Id`
  must return nothing.

## Part 6 — Checks that need the real TallyPrime connection 🔵

1. In ManuFlow, **Import from Tally** shows "Connecting to TallyPrime…" and then moves by itself to **Which Tally
   company?**, listing the companies open in TallyPrime. Record how many seconds that took.
2. **Connector details** shows:
   - Computer: the PC's name · win32 · connector v0.3.2;
   - Tally address: 127.0.0.1:9000;
   - Last check-in: just now.
3. Choose the test company → Next → choose one master kind, e.g. *Customers* → go up to **Review**. You should see
   counts and a preview. **Do not press "Yes, import".** Close the dialog.
4. In TallyPrime, check that nothing changed in the test company: no new or altered masters or vouchers. The
   connector sends only *Export* requests.
5. **Close TallyPrime.** Within about a minute ManuFlow shows "TallyPrime is not reachable" and the log shows
   `Tally: not reachable`. **Open TallyPrime** and load the company: it goes back to Connected with no action needed.
6. **Network drop:** unplug the network or turn off Wi-Fi for about 10 minutes. ManuFlow shows Offline /
   Reconnecting. Reconnect: Connected within about 5 minutes.

## Part 7 — Recovery after the program stops and after a restart 🔵 (for the Tally part) [Admin]

1. **Process ended:** Task Manager → Details → `node.exe` (user LOCAL SERVICE) → End task. Within **5 minutes**
   `node.exe` runs again (the watchdog trigger) and ManuFlow is Connected. Record the time it took.
2. **Second copy refused:**
   `& $N "$D\manuflow-tally-connector.mjs" run --config "$D\connector.json"` prints "Another copy of the connector is
   already running …". It exits; nothing else changes.
3. **Restart without signing in:** Start → Restart. Leave the PC at the sign-in screen for 5 minutes.
   - ManuFlow → Import from Tally → Connector details shows a fresh **Last check-in**, and states that TallyPrime is
     not reachable (Tally is closed). This proves the connector runs before anyone signs in.
   - Sign in, open TallyPrime and load the company: Connected.
   - The log shows `… 0.3.2 started` after the restart, with **no** "Another copy … already running" lines. Those would
     mean the stale-lock fix did not work.

## Part 8 — Upgrade and repair [Admin]

**Upgrade (same package, no code)** 🟢
```powershell
.\install-connector.ps1
```
Expect, in this order:
- "Stopped the running connector for the upgrade";
- possibly "Removed the lock file left by the stopped connector";
- "Already paired with https://www.menu.aetherdevsolutions.online: keeping the existing pairing";
- **no code prompt**;
- "… and is running".

`status` shows the **same device id** as before. A real version upgrade (0.3.2 → newer) can only be tested once a
newer build exists.

**Wrong-server guard** 🟢
`.\install-connector.ps1 -Server https://example.com` must stop with "This computer is paired with … Nothing was
changed". The task is still running.

**Repair with another NEW code** 🔵
1. ManuFlow → Import from Tally → **Pair another computer**. While connected, this is the button that creates a new
   code. A new code appears.
2. `.\install-connector.ps1 -Repair`, then type the new code.
3. Expect "Repair: this computer is paired again with a new code (its device identity is kept)" and "… is running".
   `status` shows the **same device id**. ManuFlow shows this PC as Connected.

## Part 9 — Uninstall [Admin]

Decide with the supervisor whether the connector stays installed after the test. If it stays, run only steps 1–3 and
then reinstall (step 3).

1. **Dry run:** `.\uninstall-connector.ps1 -RemoveSettings -WhatIf`. Only "What if: …" lines and "WhatIf: nothing was
   removed" appear. The task, program and `connector.json` still exist.
2. `.\uninstall-connector.ps1`:
   - the task is removed and `node.exe` is gone;
   - "Removed …" appears for the program, VERSION and the lock;
   - "Kept the pairing and the log …".
3. **Reinstall from the kept pairing:** `.\install-connector.ps1` connects again with **no code**.
4. To finish completely: `.\uninstall-connector.ps1 -RemoveSettings`. Answer **N** once: "Kept the pairing". Run it
   again and answer **Y**: the files are deleted and the folder is gone.
5. In ManuFlow, **Disconnect** (then **Yes, disconnect**). This ends the token at once.

TallyPrime and its data are never touched by uninstalling.

## Part 10 — If something goes wrong

- **Before part 4:** nothing has been installed. Fix the cause (Node.js, Tally settings) or stop.
- **After part 4:**
  1. Copy the exact message and `Get-Content C:\ProgramData\ManuFlowTallyConnector\logs\connector.log -Tail 50 -Encoding UTF8`
     into the results. The log never contains the token or the code.
  2. `.\uninstall-connector.ps1 -RemoveSettings` and answer Y.
  3. In ManuFlow, click **Disconnect**.
- **Never** send `connector.json` to anyone; it contains the token. If it may have been copied, click Disconnect in
  ManuFlow.

## Results

| Part | Check | 5.1 | 7 | Notes / time |
|---|---|---|---|---|
| 1 | Admin window, PS version, Node.js path (no link, not in a profile) | | | |
| 1 | Zip SHA-256 and SHA256SUMS all True | | | |
| 2 | TallyPrime Server on port 9000; `check` Tally connected + ManuFlow reachable | | | |
| 2 | No public-profile rule or router forward for 9000 | | | |
| 3 | Refusals changed nothing | | | |
| 4 | New code; installer output; "is running" | | | |
| 5 | Task: LOCAL SERVICE, Boot + 5-min trigger (indefinite), PT0S, IgnoreNew, 267009 | | | |
| 5 | node.exe owner LOCAL SERVICE; folder ACL and owner; standard user denied | | | |
| 5 | `status` without token; code not in history; no listening port | | | |
| 6 | Company list appeared automatically (seconds) | | | |
| 6 | Preview only; TallyPrime unchanged | | | |
| 6 | Tally closed → not reachable → reopened → Connected | | | |
| 6 | Network drop → Offline → Connected (minutes) | | | |
| 7 | node.exe ended → back within 5 min (minutes) | | | |
| 7 | Second copy refused | | | |
| 7 | Restart without sign-in → check-in; no "already running" in log | | | |
| 8 | Upgrade keeps pairing and device id; no code prompt | | | |
| 8 | Wrong `-Server` refused, nothing changed | | | |
| 8 | Repair with a new code keeps device id | | | |
| 9 | -WhatIf removed nothing; uninstall kept pairing; reinstall without code | | | |
| 9 | -RemoveSettings asks; N keeps, Y removes; Disconnect in ManuFlow | | | |
