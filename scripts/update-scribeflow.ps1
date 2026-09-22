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
$lifecycleScript = Join-Path $PSScriptRoot "scribeflow-lifecycle.ps1"
$script:targetVersion = ""
$script:lastInstallerExitCode = $null

if (-not (Test-Path -LiteralPath $lifecycleScript -PathType Leaf)) {
    throw "The ScribeFlow update helper is missing."
}
. $lifecycleScript

function ConvertTo-ScribeFlowVersion {
    param([string]$Value)

    $normalized = ([string]$Value).Trim() -replace "^[vV]", ""
    if ($normalized -notmatch "^\d+\.\d+\.\d+$") {
        throw "GitHub returned an invalid ScribeFlow release version."
    }
    return [version]$normalized
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

function Write-ScribeFlowUpdateLog {
    param([string]$Message)

    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    if (
        (Test-Path -LiteralPath $updateLogPath) -and
        (Get-Item -LiteralPath $updateLogPath).Length -gt 2MB
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
        schemaVersion = 2
        stage = $Stage
        version = $Version
        message = $Message
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        logPath = $updateLogPath
        installerExitCode = $script:lastInstallerExitCode
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
        [int64]$ExpectedBytes = 0,
        [int]$MaximumSeconds = 1800,
        [switch]$Resume
    )

    if (
        $ExpectedBytes -gt 0 -and
        (Test-Path -LiteralPath $Destination -PathType Leaf) -and
        (Get-Item -LiteralPath $Destination).Length -gt $ExpectedBytes
    ) {
        Remove-Item -LiteralPath $Destination -Force
    }
    $arguments = @(
        "--location",
        "--fail",
        "--retry", "5",
        "--retry-all-errors",
        "--retry-delay", "2",
        "--connect-timeout", "10",
        "--max-time", "$MaximumSeconds",
        "--speed-time", "30",
        "--speed-limit", "1024",
        "--output", $Destination
    )
    if ($Resume -and (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        $arguments += @("--continue-at", "-")
    }
    $arguments += $Url
    & curl.exe @arguments
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    if (
        $ExpectedBytes -gt 0 -and
        (Get-Item -LiteralPath $Destination).Length -ne $ExpectedBytes
    ) {
        return $false
    }
    return $true
}

function Add-InstallerOutputToLog {
    param(
        [string]$Path,
        [string]$Stream,
        [int]$Attempt
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
        Write-ScribeFlowUpdateLog "installer attempt $Attempt $Stream> $line"
    }
}

function Remove-ScribeFlowUpdateDirectory {
    param([string]$Path)

    Assert-SafeUpdatePath -Path $Path
    Remove-ScribeFlowPathWithRetry -Path $Path
}

function Prune-ScribeFlowUpdateCache {
    param([string]$KeepPath = "")

    if (-not (Test-Path -LiteralPath $updatesRoot -PathType Container)) {
        return
    }
    $resolvedKeepPath = if ($KeepPath) {
        [IO.Path]::GetFullPath($KeepPath)
    } else {
        ""
    }
    foreach ($directory in Get-ChildItem -LiteralPath $updatesRoot -Directory) {
        if (
            -not $resolvedKeepPath -or
            -not $directory.FullName.Equals(
            $resolvedKeepPath,
            [StringComparison]::OrdinalIgnoreCase
            )
        ) {
            try {
                Remove-ScribeFlowUpdateDirectory -Path $directory.FullName
                Write-ScribeFlowUpdateLog "Removed old update cache $($directory.Name)."
            }
            catch {
                Write-ScribeFlowUpdateLog "Old update cache cleanup failed for $($directory.Name): $($_.Exception.Message)"
            }
        }
    }
}

function Get-ScribeFlowVerifiedCachePath {
    param([string]$Version)

    $candidateRoot = Join-Path $updatesRoot "v$Version"
    Assert-SafeUpdatePath -Path $candidateRoot
    $installedMarker = Join-Path $candidateRoot "installed.json"
    $archive = Join-Path $candidateRoot $assetName
    $checksum = Join-Path $candidateRoot $checksumAssetName
    if (
        -not (Test-Path -LiteralPath $installedMarker -PathType Leaf) -or
        -not (Test-Path -LiteralPath $archive -PathType Leaf) -or
        -not (Test-Path -LiteralPath $checksum -PathType Leaf)
    ) {
        return ""
    }
    try {
        $marker = Get-Content -LiteralPath $installedMarker -Raw |
            ConvertFrom-Json
        $expectedHash = (
            (Get-Content -LiteralPath $checksum -Raw).Trim() -split "\s+"
        )[0].ToUpperInvariant()
        if (
            [string]$marker.version -ne $Version -or
            $expectedHash -notmatch "^[A-F0-9]{64}$" -or
            ([string]$marker.archiveSha256).ToUpperInvariant() -ne
                $expectedHash -or
            (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne
                $expectedHash
        ) {
            return ""
        }
        return $candidateRoot
    }
    catch {
        return ""
    }
}

function Invoke-ScribeFlowInstaller {
    param(
        [string]$Installer,
        [string]$ReleaseRoot,
        [int]$Attempt
    )

    $stdoutPath = Join-Path $ReleaseRoot "installer-$Attempt.stdout.log"
    $stderrPath = Join-Path $ReleaseRoot "installer-$Attempt.stderr.log"
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    $process = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "`"$Installer`"",
            "-NoLaunch"
        ) `
        -WorkingDirectory $env:TEMP `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -Wait `
        -PassThru
    $script:lastInstallerExitCode = $process.ExitCode
    Add-InstallerOutputToLog -Path $stdoutPath -Stream "stdout" -Attempt $Attempt
    Add-InstallerOutputToLog -Path $stderrPath -Stream "stderr" -Attempt $Attempt
    return $process.ExitCode
}

function Invoke-ScribeFlowUpdate {
    Set-ScribeFlowUpdateStatus -Stage "checking" `
        -Message "Checking GitHub for a ScribeFlow update."

    $currentVersion = [version]"0.0.0"
    if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
        try {
            $currentVersion = ConvertTo-ScribeFlowVersion -Value ([string](
                (Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json).version
            ))
        }
        catch {
            Write-ScribeFlowUpdateLog "The installed version marker is damaged; a verified reinstall will be allowed."
        }
    }

    try {
        $release = Invoke-RestMethod `
            -Uri $releaseApi `
            -Headers @{
                "Accept" = "application/vnd.github+json"
                "User-Agent" = "ScribeFlow-Updater"
                "X-GitHub-Api-Version" = "2022-11-28"
            } `
            -TimeoutSec 15
    }
    catch {
        Write-Host "ScribeFlow update check skipped; GitHub is unavailable." `
            -ForegroundColor DarkGray
        Set-ScribeFlowUpdateStatus -Stage "offline" `
            -Message "GitHub was unavailable; ScribeFlow opened normally."
        return
    }

    if ($release.draft -eq $true -or $release.prerelease -eq $true) {
        throw "GitHub returned a draft or prerelease instead of the stable ScribeFlow release."
    }
    $releaseTag = [string]$release.tag_name
    $latestVersion = ConvertTo-ScribeFlowVersion -Value $releaseTag
    $latestVersionText = [string]$latestVersion
    if (-not $Force -and $latestVersion -le $currentVersion) {
        if (-not $CheckOnly) {
            $verifiedCache = Get-ScribeFlowVerifiedCachePath `
                -Version ([string]$currentVersion)
            Prune-ScribeFlowUpdateCache -KeepPath $verifiedCache
            if ($verifiedCache) {
                Write-ScribeFlowUpdateLog `
                    "Retained one verified current update archive and removed all older cached versions."
            } else {
                Write-ScribeFlowUpdateLog `
                    "Removed stale update caches; no verified current repair archive was present."
            }
        }
        Write-Host "ScribeFlow is up to date ($currentVersion)." -ForegroundColor DarkGray
        Set-ScribeFlowUpdateStatus -Stage "current" `
            -Version ([string]$currentVersion) `
            -Message "ScribeFlow is up to date."
        return
    }
    $script:targetVersion = $latestVersionText

    $archiveAsset = $release.assets |
        Where-Object { $_.name -eq $assetName } |
        Select-Object -First 1
    $checksumAsset = $release.assets |
        Where-Object { $_.name -eq $checksumAssetName } |
        Select-Object -First 1
    if (-not $archiveAsset -or -not $checksumAsset) {
        throw "The latest ScribeFlow release is missing its installer or checksum."
    }
    $archiveBytes = [int64]$archiveAsset.size
    if ($archiveBytes -lt 1MB -or $archiveBytes -gt 1GB) {
        throw "The GitHub installer asset reported an unexpected size."
    }

    Write-Host "ScribeFlow $latestVersion is available." -ForegroundColor Cyan
    Set-ScribeFlowUpdateStatus -Stage "available" `
        -Version $latestVersionText `
        -Message "ScribeFlow $latestVersion is available."
    if ($CheckOnly) {
        return
    }

    $releaseLeaf = "v$latestVersionText"
    $releaseRoot = Join-Path $updatesRoot $releaseLeaf
    $archiveDownload = Join-Path $releaseRoot "$assetName.download"
    $archivePath = Join-Path $releaseRoot $assetName
    $checksumPath = Join-Path $releaseRoot $checksumAssetName
    $packageStaging = Join-Path $releaseRoot "package.new"
    $packageRoot = Join-Path $releaseRoot "package"
    Assert-SafeUpdatePath -Path $releaseRoot
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

    Write-Host "Downloading the verified ScribeFlow update..." -ForegroundColor Cyan
    Set-ScribeFlowUpdateStatus -Stage "downloading" `
        -Version $latestVersionText `
        -Message "Downloading ScribeFlow $latestVersion."
    if (-not (Invoke-ScribeFlowDownload `
        -Url ([string]$checksumAsset.browser_download_url) `
        -Destination $checksumPath `
        -ExpectedBytes ([int64]$checksumAsset.size) `
        -MaximumSeconds 120
    )) {
        throw "The ScribeFlow checksum download failed."
    }
    $checksumParts = (Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+"
    $expectedSha256 = $checksumParts[0].ToUpperInvariant()
    if (
        $expectedSha256 -notmatch "^[A-F0-9]{64}$" -or
        ($checksumParts.Count -gt 1 -and [IO.Path]::GetFileName($checksumParts[-1]) -ne $assetName)
    ) {
        throw "The ScribeFlow update checksum is invalid."
    }

    $archiveReady = $false
    if (
        (Test-Path -LiteralPath $archivePath -PathType Leaf) -and
        (Get-Item -LiteralPath $archivePath).Length -eq $archiveBytes -and
        (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -eq $expectedSha256
    ) {
        $archiveReady = $true
    }
    if (-not $archiveReady) {
        if (-not (Invoke-ScribeFlowDownload `
            -Url ([string]$archiveAsset.browser_download_url) `
            -Destination $archiveDownload `
            -ExpectedBytes $archiveBytes `
            -Resume
        )) {
            Remove-Item -LiteralPath $archiveDownload -Force -ErrorAction SilentlyContinue
            if (-not (Invoke-ScribeFlowDownload `
                -Url ([string]$archiveAsset.browser_download_url) `
                -Destination $archiveDownload `
                -ExpectedBytes $archiveBytes
            )) {
                throw "The ScribeFlow update download failed after automatic retries."
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
    }

    foreach ($path in @($packageStaging, $packageRoot)) {
        if (Test-Path -LiteralPath $path) {
            Remove-ScribeFlowUpdateDirectory -Path $path
        }
    }
    New-Item -ItemType Directory -Path $packageStaging -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $packageStaging -Force
    $manifest = Test-ScribeFlowPayloadManifest `
        -PackageRoot $packageStaging `
        -ExpectedVersion $latestVersionText
    if ([string]$manifest.version -ne $latestVersionText) {
        throw "The extracted payload version did not match the GitHub release tag."
    }
    $installer = Join-Path $packageStaging "Install-ScribeFlow.ps1"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "The downloaded ScribeFlow installer is incomplete."
    }
    Move-Item -LiteralPath $packageStaging -Destination $packageRoot
    $installer = Join-Path $packageRoot "Install-ScribeFlow.ps1"
    Set-ScribeFlowUpdateStatus -Stage "verified" `
        -Version $latestVersionText `
        -Message "The release tag, archive, manifest, and every payload file were verified."

    $installed = $false
    $lastInstallerError = ""
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        Set-ScribeFlowUpdateStatus -Stage "installing" `
            -Version $latestVersionText `
            -Message "Installing ScribeFlow $latestVersion (attempt $attempt of 3)."
        try {
            $exitCode = Invoke-ScribeFlowInstaller `
                -Installer $installer `
                -ReleaseRoot $releaseRoot `
                -Attempt $attempt
            if ($exitCode -ne 0) {
                throw "Installer exited with code $exitCode."
            }
            $installedVersionFile = Join-Path $env:LOCALAPPDATA `
                "Programs\ScribeFlow\app-version.json"
            $installedVersion = ConvertTo-ScribeFlowVersion -Value ([string](
                (Get-Content -LiteralPath $installedVersionFile -Raw |
                    ConvertFrom-Json).version
            ))
            if ($installedVersion -ne $latestVersion) {
                throw "Installed version verification failed."
            }
            $health = Invoke-RestMethod `
                -Uri "http://127.0.0.1:3000/__health" `
                -TimeoutSec 5
            if (
                $health.ready -ne $true -or
                [string]$health.version -ne $latestVersionText
            ) {
                throw "The installed app did not report the expected healthy version."
            }
            $installed = $true
            break
        }
        catch {
            $lastInstallerError = $_.Exception.Message
            Write-ScribeFlowUpdateLog "Installer attempt $attempt failed: $lastInstallerError"
            if ($attempt -lt 3) {
                Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
            }
        }
    }
    if (-not $installed) {
        throw "The ScribeFlow update could not be applied. $lastInstallerError"
    }

    # Keep exactly one verified archive as an offline repair/rollback source;
    # the installer separately retains the last-known-good installed folder.
    Remove-ScribeFlowUpdateDirectory -Path $packageRoot
    Get-ChildItem -LiteralPath $releaseRoot -File -Filter "installer-*.log" |
        Remove-Item -Force -ErrorAction SilentlyContinue
    [ordered]@{
        schemaVersion = 1
        version = $latestVersionText
        archiveSha256 = $expectedSha256
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $releaseRoot "installed.json") -Encoding UTF8
    Prune-ScribeFlowUpdateCache -KeepPath $releaseRoot

    Write-Host "ScribeFlow updated to $latestVersion." -ForegroundColor Green
    Set-ScribeFlowUpdateStatus -Stage "installed" `
        -Version $latestVersionText `
        -Message "ScribeFlow $latestVersion was installed, health-checked, and old update files were cleaned up."
}

$updateMutex = [Threading.Mutex]::new($false, "Local\ScribeFlowUpdater")
$ownsUpdateMutex = $false
try {
    try {
        $ownsUpdateMutex = $updateMutex.WaitOne([TimeSpan]::FromMinutes(5))
    }
    catch [Threading.AbandonedMutexException] {
        $ownsUpdateMutex = $true
    }
    if (-not $ownsUpdateMutex) {
        Write-Host "Another ScribeFlow update is already running." -ForegroundColor DarkGray
        Set-ScribeFlowUpdateStatus -Stage "busy" `
            -Message "Another ScribeFlow update is already running."
        return
    }
    Invoke-ScribeFlowUpdate
}
catch {
    Set-ScribeFlowUpdateStatus -Stage "failed" `
        -Version $script:targetVersion `
        -Message "Update failed after automatic retries: $($_.Exception.Message)"
    throw
}
finally {
    if ($ownsUpdateMutex) {
        $updateMutex.ReleaseMutex()
    }
    $updateMutex.Dispose()
}
