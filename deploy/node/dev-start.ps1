# Phase 1 only: (re)start desk-node from a dev release as a plain user process.
# It is created through WMI so it outlives the SSH session that launched it.
# No service is registered; phase 3 replaces this with install.ps1 and the upgrader.
param([Parameter(Mandatory = $true)][string]$Release)
$ErrorActionPreference = 'Stop'
$node = Join-Path $Release 'node\node.exe'
$main = Join-Path $Release 'app\src\main.mjs'

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*\desk-node\*\app\src\main.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped pid $($_.ProcessId)" }

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = "`"$node`" `"$main`""
  CurrentDirectory = $Release
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }
"started pid $($r.ProcessId)"
