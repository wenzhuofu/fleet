# Control desk-node through whichever desk-node-* scheduled task is enabled.
#   service.ps1 status|start|stop|restart
param([ValidateSet('status', 'start', 'stop', 'restart')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'

function Get-NodeProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*\desk-node\*\app\src\main.mjs*' }
}

$tasks = @(Get-ScheduledTask -TaskName 'desk-node-logon', 'desk-node-boot' -ErrorAction SilentlyContinue)
$active = @($tasks | Where-Object { $_.State -ne 'Disabled' })

if ($Action -eq 'status') {
  foreach ($t in $tasks) { "$($t.TaskName): $($t.State)" }
  foreach ($p in Get-NodeProcesses) { "node pid $($p.ProcessId): $($p.CommandLine)" }
  return
}
if ($active.Count -ne 1) { throw "expected exactly one enabled desk-node task, found: $(($active | ForEach-Object TaskName) -join ', ')" }
$task = $active[0]

if ($Action -in 'stop', 'restart') {
  # Kill only node.exe; conhost then exits and the task returns to Ready. Stop-ScheduledTask would
  # terminate the task's whole job, including BashJob processes, which must survive a restart.
  foreach ($p in Get-NodeProcesses) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; "stopped pid $($p.ProcessId)" }
  for ($i = 0; $i -lt 40 -and ((Get-NodeProcesses) -or (Get-ScheduledTask -TaskName $task.TaskName).State -eq 'Running'); $i++) { Start-Sleep -Milliseconds 250 }
}
if ($Action -in 'start', 'restart') {
  Start-ScheduledTask -TaskName $task.TaskName
  for ($i = 0; $i -lt 40 -and -not (Get-NodeProcesses); $i++) { Start-Sleep -Milliseconds 250 }
  $p = @(Get-NodeProcesses)
  if (-not $p) { throw "$($task.TaskName) started but no node process appeared" }
  "started $($task.TaskName), node pid $($p[0].ProcessId)"
}
