# Install a desk-node release package into C:\desk-node\releases\<version>.
# With -Activate (or when there is no current yet) the current junction is pointed at it.
#   install.ps1 -Package C:\desk-node\incoming\desk-node-0.5.4.tar.gz [-Activate]
#
# First install on a new machine (docs/runbooks/add-machine.md): also -Profile and -MachineName.
#   install.ps1 -Package <tar.gz> -Profile daily|server -MachineName <name> [-DefaultDir D:\git]
#               [-DenyPaths D:\private,E:\hr] [-Port 7801] [-NoService]
# That creates data\config.json and data\token (generated here, current user only, never shown),
# registers the scheduled task (daily: at logon; server: at boot, needs an elevated PowerShell and
# the Windows password), starts desk-node, publishes the port to the tailnet with tailscale serve,
# and prints the kit/new-machine.sh finish command for the VPS. -NoService stops after config and
# token (for tests). Usually run through kit/join-machine.ps1.
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [switch]$Activate,
  [string]$Root = 'C:\desk-node',
  [ValidateSet('daily', 'server')][string]$Profile,
  [string]$MachineName,
  [string]$DefaultDir = 'D:\git',
  [string[]]$DenyPaths = @(),
  [int]$Port = 7801,
  [switch]$NoService
)
$ErrorActionPreference = 'Stop'
# powershell -File passes "-DenyPaths a,b" as one string: split it here.
$DenyPaths = @($DenyPaths | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ([bool]$Profile -ne [bool]$MachineName) { throw '-Profile and -MachineName go together' }
if ($MachineName -and $MachineName -notmatch '^[a-z][a-z0-9-]{1,30}$') { throw "machine name must be lowercase letters, digits and '-': $MachineName" }

$releases = Join-Path $Root 'releases'
$current = Join-Path $Root 'current'
New-Item -ItemType Directory -Force $releases | Out-Null

$staging = Join-Path $Root ('incoming\x-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $staging | Out-Null
try {
  & "$env:SystemRoot\System32\tar.exe" -xzf $Package -C $staging
  if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE) for $Package" }
  $dir = Get-ChildItem $staging -Directory | Select-Object -First 1
  $version = (Get-Content (Join-Path $dir.FullName 'VERSION') -Raw).Trim()
  $target = Join-Path $releases $version
  if (Test-Path $target) { "release $version already installed" }
  else {
    # An app-only package has no node\ and bin\: link them from an installed release with the same RUNTIME.
    if (-not (Test-Path (Join-Path $dir.FullName 'node\node.exe'))) {
      $runtimeFile = Join-Path $dir.FullName 'RUNTIME'
      if (-not (Test-Path $runtimeFile)) { throw "package $version has no node\ and no RUNTIME file: upload the full package" }
      $runtime = (Get-Content $runtimeFile -Raw).Trim()
      $donor = Get-ChildItem $releases -Directory | Sort-Object LastWriteTime -Descending | Where-Object {
        (Test-Path (Join-Path $_.FullName 'node\node.exe')) -and (Test-Path (Join-Path $_.FullName 'RUNTIME')) -and ((Get-Content (Join-Path $_.FullName 'RUNTIME') -Raw).Trim() -eq $runtime) } | Select-Object -First 1
      if (-not $donor) { throw "runtime '$runtime' is not installed here: upload the full package desk-node-$version.tar.gz" }
      foreach ($sub in 'node', 'bin') {
        foreach ($f in Get-ChildItem (Join-Path $donor.FullName $sub) -Recurse -File) {
          $rel = $f.FullName.Substring($donor.FullName.Length + 1)
          $dest = Join-Path $dir.FullName $rel
          New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
          try { New-Item -ItemType HardLink -Path $dest -Target $f.FullName -ErrorAction Stop | Out-Null } catch { Copy-Item $f.FullName $dest }
        }
      }
      "runtime $runtime taken from release $($donor.Name)"
    }
    Move-Item $dir.FullName $target; "installed release $version"
  }
} finally {
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}

if ($Activate -or -not (Test-Path $current)) {
  & (Join-Path $PSScriptRoot 'switch.ps1') -Version $version -Root $Root
}
if (-not $MachineName) { return }

# --- data\config.json and data\token (current user only) ---
$data = Join-Path $Root 'data'
$configFile = Join-Path $data 'config.json'
$tokenFile = Join-Path $data 'token'
New-Item -ItemType Directory -Force $data | Out-Null
$me = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $data /inheritance:r /grant:r "${me}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed for $data" }

$slash = { param($p) $p.Replace('\', '/') }
if (Test-Path $configFile) {
  $config = Get-Content $configFile -Raw | ConvertFrom-Json
  if ($config.machineId -ne $MachineName) { throw "$configFile belongs to machine '$($config.machineId)', not '$MachineName'" }
  "kept existing $configFile"
} else {
  $config = [ordered]@{ machineId = $MachineName; port = $Port; defaultDir = (& $slash $DefaultDir); denyPaths = @($DenyPaths | ForEach-Object { & $slash $_ }) }
  [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json) + "`n", (New-Object Text.UTF8Encoding $false))
  "wrote $configFile"
  $config = Get-Content $configFile -Raw | ConvertFrom-Json
}
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  [IO.File]::WriteAllText($tokenFile, $token, [Text.Encoding]::ASCII)
  Remove-Variable token
  "generated $tokenFile (not shown)"
} else { "kept existing $tokenFile" }

# --- service ---
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not $NoService) {
  $mode = if ($Profile -eq 'server') { 'Boot' } else { 'Logon' }
  & (Join-Path $PSScriptRoot 'register-task.ps1') -Mode $mode -Root $Root
  & (Join-Path $PSScriptRoot 'service.ps1') start
  $health = $null
  for ($i = 0; $i -lt 20 -and -not $health; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -Headers @{ Authorization = 'Bearer ' + (Get-Content $tokenFile -Raw).Trim() } -TimeoutSec 2
    } catch { }
  }
  if (-not $health) { throw "desk-node did not answer on 127.0.0.1:$($config.port); see $Root\logs\desk-node.log" }
  "desk-node $($health.version) is up as $($health.machineId)"
  & $tailscale serve --bg --http=$($config.port) "http://127.0.0.1:$($config.port)" | Out-Null
  if ($LASTEXITCODE -ne 0) { "WARNING: tailscale serve failed; run: tailscale serve --bg --http=$($config.port) http://127.0.0.1:$($config.port)" }
}

# --- what to do on the VPS (kit/new-machine.sh does the rest) ---
$dns = $null
try { $dns = ((& $tailscale status --json | Out-String | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }
if (-not $dns) { $dns = '<this machine''s MagicDNS name>' }
$dir = $config.defaultDir
@"

================ 在 VPS 上完成接入 ================
desk-fleet/kit/new-machine.sh finish $MachineName --host $dns --user $env:USERNAME --port $($config.port) --dir '$dir' --root '$($Root.Replace('\', '/'))' --profile $Profile
（它会：写入主机公钥和 ssh 别名、确认带外通道、经 ssh 取回令牌、写入 machines.json、检查 Machines。）
"@
