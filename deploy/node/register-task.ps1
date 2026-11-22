# Register desk-node as a scheduled task running as the current user (not elevated).
#   -Mode Logon : "run only when user is logged on", starts at logon. No admin rights needed.
#   -Mode Boot  : "run whether user is logged on or not" with the saved password, starts at boot.
#                 Needs an elevated PowerShell; asks for the Windows password (stored by Task Scheduler).
# Both also repeat every 5 minutes; with MultipleInstances=IgnoreNew this only restarts a node that died.
# The node runs under `conhost --headless` so no console window appears on the desktop.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Logon', 'Boot')][string]$Mode,
  [string]$Root = 'C:\desk-node',
  [switch]$Disabled
)
$ErrorActionPreference = 'Stop'
$name = "desk-node-$($Mode.ToLower())"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$node = Join-Path $Root 'current\node\node.exe'
$main = Join-Path $Root 'current\app\src\main.mjs'

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless `"$node`" `"$main`"" -WorkingDirectory (Join-Path $Root 'current')
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)

if ($Mode -eq 'Logon') {
  $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $user), $watchdog)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $task = Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force
} else {
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), $watchdog)
  $cred = Get-Credential -UserName $user -Message "Windows password for $user (saved by Task Scheduler for $name)"
  $task = Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings `
    -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force
}
if ($Disabled) { Disable-ScheduledTask -TaskName $name | Out-Null }
"registered $name ($((Get-ScheduledTask -TaskName $name).State))"
