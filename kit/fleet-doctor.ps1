# Health check of a fleet machine (Windows). Runs as a normal user; every check prints PASS / FAIL
# and, on failure, the fix (commands marked [admin] need an elevated PowerShell). Exit 1 if any failed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File fleet-doctor.ps1 [-Root C:\desk-node]
param([string]$Root = 'C:\desk-node', [string]$GitBash = 'C:\Program Files\Git\bin\bash.exe')
$ErrorActionPreference = 'Continue'
$script:fails = 0
function Pass($m) { "PASS $m" }
function Fail($m, $fix) { "FAIL $m"; "     fix: $fix"; $script:fails++ }

'== OpenSSH Server (out-of-band channel)'
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $svc) { Fail 'sshd service exists (Windows updates can drop it)' '[admin] kit\join-machine.ps1 -Admin   (re-registers sshd)' }
else {
  if ($svc.Status -eq 'Running') { Pass 'sshd running' } else { Fail "sshd is $($svc.Status)" '[admin] Start-Service sshd' }
  if ($svc.StartType -eq 'Automatic') { Pass 'sshd starts automatically' } else { Fail "sshd start type $($svc.StartType)" '[admin] Set-Service sshd -StartupType Automatic' }
}
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$ssh = @($fw.Rules | Where-Object { $_.Direction -eq 1 -and $_.Action -eq 1 -and $_.Enabled -and ($_.Protocol -eq 6 -or $_.Protocol -eq 256) -and (($_.LocalPorts -split ',') -contains '22' -or $_.LocalPorts -eq '*') -and (-not $_.ApplicationName -or $_.ApplicationName -like '*sshd.exe') })  # program rules for other apps do not open sshd
$tailnetOnly = { param($r) $r.RemoteAddresses -eq '100.64.0.0/255.192.0.0' }
if ($ssh.Count -eq 1 -and (& $tailnetOnly $ssh[0])) { Pass "one inbound SSH rule, tailnet only ('$($ssh[0].Name)')" }
else {
  $list = ($ssh | ForEach-Object { "'$($_.Name)' from $($_.RemoteAddresses)" }) -join '; '
  Fail "inbound rules allowing TCP 22: $($ssh.Count) ($list); any enabled allow rule opens the port" '[admin] kit\join-machine.ps1 -Admin   (keeps only "SSH via Tailscale only", 100.64.0.0/10)'
}
$shell = (Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
if ($shell -and (Test-Path $shell) -and $shell -like '*bash.exe') { Pass "DefaultShell = $shell" } else { Fail "DefaultShell is '$shell'" "[admin] New-ItemProperty HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value '$GitBash' -PropertyType String -Force" }

'== desk-node'
$tasks = @(Get-ScheduledTask -TaskName 'desk-node-logon', 'desk-node-boot' -ErrorAction SilentlyContinue)
$enabled = @($tasks | Where-Object State -ne 'Disabled')
if ($enabled.Count -eq 1) { Pass "scheduled task $($enabled[0].TaskName) ($($enabled[0].State))" } else { Fail "enabled desk-node tasks: $($enabled.Count)" "powershell -File $Root\current\deploy\register-task.ps1 -Mode Logon   (or -Mode Boot for a server; disable the other)" }
$current = Join-Path $Root 'current'
# Read through the junction's target: in an ssh session the junction itself can show an empty directory.
$target = @((Get-Item $current -ErrorAction SilentlyContinue).Target)[0]
if (-not $target) { $target = $current }
$installed = if (Test-Path "$target\VERSION") { (Get-Content "$target\VERSION" -Raw).Trim() } else { $null }
$config = try { Get-Content "$Root\data\config.json" -Raw | ConvertFrom-Json } catch { $null }
$port = if ($config.port) { $config.port } else { 7801 }
$health = $null
try {
  $token = (Get-Content "$Root\data\token" -Raw -ErrorAction Stop).Trim()
  $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
  Remove-Variable token
} catch { }
if ($health) {
  if ($health.version -eq $installed) { Pass "desk-node $($health.version) answering on 127.0.0.1:$port (current -> $installed)" }
  else { Fail "desk-node answers $($health.version) but current -> $installed" "powershell -File $current\deploy\service.ps1 restart" }
} else { Fail "desk-node not answering on 127.0.0.1:$port" "powershell -File $current\deploy\service.ps1 start; then see $Root\logs\desk-node.log" }
$acl = (Get-Acl "$Root\data" -ErrorAction SilentlyContinue).Access
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name  # not $env:USERDOMAIN: it differs in ssh sessions
$others = @($acl | Where-Object { $_.IdentityReference -ne $me })
if ($acl -and $others.Count -eq 0) { Pass 'data dir (token) accessible to this user only' } else { Fail "data dir also accessible to: $(($others.IdentityReference | Select-Object -Unique) -join ', ')" "icacls $Root\data /inheritance:r /grant:r `"$me`:(OI)(CI)F`"" }

'== tailscale'
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$st = try { & $ts status --json | Out-String | ConvertFrom-Json } catch { $null }
if ($st -and $st.BackendState -eq 'Running') { Pass "tailscale running as $($st.Self.DNSName.TrimEnd('.'))" } else { Fail 'tailscale not running' 'start Tailscale and log in' }
$serve = try { (& $ts serve status 2>&1 | Out-String) } catch { '' }
if ($serve -match ":$port" -and $serve -match "127\.0\.0\.1:$port" -and $serve -notmatch 'Funnel on') { Pass "tailscale serve publishes $port to the tailnet only" }
else { Fail "tailscale serve does not publish 127.0.0.1:$port" "& '$ts' serve --bg --http=$port http://127.0.0.1:$port" }

''
if ($script:fails -eq 0) { 'all checks passed'; exit 0 } else { "$($script:fails) check(s) failed"; exit 1 }
