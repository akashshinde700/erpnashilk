# Starting the Tally connector automatically

The ManuFlow Tally Connector (`connector/tally/manuflow-tally-connector.mjs`) only reads from TallyPrime. Once it is
paired, `run` keeps it connected by itself: it survives ManuFlow restarts, network outages and server errors, and saves
rotated tokens on its own. Only one thing makes it stop: being disconnected in ManuFlow (exit code 2, token deleted)
or never having been paired (exit code 2).

This page sets it up to start when the computer starts, so nobody has to type `run` again. **Nothing here is installed
automatically.** Installing it on a customer's computer needs that customer's approval, and must be done by someone who
may administer that computer.

Before you start:

* The connector is **paired**. `node manuflow-tally-connector.mjs status` says "Paired with …".
* `node manuflow-tally-connector.mjs check` says `Tally: connected`.
* It runs as the **same user** that paired it, because the token is in that user's settings folder. Never run it as
  root or as Administrator.
* Close any `run` you started by hand first (Ctrl+C), so two copies don't run at once.

## Linux: systemd user service

Checked with `systemd-analyze --user verify` on systemd 255 (Ubuntu 24.04). It has not been installed or run as a
service yet.

### Install

```bash
# 1. Put the program in a fixed place in the user's home folder
mkdir -p ~/manuflow-tally-connector
cp manuflow-tally-connector.mjs ~/manuflow-tally-connector/

# 2. Install the unit with the absolute path of node (nvm installs node under ~/.nvm/…)
mkdir -p ~/.config/systemd/user
sed "s#^ExecStart=NODE #ExecStart=$(command -v node) #" manuflow-tally-connector.service \
  > ~/.config/systemd/user/manuflow-tally-connector.service
systemd-analyze --user verify ~/.config/systemd/user/manuflow-tally-connector.service

# 3. Start it now and at every login
systemctl --user daemon-reload
systemctl --user enable --now manuflow-tally-connector.service

# 4. Optional: also start at boot, before anyone logs in
sudo loginctl enable-linger "$USER"
```

### Check

```bash
systemctl --user status manuflow-tally-connector.service
journalctl --user -u manuflow-tally-connector.service -n 20   # one line per check-in; the token is never printed
```

ManuFlow → Import Center → Import from Tally should show **Connected to Tally**.

### Remove

```bash
systemctl --user disable --now manuflow-tally-connector.service
rm ~/.config/systemd/user/manuflow-tally-connector.service
systemctl --user daemon-reload
sudo loginctl disable-linger "$USER"     # only if you enabled it in step 4
```

Removing the service leaves the pairing in place. To end the pairing as well, click **Disconnect** in ManuFlow, or run
`node manuflow-tally-connector.mjs forget` and then Disconnect in ManuFlow.

## Windows: Task Scheduler

Use the install script and guide in **[tally-connector-windows.md](tally-connector-windows.md)**
(`connector/tally/windows/install-connector.ps1`): a task at Windows startup as `NT AUTHORITY\LOCAL SERVICE`,
re-started every 5 minutes if it is not running, settings in `C:\ProgramData\ManuFlowTallyConnector\` restricted to
Administrators, SYSTEM and LOCAL SERVICE, log file with rotation. The earlier per-user "at sign-in" task described here
was replaced by it (it ran only while that user was signed in). The script has not been run on Windows yet.

## Security notes for both

* The connector only connects out over HTTPS. Do not open TallyPrime's port 9000 to the internet, and on Windows allow
  it in the firewall only for the connector's own computer.
* Neither the service nor the task runs with administrator or root rights (installing the Windows task needs an
  administrator once). Do not grant them.
* The logs show the time, the Tally status and record counts. They never show the token or pairing code.
