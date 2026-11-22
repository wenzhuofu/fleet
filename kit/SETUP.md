# Fleet setup

Fleet is a private control centre for one VPS and its Windows engineering machines. Keep the VPS, PCs, and browser on the same Tailscale network; do not expose Fleet or desk-node ports publicly.

## 1. Prepare the VPS

Use Ubuntu/Debian and sign the VPS into Tailscale. Bootstrap checks `git`, `python3`, `curl`, `xz-utils`, `dpkg-deb`, Tailscale and linger; if anything is missing, it prints the administrator commands. Adding Windows machines later also needs this user to be the Tailscale Serve operator (`sudo tailscale set --operator=$USER`).

```sh
git clone <desk-fleet-repository> ~/fleet/desk-fleet
cd ~/fleet/desk-fleet
cp kit/fleet.conf.example kit/fleet.conf
```

Edit `kit/fleet.conf` if the defaults do not fit, then run `kit/bootstrap-vps.sh kit/fleet.conf`. Bootstrap installs Node 24, Claude CLI and Orca (the desktop package, run headless as `orca-ide serve` in `orca.service`), and creates the user services and runtime configuration. Orca listens on port `6768` and refuses peers outside localhost, LAN and the tailnet; keep that port closed in the VPS firewall. The updater reads this same `kit/fleet.conf`. If you customize `FLEET_HOME`, clone desk-fleet into its `desk-fleet` subdirectory and use that path in the commands below.

## 2. Sign in and pair Orca

Run Claude once, complete sign-in, then check desk from any directory:

```sh
~/.local/bin/claude      # then /desk:status, and /desk:use <machine> [dir] to bind this directory
```

Pair the Orca desktop app (Settings → Remote Orca Servers → Add Server) or a browser with the link from `~/opt/orca/opt/Orca/resources/bin/orca-ide pair --address <tailnet IP>`, and the phone app with `--mobile`. Each link works once; run the command again for another device. Open any directory as a folder project; bind it with `/desk:use` if it should work on a machine other than the default. Bootstrap auto-allows only desk `Read`, `Glob` and `Grep` (in `~/.claude/settings.json`); `Bash`, `Write`, `Edit`, `Copy` and machine management still ask. Existing settings are preserved.

## 3. Add a Windows machine

Install Git for Windows and Tailscale on the PC and sign into the same tailnet. On the VPS, run the temporary package-serving step as the Tailscale Serve operator :

```sh
cd ~/fleet/desk-fleet && kit/new-machine.sh start pc-home
```

Follow the generated PowerShell commands: download/unpack in normal PowerShell; run `join-machine.ps1 -Admin` elevated; then run the printed `join-machine.ps1 -Package ...` command as the Windows account that will run desk-node. `-Profile daily` starts at logon; `-Profile server` starts at boot and requires elevated PowerShell plus the Windows account password. On a first install, append `-DenyPaths D:\private,E:\hr` to the normal install command if needed. Finally, run the `kit/new-machine.sh finish ...` command printed by Windows on the VPS; it configures SSH, transfers the token without displaying it, updates `machines.json`, and checks machine health.

## 4. Restrict machine folders

On each PC, `C:\desk-node\data\config.json` contains `denyPaths` (the installer currently stores the file under `data`). Use absolute Windows paths; they are normalized to forward slashes and are inaccessible to Claude's desk tools. Edit only this field, preserve the other settings, then restart desk-node:

```json
"denyPaths": ["D:/private", "E:/hr"]
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\desk-node\current\deploy\service.ps1 restart
```

## 5. Upgrade and troubleshoot

Upgrade on the VPS with `cd ~/fleet/desk-fleet && kit/update.sh` (the worktree must be clean). A new Orca version takes effect after `systemctl --user restart orca`, which ends the Claude sessions running inside it.

```sh
cd ~/fleet/desk-fleet
kit/fleet-doctor.sh --no-claude   # skip the Claude call before sign-in
kit/fleet-doctor.sh --machines    # also check Windows machines over SSH
```

The doctor reports `PASS`, `FAIL`, or `SKIP` with suggested fixes. For Windows details, inspect `C:\desk-node\logs\desk-node.log`; run `powershell -NoProfile -ExecutionPolicy Bypass -File C:\desk-node\current\deploy\service.ps1 status` to check the service, or replace `status` with `restart` to restart it.
