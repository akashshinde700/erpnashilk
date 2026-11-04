# Tally Connector on Windows: install, first-time authorisation, automatic reconnect, troubleshooting

## Status

* **Built and tested on Linux only**, against a mock TallyPrime and the test database (`tests/tally-autoconnect.test.ts`).
* `connector/tally/windows/install-connector.ps1` and `uninstall-connector.ps1` have **not been run on a Windows PC
  yet**. The checklist at the end is what has to be done and recorded on the first one.
* The connector has been run against a real TallyPrime (company list, masters, Day Book capture), from Linux. The
  automatic connection has **not** been run against a real TallyPrime or the production server.

## What is automatic, and what is not

| | |
|---|---|
| **Once per computer (manual, on purpose)** | An administrator creates a one-time code in ManuFlow; someone runs the install script with it on the PC. This is the device authorisation: ManuFlow never accepts a connector it has not been given a code for. |
| **Automatic after that** | The connector starts with Windows, checks TallyPrime every 5–30 s, reports to ManuFlow, reconnects by itself after Tally closes, Windows restarts, the network drops or ManuFlow restarts, and renews its token every 7 days. When a user opens Import from Tally, the dialog sees the connector, goes on to the company list by itself, fetches the companies and shows them. The user only chooses the company. |
| **Manual again only if** | its token expired ("Authentication failed": a weekly token renewal did not reach the connector and it then stayed offline for more than 30 days), its settings were copied to another computer ("Authentication failed": different computer), it is moved to another computer, or it was disconnected in ManuFlow. Then: a new code and the install script once more. |

There is no network discovery: ManuFlow never searches the office network, and nothing listens for connections on the
PC. "Detecting the connector" means ManuFlow looking at the last check-in of the connector paired with this company.

## Requirements

* Windows 10 / 11 or Windows Server 2016+, Windows PowerShell 5.1 (built in), an administrator account for the
  installation.
* **Node.js 18 LTS or newer, installed for all users** (the default `C:\Program Files\nodejs`).
* TallyPrime: *F1 Help → Settings → Connectivity* (or *Exchange → Data Synchronization*): "TallyPrime acts as" =
  **Server** or **Both**, port **9000** (or note the port used).
* Outbound HTTPS from the PC to the ManuFlow address. Nothing inbound.

## Install (first time on a computer)

