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
        Write-Warning "ScribeFlow could not finish updating after automatic retries: $($_.Exception.Message)"
        Write-Host "The current version will open. Update details are available in ScribeFlow's Shared library panel." `
            -ForegroundColor Yellow
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
