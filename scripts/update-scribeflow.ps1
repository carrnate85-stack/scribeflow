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
$runtimeRoot = Join-Path $settingsRoot "runtime"
$updateStatusPath = Join-Path $runtimeRoot "update-status.json"
$updateLogPath = Join-Path $runtimeRoot "update.log"
$script:targetVersion = $null

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

function Remove-ScribeFlowUpdateDirectory {
    param([string]$Path)

    Assert-SafeUpdatePath -Path $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $lastError = ""
    for ($attempt = 1; $attempt -le 5; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $Path)) {
                return
            }
            throw "The temporary update directory still exists."
        }
        catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 5) {
                Start-Sleep -Milliseconds (250 * $attempt)
            }
        }
    }
    throw "The temporary update directory could not be cleared: $lastError"
}

function Write-ScribeFlowUpdateLog {
    param([string]$Message)

    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    if (
        (Test-Path -LiteralPath $updateLogPath) -and
        (Get-Item -LiteralPath $updateLogPath).Length -gt 1MB
    ) {
        Move-Item -LiteralPath $updateLogPath `
            -Destination "$updateLogPath.previous" -Force
    }
    Add-Content -LiteralPath $updateLogPath -Value (
        "[{0}] {1}" -f (Get-Date).ToString("o"), $Message
    ) -Encoding UTF8
}

function Set-ScribeFlowUpdateStatus {
    param(
        [string]$Stage,
        [string]$Message,
        [string]$Version = ""
    )

    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $temporaryPath = "$updateStatusPath.new"
    [ordered]@{
        stage = $Stage
        version = $Version
        message = $Message
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        logPath = $updateLogPath
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $updateStatusPath -Force
    Write-ScribeFlowUpdateLog -Message "$Stage`: $Message"
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

function Invoke-ScribeFlowUpdate {
Set-ScribeFlowUpdateStatus -Stage "checking" `
    -Message "Checking GitHub for a ScribeFlow update."

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
    Set-ScribeFlowUpdateStatus -Stage "offline" `
        -Message "GitHub was unavailable; ScribeFlow opened normally."
    return
}

$latestVersion = ConvertTo-ScribeFlowVersion -Value ([string]$release.tag_name)
if (-not $Force -and $latestVersion -le $currentVersion) {
    Write-Host "ScribeFlow is up to date ($currentVersion)." `
        -ForegroundColor DarkGray
    Set-ScribeFlowUpdateStatus -Stage "current" `
        -Version ([string]$currentVersion) `
        -Message "ScribeFlow is up to date."
    return
}
$script:targetVersion = [string]$latestVersion

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
Set-ScribeFlowUpdateStatus -Stage "available" `
    -Version ([string]$latestVersion) `
    -Message "ScribeFlow $latestVersion is available."
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
Remove-ScribeFlowUpdateDirectory -Path $releaseRoot
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

Write-Host "Downloading the verified ScribeFlow update..." -ForegroundColor Cyan
Set-ScribeFlowUpdateStatus -Stage "downloading" `
    -Version ([string]$latestVersion) `
    -Message "Downloading ScribeFlow $latestVersion."
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
Set-ScribeFlowUpdateStatus -Stage "verified" `
    -Version ([string]$latestVersion) `
    -Message "The downloaded update passed checksum verification."

Expand-Archive `
    -LiteralPath $archivePath `
    -DestinationPath $packageRoot `
    -Force
$installer = Join-Path $packageRoot "Install-ScribeFlow.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "The downloaded ScribeFlow installer is incomplete."
}

Set-Location -LiteralPath $env:TEMP
$installed = $false
$lastInstallerError = ""
for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    Set-ScribeFlowUpdateStatus -Stage "installing" `
        -Version ([string]$latestVersion) `
        -Message "Installing ScribeFlow $latestVersion (attempt $attempt of 3)."
    try {
        & powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $installer `
            -NoLaunch
        if ($LASTEXITCODE -ne 0) {
            throw "Installer exited with code $LASTEXITCODE."
        }
        $installedVersionFile = Join-Path `
            $env:LOCALAPPDATA "Programs\ScribeFlow\app-version.json"
        $installedVersion = [string](
            (Get-Content -LiteralPath $installedVersionFile -Raw |
                ConvertFrom-Json).version
        )
        if (
            (ConvertTo-ScribeFlowVersion -Value $installedVersion) -ne
            $latestVersion
        ) {
            throw "Installed version verification failed."
        }
        $installed = $true
        break
    }
    catch {
        $lastInstallerError = $_.Exception.Message
        Write-ScribeFlowUpdateLog -Message (
            "Installer attempt $attempt failed: $lastInstallerError"
        )
        if ($attempt -lt 3) {
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
        }
    }
}
if (-not $installed) {
    throw "The ScribeFlow update could not be applied."
}

Write-Host "ScribeFlow updated to $latestVersion." -ForegroundColor Green
Set-ScribeFlowUpdateStatus -Stage "installed" `
    -Version ([string]$latestVersion) `
    -Message "ScribeFlow $latestVersion was installed successfully."
}

$updateMutex = [Threading.Mutex]::new($false, "Local\ScribeFlowUpdater")
$ownsUpdateMutex = $false
try {
    try {
        $ownsUpdateMutex = $updateMutex.WaitOne([TimeSpan]::FromMinutes(3))
    }
    catch [Threading.AbandonedMutexException] {
        $ownsUpdateMutex = $true
    }
    if (-not $ownsUpdateMutex) {
        Write-Host "Another ScribeFlow update is already running." `
            -ForegroundColor DarkGray
        Set-ScribeFlowUpdateStatus -Stage "busy" `
            -Message "Another ScribeFlow update is already running."
        return
    }

    Invoke-ScribeFlowUpdate
}
catch {
    $failedVersion = if ($script:targetVersion) {
        $script:targetVersion
    } else {
        ""
    }
    Set-ScribeFlowUpdateStatus -Stage "failed" `
        -Version $failedVersion `
        -Message "Update failed after automatic retries: $($_.Exception.Message)"
    throw
}
finally {
    if ($ownsUpdateMutex) {
        $updateMutex.ReleaseMutex()
    }
    $updateMutex.Dispose()
}