1. ManuFlow → **Import Center → Import from Tally → Connect Tally** (administrator). Note the code (10 minutes, once).
2. Copy the `connector\tally` folder (it contains `manuflow-tally-connector.mjs` and `windows\`) to the PC.
3. On the PC, **PowerShell as administrator**, in that `windows` folder:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass        # this window only
   .\install-connector.ps1 -Server https://<your ManuFlow address> -Code ABCDE-FGHJK
   # Tally on another PC in the office:  -Tally http://192.168.1.20:9000
   ```

4. ManuFlow shows **Connecting…**, then **Connected to Tally** within a minute. Done.

What the script does:

* copies the program to `C:\ProgramData\ManuFlowTallyConnector\`;
* restricts that folder to Administrators, SYSTEM and LOCAL SERVICE (well-known SIDs, so any Windows language);
* pairs once (`connector.json` there holds the token, the Tally address and the computer's random device id);
* registers the task **ManuFlow Tally Connector**: runs as `NT AUTHORITY\LOCAL SERVICE`, at Windows startup and
  re-started every 5 minutes if it is not running; no time limit; no window; log in `logs\connector.log`.

Running the script again without `-Code` keeps the pairing and only re-installs the program and the task (use this to
update the connector to a new version).

### Why a scheduled task as LOCAL SERVICE, and not a Windows service

| Option | Verdict |
|---|---|
| Windows service | Node.js is not a service program: it needs a third-party wrapper (NSSM, WinSW) downloaded and trusted on the client PC. Not chosen. |
| Task at user sign-in (the earlier note in `tally-connector-startup.md`) | Only runs while that user is signed in, shows or hides a console window depending on the setup, and the token sits in that user's profile. Not chosen. |
| **Task at startup as LOCAL SERVICE** | Built into Windows, starts before anyone signs in, no window, no password stored, an account with minimal rights. Reaching TallyPrime on `127.0.0.1:9000` works from it, because that is a local TCP connection. **Chosen.** |

The "every 5 minutes" trigger is the recovery: if the connector ever stops, the next trigger starts it, and the
connector's lock file (`connector.json.lock`) makes a start while it is already running exit at once.

## Change the Tally address later (no new code)

```powershell
& "C:\Program Files\nodejs\node.exe" C:\ProgramData\ManuFlowTallyConnector\manuflow-tally-connector.mjs set-tally --tally http://192.168.1.25:9000 --config C:\ProgramData\ManuFlowTallyConnector\connector.json
```

Only `127.0.0.1` / `localhost` or a private address (10.x, 172.16–31.x, 192.168.x) is accepted. The running connector
uses it from its next check.

## Check

```powershell
Get-ScheduledTask -TaskName 'ManuFlow Tally Connector' | Get-ScheduledTaskInfo      # LastTaskResult 267009 = running
Get-Content C:\ProgramData\ManuFlowTallyConnector\logs\connector.log -Tail 20
& "C:\Program Files\nodejs\node.exe" C:\ProgramData\ManuFlowTallyConnector\manuflow-tally-connector.mjs check --config C:\ProgramData\ManuFlowTallyConnector\connector.json
```

`check` tests TallyPrime (read-only health request) and ManuFlow (`POST /api/tally-connector/ping`: reachable, switched
on, version accepted). It sends no token.

The log has one line when something changes (and the same line at most once an hour), one line per Tally read, never
the token or the code. It is cut at 1 MB, with one older file (`connector.log.1`) kept.

## Troubleshooting

| ManuFlow shows | Meaning | Do this |
|---|---|---|
| Device authorization required | No connector is paired with this company. | Install with a new code (above). |
| Connecting… | Paired, first check-in not seen yet. | Wait a minute. Then check the task and the log. |
| Connector offline / Reconnecting… | No check-in for 90 s / 6 min. | Is the PC on and online? `Get-ScheduledTaskInfo`; the log; `check`. A proxy that needs a login is not supported (Node.js does not use the Windows proxy settings). |
| Tally not reachable | The connector runs but TallyPrime does not answer. | Open TallyPrime with a company loaded; "acts as Server/Both"; port; `set-tally` if Tally is on another PC. |
| Connector update required | The program on the PC is older than this ManuFlow accepts. | Copy the new `connector\tally` folder and run the install script again without `-Code`. |
| Authentication failed: offline too long | The token expired: a renewal did not reach the connector, and it then stayed offline for over 30 days. | New code; install script with `-Code`. |
| Authentication failed: different computer | The token arrived with another computer's device id (settings copied). | If you know why: pair that computer with its own code. If not: **Disconnect**, then pair the right PC. |
| No company open in Tally | TallyPrime answered with an empty list. | Load the company in TallyPrime; Refresh. |
| Same name as another open company | Two open companies share a name; Tally exports select by name. | Close one in TallyPrime; Refresh. |

Exit codes of the program: `2` = not paired or disconnected in ManuFlow (restarting does not help); `3` = another copy
is already running with the same settings (harmless).

## Remove

```powershell
.\uninstall-connector.ps1                     # removes the task; keeps the folder
.\uninstall-connector.ps1 -RemoveSettings     # also deletes the folder with the token (asks first)
```

Then **Disconnect** in ManuFlow, which ends the token at once even if a copy of it exists somewhere.

## Security

* **Read-only:** the program sends TallyPrime only `TALLYREQUEST=Export` requests it builds itself, through
  `postToTally()` / `isExportRequest()`. ManuFlow can only name a job from a fixed list; it never sends XML, a URL or a
  command. Nothing in the program can write to Tally.
* **No inbound port:** do not open port 9000 to the internet or forward it; the firewall can keep it local.
* **Token:** stored in `connector.json` in a folder only Administrators, SYSTEM and LOCAL SERVICE can open; only a
  SHA-256 hash is kept in ManuFlow; renewed every 7 days; works only together with this computer's device id; ended at
  once by Disconnect. It is **not** encrypted with Windows DPAPI: the program uses only Node.js built-ins, which cannot
  call DPAPI. A Windows administrator can therefore read it, as they could read anything on that PC.
* **The pairing code** passed to the script is single-use and expires after 10 minutes; it may remain in the PowerShell
  history, where it is useless.
* **No secrets in logs:** the log has states and counts only.

## First Windows PC: checklist (record the results)

1. Windows version, PowerShell version (`$PSVersionTable`), Node.js version and path.
2. Install script: no error; folder permissions (`icacls C:\ProgramData\ManuFlowTallyConnector`) show only the three
   accounts.
3. Task: runs as LOCAL SERVICE, LastTaskResult 267009; the log shows "started" and "Tally: connected".
4. ManuFlow: Connecting → Connected; Import from Tally lists the companies open in TallyPrime; choosing one enables
   Next.
5. Restart Windows without signing in: ManuFlow shows Connected again within a few minutes.
6. Close TallyPrime: "Tally not reachable"; open it: Connected, without doing anything else.
7. Unplug the network for 10 minutes: Offline; plug in: Connected.
8. End the node process in Task Manager: running again within 5 minutes.
9. Start a second copy by hand: it exits with "already running".
10. Whether the 5-minute trigger is really repeating on that Windows version (Task Scheduler → task → Triggers).
11. `uninstall-connector.ps1 -RemoveSettings`, then Disconnect in ManuFlow.
