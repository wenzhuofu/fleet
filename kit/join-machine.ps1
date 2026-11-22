# Join this Windows machine to the fleet. Two parts; kit/new-machine.sh start <name> on the VPS
# prints both command lines.
#
#   1) Admin part (elevated PowerShell, once per machine):
#        join-machine.ps1 -Admin -VpsKey 'ssh-ed25519 AAAA... desk-fleet VPS -> <name>'
#      OpenSSH Server installed, service Automatic + running; exactly one inbound SSH rule
#      ("SSH via Tailscale only", TCP 22 from 100.64.0.0/10), every other enabled inbound rule for
#      TCP 22 disabled (OpenSSH-Server-In-TCP, Preview rules...); DefaultShell = Git Bash; the VPS
#      key authorized (administrators_authorized_keys for admin accounts).
#
#   2) User part (normal PowerShell, as the account desk-node will run as):
#        join-machine.ps1 -Package C:\desk-node\incoming\desk-node-<v>.tar.gz -Profile daily|server -MachineName <name>
#                         [-DefaultDir D:\git] [-DenyPaths D:\private] [-Port 7801] [-Root C:\desk-node] [-NoService]
#      Runs install.ps1: release, config.json, local token, scheduled task, tailscale serve; prints the
#      kit/new-machine.sh finish command for the VPS. (-Profile server registers the boot task and
#      asks for the Windows password, so it needs an elevated PowerShell too.)
[CmdletBinding(DefaultParameterSetName = 'User')]
param(
  [Parameter(ParameterSetName = 'Admin', Mandatory = $true)][switch]$Admin,
  [Parameter(ParameterSetName = 'Admin')][string]$VpsKey,
  [Parameter(ParameterSetName = 'Admin')][string]$GitBash = 'C:\Program Files\Git\bin\bash.exe',
  [Parameter(ParameterSetName = 'User', Mandatory = $true)][string]$Package,
  [Parameter(ParameterSetName = 'User', Mandatory = $true)][ValidateSet('daily', 'server')][string]$Profile,
  [Parameter(ParameterSetName = 'User', Mandatory = $true)][string]$MachineName,
  [Parameter(ParameterSetName = 'User')][string]$DefaultDir = 'D:\git',
  [Parameter(ParameterSetName = 'User')][string[]]$DenyPaths = @(),
  [Parameter(ParameterSetName = 'User')][int]$Port = 7801,
  [Parameter(ParameterSetName = 'User')][string]$Root = 'C:\desk-node',
  [Parameter(ParameterSetName = 'User')][switch]$NoService
)
$ErrorActionPreference = 'Stop'
function Find-Script($name) {
  foreach ($d in @($PSScriptRoot, (Join-Path $PSScriptRoot '..\deploy\node'))) { $p = Join-Path $d $name; if (Test-Path $p) { return $p } }
  throw "$name not found next to join-machine.ps1"
}
$isElevated = (New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Admin) {
  if (-not $isElevated) { throw 'The admin part needs an elevated PowerShell (Run as administrator).' }
  # 1. OpenSSH Server (Windows updates have been seen to drop the sshd service: re-register it)
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
  if ($cap.State -ne 'Installed') { "installing $($cap.Name)"; Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    $exe = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
    if (-not (Test-Path $exe)) { throw "sshd.exe missing ($exe): Remove-WindowsCapability then Add-WindowsCapability -Online -Name $($cap.Name)" }
    New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName $exe -StartupType Automatic | Out-Null
    're-registered the sshd service'
  }
  Set-Service sshd -StartupType Automatic
  # 2. DefaultShell = Git Bash (out-of-band commands and new-machine.sh use bash syntax)
  if (-not (Test-Path $GitBash)) { throw "Git Bash not found at $GitBash (install Git for Windows, or pass -GitBash)" }
  New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $GitBash -PropertyType String -Force | Out-Null
  "DefaultShell = $GitBash"
  # 3. Firewall: one allow rule for TCP 22, tailnet only. Any enabled allow rule opens the port,
  #    so every other one must be disabled.
  $fw = New-Object -ComObject HNetCfg.FwPolicy2
  $ours = 'SSH via Tailscale only'
  $rule = $fw.Rules | Where-Object { $_.Name -eq $ours } | Select-Object -First 1
  if (-not $rule) {
    New-NetFirewallRule -Name 'fleet-ssh-tailnet' -DisplayName $ours -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress '100.64.0.0/10' -Action Allow -Profile Any | Out-Null
    "added firewall rule '$ours'"
  } else {
    $rule.RemoteAddresses = '100.64.0.0/255.192.0.0'; $rule.Enabled = $true; $rule.Profiles = 0x7FFFFFFF
  }
  foreach ($r in $fw.Rules) {
    if ($r.Direction -eq 1 -and $r.Action -eq 1 -and $r.Enabled -and $r.Protocol -eq 6 -and ($r.LocalPorts -split ',') -contains '22' -and $r.Name -ne $ours) {
      $r.Enabled = $false; "disabled firewall rule '$($r.Name)' (remote $($r.RemoteAddresses))"
    }
  }
  # 4. VPS key
  if ($VpsKey) { & (Find-Script 'authorize-key.ps1') -Key $VpsKey }
  Restart-Service sshd
  "sshd: $((Get-Service sshd).Status)"
  'admin part done; now run the user part in a normal PowerShell.'
  return
}

# ---------- user part ----------
if ($Profile -eq 'daily' -and $isElevated) { 'WARNING: elevated PowerShell; desk-node will still run as this user, not elevated.' }
$inst = @{ Package = $Package; Profile = $Profile; MachineName = $MachineName; DefaultDir = $DefaultDir; Port = $Port; Root = $Root }
if ($DenyPaths) { $inst.DenyPaths = $DenyPaths }
if ($NoService) { $inst.NoService = $true }
& (Find-Script 'install.ps1') @inst
