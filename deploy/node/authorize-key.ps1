# Authorize the VPS's out-of-band SSH key on this machine (Windows OpenSSH Server).
#   authorize-key.ps1 -Key 'ssh-ed25519 AAAA... desk-fleet VPS -> <name>'
# Windows OpenSSH reads keys of Administrators-group users from
# C:\ProgramData\ssh\administrators_authorized_keys (needs an elevated PowerShell; the file must be
# Administrators/SYSTEM only), and other users' keys from ~\.ssh\authorized_keys.
param([Parameter(Mandatory = $true)][string]$Key)
$ErrorActionPreference = 'Stop'
$Key = $Key.Trim()
if ($Key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$') { throw 'expected one line: ssh-ed25519 <base64> [comment]' }
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'OpenSSH Server (sshd) is not installed; see add-machine.md step 2' }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdminUser = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
  ((& whoami.exe /groups) -match 'S-1-5-32-544')
if ($isAdminUser) {
  if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'this user is an administrator: run this script in an elevated PowerShell (administrators_authorized_keys)'
  }
  $file = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
} else {
  $file = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
  New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
}
$existing = if (Test-Path $file) { Get-Content $file } else { @() }
$body = ($Key -split ' ')[1]
if ($existing | Where-Object { $_ -match [regex]::Escape($body) }) { "already authorized in $file"; return }
Add-Content -Path $file -Value $Key -Encoding ascii
if ($isAdminUser) {
  & icacls.exe $file /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
} else {
  & icacls.exe $file /inheritance:r /grant "$($id.Name):F" /grant 'SYSTEM:F' | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "icacls failed for $file" }
"authorized in $file"
