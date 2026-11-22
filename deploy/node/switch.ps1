# Point C:\desk-node\current (a directory junction) at releases\<version>. Prints the previous target.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Root = 'C:\desk-node'
)
$ErrorActionPreference = 'Stop'
$current = Join-Path $Root 'current'
$target = Join-Path $Root "releases\$Version"
if (-not (Test-Path (Join-Path $target 'VERSION'))) { throw "release $Version is not installed" }
$previous = if (Test-Path $current) { (Get-Item $current).Target } else { $null }
if (Test-Path $current) { cmd.exe /d /c rmdir "$current" | Out-Null }
cmd.exe /d /c mklink /J "$current" "$target" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "mklink failed for $target" }
"current -> releases\$Version (was $previous)"
