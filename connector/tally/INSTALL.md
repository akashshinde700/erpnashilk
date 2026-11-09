# ManuFlow Tally Connector — installation guide (Windows)

The connector is a small program that lets **ManuFlow ERP read data from TallyPrime** on your office computer. It
only **reads** from Tally (customers, suppliers, stock items, company list); it **never changes anything in Tally**.
It connects **out** to ManuFlow over a secure (HTTPS) connection, so nothing has to be opened on your router or
firewall, and Tally's port 9000 stays inside your office.

You install it **once per computer**. After that it starts with Windows and reconnects by itself.

## What you need

- A Windows 10 / 11 (or Windows Server 2016+) computer in the office that can reach TallyPrime. Usually this is the
  TallyPrime computer itself.
- An **administrator** account on that computer.
- **Node.js 18 or newer**, installed for all users: download the "LTS" version from <https://nodejs.org> and install
  it with the default options (into `C:\Program Files\nodejs`; not through nvm, and not into a user folder). **After
  installing Node.js, open a new PowerShell window**: a window that was already open does not see it.
- In **TallyPrime**: *F1 Help → Settings → Connectivity* — set "TallyPrime acts as" to **Server** or **Both**, port
  **9000**. Keep TallyPrime open with your company loaded when you want to import.
- In **ManuFlow** (as an administrator): **Import Center → Import from Tally**. The screen shows "Authorize the Tally
  connector (one time)" — click **Connect Tally** to get a **one-time pairing code** (valid for 10 minutes).

## Install

1. Unzip `manuflow-tally-connector-<version>-windows.zip` to a folder, for example your Desktop.
2. Optional, recommended: check the download. In PowerShell, in the unzipped folder:
   `Get-FileHash .\manuflow-tally-connector.mjs` — the value must match the line for that file in `SHA256SUMS`.
3. Open the `windows` folder inside it. Right-click the Start button → **Terminal (Admin)** / **Windows PowerShell
   (Admin)**, then go to that folder, e.g.:
   ```powershell
   cd "$env:USERPROFILE\Desktop\manuflow-tally-connector-<version>\windows"
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-connector.ps1
   ```
   If TallyPrime runs on **another** computer in the office, add its address: `.\install-connector.ps1 -Tally http://192.168.1.20:9000`
4. When asked, **type the pairing code** shown in ManuFlow (e.g. `ABCDE-FGHJK`). It is not shown while you type and
   is not saved anywhere. (Before that, the installer checks Node.js and briefly runs a test task to make sure the
   background account can run it.)
5. Wait for "Installed … and is running". The installer only says this after checking that the background task
   really runs; otherwise it stops with "The installation is NOT complete" and the last lines of the log. In
   ManuFlow, **Import from Tally** now connects by itself ("Connecting to TallyPrime…") and shows your Tally
   companies within a minute.

The installer refuses an existing `C:\ProgramData\ManuFlowTallyConnector` folder that was not created by an
administrator or that holds other files, and an existing pairing for a different ManuFlow address. It says why and
what to do; it never changes such a folder or pairing by itself.

The connector is installed in `C:\ProgramData\ManuFlowTallyConnector` (readable only by administrators and the
connector itself) and runs as a background task ("ManuFlow Tally Connector") — no window stays open.

## Everyday use

Nothing to do: the connector starts with Windows. Open TallyPrime with your company, then use **Import from Tally**
in ManuFlow. If the connector stops for any reason, Windows starts it again within 5 minutes.

## If something is wrong

| ManuFlow shows | What to do |
|---|---|
| Authorize the Tally connector (one time) | The computer is not paired yet: install it as above. |
| The Tally connector is not responding | Is the computer on and connected to the internet? Restart it; the connector starts by itself. |
| TallyPrime is not reachable | Open TallyPrime and load the company; check "TallyPrime acts as Server/Both" and port 9000. |
| This computer must be authorized again | Get a new code in ManuFlow, then run `.\install-connector.ps1 -Repair` and type the code. |
| The Tally connector needs an update | Unzip the newer package and run `.\install-connector.ps1` again (no new code needed). |

Check the connector on the computer (PowerShell as administrator):

```powershell
& "C:\Program Files\nodejs\node.exe" C:\ProgramData\ManuFlowTallyConnector\manuflow-tally-connector.mjs status --config C:\ProgramData\ManuFlowTallyConnector\connector.json
& "C:\Program Files\nodejs\node.exe" C:\ProgramData\ManuFlowTallyConnector\manuflow-tally-connector.mjs check --config C:\ProgramData\ManuFlowTallyConnector\connector.json
Get-Content C:\ProgramData\ManuFlowTallyConnector\logs\connector.log -Tail 20 -Encoding UTF8
```

These never show the token or the pairing code.

## Upgrade

Unzip the new version and run `.\install-connector.ps1` again as administrator. Your pairing is kept; no new code is
needed. If your ManuFlow is not at the default address, give the same `-Server` as at the first installation. To
change the Tally address at the same time, add `-Tally http://<address>:9000`.

## Uninstall

```powershell
.\uninstall-connector.ps1                   # removes the task and the program; keeps the pairing and the log
.\uninstall-connector.ps1 -RemoveSettings   # also deletes the pairing and the log (asks first)
.\uninstall-connector.ps1 -RemoveSettings -WhatIf   # only shows what would be removed
```

Then, in ManuFlow, click **Disconnect** (Import Center → Import from Tally) if this computer should no longer read
Tally. Uninstalling never touches TallyPrime or your ManuFlow data.

## Security, in short

- Read-only: the connector sends Tally only *Export* requests; it cannot create, change or delete anything in Tally.
- Outbound HTTPS only, with the server certificate checked; Tally's port 9000 is never exposed to the internet.
- The pairing code is used once; the token it is exchanged for is stored only on this computer, in a folder only
  administrators and the connector can open. It is renewed every 7 days and is ended at once by **Disconnect** in
  ManuFlow.
- The token works only together with this computer's device identity, which is kept in the same settings file. So
  **copying the whole settings file to another computer copies the identity too**: treat `connector.json` like a
  password, and never copy it or include it in a backup you share. If it is copied anyway, ManuFlow notices at the
  next weekly token renewal: one of the two copies (possibly the one on this computer) is then refused. If you suspect a copy, click **Disconnect** in
  ManuFlow and pair this computer again.
- The connector only talks to the Tally address you set (this computer or one in your office network); it does not
  scan the network.
