[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$localDataRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ScribeFlow"
} else {
    Join-Path $projectRoot ".scribeflow-data\ScribeFlow"
}
$releaseFile = Join-Path $PSScriptRoot "whisper-release.json"
if (-not (Test-Path -LiteralPath $releaseFile -PathType Leaf)) {
    throw "The bundled Whisper release manifest is missing."
}
$release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
$releaseVersion = [string]$release.releaseVersion
$displayName = [string]$release.displayName
$downloadSizeLabel = [string]$release.downloadSizeLabel
$runtimeSource = [string]$release.runtime.source
$runtimeVersion = [string]$release.runtime.version
$runtimeArchiveName = [string]$release.runtime.archiveName
$runtimeUrl = [string]$release.runtime.url
$runtimeSha256 = ([string]$release.runtime.sha256).ToUpperInvariant()
$modelId = [string]$release.model.id
$modelSource = [string]$release.model.source
$modelFileName = [string]$release.model.fileName
$modelUrl = [string]$release.model.url
$modelSha1 = ([string]$release.model.sha1).ToUpperInvariant()

if (
    $release.schemaVersion -ne 1 -or
    $releaseVersion -notmatch "^[A-Za-z0-9._-]+$" -or
    $runtimeVersion -notmatch "^v[A-Za-z0-9._-]+$" -or
    $runtimeArchiveName -notmatch "^[A-Za-z0-9._-]+\.zip$" -or
    $modelFileName -notmatch "^[A-Za-z0-9._-]+\.bin$" -or
    $runtimeSha256 -notmatch "^[A-F0-9]{64}$" -or
    $modelSha1 -notmatch "^[A-F0-9]{40}$" -or
    -not $runtimeUrl.StartsWith(
        "https://github.com/ggml-org/whisper.cpp/",
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not $modelUrl.StartsWith(
        "https://huggingface.co/ggerganov/whisper.cpp/",
        [StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "The bundled Whisper release manifest is invalid."
}

$nativeRoot = Join-Path $localDataRoot "native-whisper"
$runtimeRoot = Join-Path $nativeRoot "runtime-$runtimeVersion"
$runtimeArchive = Join-Path $nativeRoot $runtimeArchiveName
$serverCandidates = @(
    (Join-Path $runtimeRoot "Release\whisper-server.exe"),
    (Join-Path $runtimeRoot "$([IO.Path]::GetFileName($runtimeRoot))\Release\whisper-server.exe")
)
$modelRoot = Join-Path $nativeRoot "models"
$modelFile = Join-Path $modelRoot $modelFileName
$modelDownload = "$modelFile.download"
$previousManifestPath = Join-Path $nativeRoot "native-manifest.json"
$previousManifest = if (
    Test-Path -LiteralPath $previousManifestPath -PathType Leaf
) {
    try {
        Get-Content -LiteralPath $previousManifestPath -Raw | ConvertFrom-Json
    }
    catch {
        $null
    }
}

function Stop-InstalledWhisper {
    $resolvedNativeRoot = [IO.Path]::GetFullPath($nativeRoot)
    Get-Process -Name "whisper-server" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $processPath = [IO.Path]::GetFullPath($_.Path)
                $processPath.StartsWith(
                    "$resolvedNativeRoot$([IO.Path]::DirectorySeparatorChar)",
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
            catch {
                $false
            }
        } |
        ForEach-Object {
            Stop-Process -Id $_.Id -Force
            $_.WaitForExit(5000)
        }
}

New-Item -ItemType Directory -Path $nativeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
Stop-InstalledWhisper

$runtimeIsValid =
    (Test-Path -LiteralPath $runtimeArchive) -and
    ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -eq $runtimeSha256)
if (-not $runtimeIsValid) {
    if (Test-Path -LiteralPath $runtimeArchive) {
        Remove-Item -LiteralPath $runtimeArchive -Force
    }
    Write-Host "Downloading the official whisper.cpp CUDA runtime..." -ForegroundColor Cyan
    & curl.exe `
        --location `
        --fail `
        --retry 5 `
        --retry-delay 2 `
        --continue-at - `
        --output $runtimeArchive `
        $runtimeUrl
    if ($LASTEXITCODE -ne 0) {
        throw "The native Whisper CUDA runtime download failed."
    }
    if ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -ne $runtimeSha256) {
        throw "The native Whisper CUDA runtime checksum did not match."
    }
}

$serverExecutable = $serverCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $serverExecutable) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeRoot -Force
    $serverExecutable = $serverCandidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $serverExecutable) {
        throw "The Whisper runtime archive did not contain whisper-server.exe."
    }
}

$modelIsValid =
    (Test-Path -LiteralPath $modelFile) -and
    ((Get-FileHash -LiteralPath $modelFile -Algorithm SHA1).Hash -eq $modelSha1)
if (-not $modelIsValid) {
    if (Test-Path -LiteralPath $modelFile) {
        Remove-Item -LiteralPath $modelFile -Force
    }

    Write-Host "Downloading verified $displayName ($downloadSizeLabel)..." -ForegroundColor Cyan
    & curl.exe `
        --location `
        --fail `
        --retry 5 `
        --retry-delay 2 `
        --continue-at - `
        --output $modelDownload `
        $modelUrl
    if ($LASTEXITCODE -ne 0) {
        throw "The unquantized Large-v3 model download failed."
    }

    if ((Get-FileHash -LiteralPath $modelDownload -Algorithm SHA1).Hash -ne $modelSha1) {
        Remove-Item -LiteralPath $modelDownload -Force
        throw "The Large-v3 model checksum did not match."
    }
    Move-Item -LiteralPath $modelDownload -Destination $modelFile -Force
}

if ($previousManifest) {
    $previousModelFileName = [string]$previousManifest.modelFileName
    if (
        $previousModelFileName -match "^[A-Za-z0-9._-]+\.bin$" -and
        $previousModelFileName -ne $modelFileName
    ) {
        $previousModelFile = Join-Path $modelRoot $previousModelFileName
        if (Test-Path -LiteralPath $previousModelFile -PathType Leaf) {
            Remove-Item -LiteralPath $previousModelFile -Force
        }
    }

    $previousRuntimeVersion = [string]$previousManifest.runtimeVersion
    if (
        $previousRuntimeVersion -match "^v[A-Za-z0-9._-]+$" -and
        $previousRuntimeVersion -ne $runtimeVersion
    ) {
        $previousRuntimeLeaf = "runtime-$previousRuntimeVersion"
        $previousRuntimeRoot = Join-Path $nativeRoot $previousRuntimeLeaf
        $resolvedNativeRoot = [IO.Path]::GetFullPath($nativeRoot)
        $resolvedPreviousRuntime = [IO.Path]::GetFullPath(
            $previousRuntimeRoot
        )
        if (
            [IO.Path]::GetFileName($resolvedPreviousRuntime) -eq
                $previousRuntimeLeaf -and
            $resolvedPreviousRuntime.StartsWith(
                "$resolvedNativeRoot$([IO.Path]::DirectorySeparatorChar)",
                [StringComparison]::OrdinalIgnoreCase
            ) -and
            (Test-Path -LiteralPath $resolvedPreviousRuntime -PathType Container)
        ) {
            Remove-Item -LiteralPath $resolvedPreviousRuntime -Recurse -Force
        }
    }

    $previousArchiveName = [string]$previousManifest.runtimeArchiveName
    if (
        $previousArchiveName -match "^[A-Za-z0-9._-]+\.zip$" -and
        $previousArchiveName -ne $runtimeArchiveName
    ) {
        $previousArchive = Join-Path $nativeRoot $previousArchiveName
        if (Test-Path -LiteralPath $previousArchive -PathType Leaf) {
            Remove-Item -LiteralPath $previousArchive -Force
        }
    }
}

$manifest = [ordered]@{
    whisperReleaseVersion = $releaseVersion
    displayName = $displayName
    runtime = $runtimeSource
    runtimeVersion = $runtimeVersion
    runtimeArchiveName = $runtimeArchiveName
    runtimeSha256 = $runtimeSha256
    model = $modelId
    modelSource = $modelSource
    modelFileName = $modelFileName
    modelSha1 = $modelSha1
    unquantized = $true
    remoteModelsAllowed = $false
}
$manifest |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $nativeRoot "native-manifest.json") -Encoding UTF8

Write-Host "$displayName is installed. No audio was uploaded." -ForegroundColor Green
