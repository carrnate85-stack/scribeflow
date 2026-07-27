[CmdletBinding()]
param(
    [switch]$NoUpdate
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$installedRoot = Join-Path $env:LOCALAPPDATA "Programs\ScribeFlow"
$updateScript = Join-Path $PSScriptRoot "update-scribeflow.ps1"

# Keeping the working directory outside the installation lets the updater
# atomically replace the installed application folder on Windows.
Set-Location -LiteralPath $env:TEMP

if (-not $NoUpdate -and (Test-Path -LiteralPath $updateScript)) {
    try {
        & $updateScript
    }
    catch {
        Write-Warning "ScribeFlow update check was skipped: $($_.Exception.Message)"
    }
}

$launchCandidates = @(
    (Join-Path $installedRoot "scripts\launch-scribeflow.ps1"),
    (Join-Path $projectRoot "scripts\launch-scribeflow.ps1")
)
$launchScript = $launchCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1

if (-not $launchScript) {
    throw "The ScribeFlow application launcher is missing."
}

& powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $launchScript
exit $LASTEXITCODE
