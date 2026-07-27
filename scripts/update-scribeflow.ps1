[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRepository = "carrnate85-stack/scribeflow"
$releaseApi = "https://api.github.com/repos/$releaseRepository/releases/latest"
$assetName = "ScribeFlow-Windows-Online-Installer.zip"
$checksumAssetName = "$assetName.sha256"
$versionFile = Join-Path $projectRoot "app-version.json"
$settingsRoot = Join-Path $env:LOCALAPPDATA "ScribeFlow"
$updatesRoot = Join-Path $settingsRoot "updates"

function ConvertTo-ScribeFlowVersion {
    param([string]$Value)

    if (-not $Value) {
        return [version]"0.0.0"
    }
    return [version](($Value.Trim()) -replace "^[vV]", "")
}

function Assert-SafeUpdatePath {
    param([string]$Path)

    $resolvedUpdatesRoot = [IO.Path]::GetFullPath($updatesRoot)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (
        -not $resolvedPath.StartsWith(
            "$resolvedUpdatesRoot$([IO.Path]::DirectorySeparatorChar)",
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "The updater refused an unsafe working path."
    }
}

function Invoke-ScribeFlowDownload {
    param(
        [string]$Url,
        [string]$Destination,
        [switch]$Resume
    )

    $arguments = @(
        "--location",
        "--fail",
        "--retry", "4",
        "--retry-delay", "2",
        "--connect-timeout", "8",
        "--output", $Destination
    )
    if ($Resume) {
        $arguments += @("--continue-at", "-")
    }
    $arguments += $Url

    & curl.exe @arguments
    return ($LASTEXITCODE -eq 0)
}

$currentVersion = [version]"0.0.0"
if (Test-Path -LiteralPath $versionFile) {
    try {
        $versionPayload = Get-Content -LiteralPath $versionFile -Raw |
            ConvertFrom-Json
        $currentVersion = ConvertTo-ScribeFlowVersion `
            -Value ([string]$versionPayload.version)
    }
    catch {
        Write-Warning "The installed version file could not be read."
    }
}

try {
    $release = Invoke-RestMethod `
        -Uri $releaseApi `
        -Headers @{
            "Accept" = "application/vnd.github+json"
            "User-Agent" = "ScribeFlow-Updater"
        } `
        -TimeoutSec 8
}
catch {
    Write-Host "ScribeFlow update check skipped; GitHub is unavailable." `
        -ForegroundColor DarkGray
    return
}

$latestVersion = ConvertTo-ScribeFlowVersion -Value ([string]$release.tag_name)
if (-not $Force -and $latestVersion -le $currentVersion) {
    Write-Host "ScribeFlow is up to date ($currentVersion)." `
        -ForegroundColor DarkGray
    return
}

$archiveAsset = $release.assets |
    Where-Object { $_.name -eq $assetName } |
    Select-Object -First 1
$checksumAsset = $release.assets |
    Where-Object { $_.name -eq $checksumAssetName } |
    Select-Object -First 1
if (-not $archiveAsset -or -not $checksumAsset) {
    throw "The latest ScribeFlow release is missing its installer or checksum."
}

Write-Host "ScribeFlow $latestVersion is available." -ForegroundColor Cyan
if ($CheckOnly) {
    return
}

$releaseLeaf = ([string]$release.tag_name) -replace "[^A-Za-z0-9._-]", "_"
$releaseRoot = Join-Path $updatesRoot $releaseLeaf
$archiveDownload = Join-Path $releaseRoot "$assetName.download"
$archivePath = Join-Path $releaseRoot $assetName
$checksumPath = Join-Path $releaseRoot $checksumAssetName
$packageRoot = Join-Path $releaseRoot "package"

Assert-SafeUpdatePath -Path $releaseRoot
New-Item -ItemType Directory -Path $updatesRoot -Force | Out-Null
if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

Write-Host "Downloading the verified ScribeFlow update..." -ForegroundColor Cyan
if (-not (Invoke-ScribeFlowDownload `
    -Url ([string]$checksumAsset.browser_download_url) `
    -Destination $checksumPath
)) {
    throw "The ScribeFlow checksum download failed."
}

$expectedSha256 = (
    (Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+"
)[0].ToUpperInvariant()
if ($expectedSha256 -notmatch "^[A-F0-9]{64}$") {
    throw "The ScribeFlow update checksum is invalid."
}

if (-not (Invoke-ScribeFlowDownload `
    -Url ([string]$archiveAsset.browser_download_url) `
    -Destination $archiveDownload `
    -Resume
)) {
    if (Test-Path -LiteralPath $archiveDownload) {
        Remove-Item -LiteralPath $archiveDownload -Force
    }
    if (-not (Invoke-ScribeFlowDownload `
        -Url ([string]$archiveAsset.browser_download_url) `
        -Destination $archiveDownload
    )) {
        throw "The ScribeFlow update download failed."
    }
}

$actualSha256 = (
    Get-FileHash -LiteralPath $archiveDownload -Algorithm SHA256
).Hash
if ($actualSha256 -ne $expectedSha256) {
    Remove-Item -LiteralPath $archiveDownload -Force
    throw "The ScribeFlow update checksum did not match."
}
Move-Item -LiteralPath $archiveDownload -Destination $archivePath -Force

Expand-Archive `
    -LiteralPath $archivePath `
    -DestinationPath $packageRoot `
    -Force
$installer = Join-Path $packageRoot "Install-ScribeFlow.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "The downloaded ScribeFlow installer is incomplete."
}

Set-Location -LiteralPath $env:TEMP
& powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $installer `
    -NoLaunch
if ($LASTEXITCODE -ne 0) {
    throw "The ScribeFlow update could not be applied."
}

Write-Host "ScribeFlow updated to $latestVersion." -ForegroundColor Green
