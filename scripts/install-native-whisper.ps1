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
$nativeRoot = Join-Path $localDataRoot "native-whisper"
$runtimeVersion = "v1.9.1"
$runtimeRoot = Join-Path $nativeRoot "runtime-$runtimeVersion"
$runtimeArchive = Join-Path $nativeRoot "whisper-cublas-12.4.0-bin-x64.zip"
$runtimeUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$runtimeVersion/whisper-cublas-12.4.0-bin-x64.zip"
$runtimeSha256 = "106A2030EFF8998E4EF320FE72E263A78449E9040386EE27C41EA80B001B601B"
$serverExecutable = Join-Path $runtimeRoot "Release\whisper-server.exe"
$modelRoot = Join-Path $nativeRoot "models"
$modelFile = Join-Path $modelRoot "ggml-large-v3.bin"
$modelDownload = "$modelFile.download"
$modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true"
$modelSha1 = "AD82BF6A9043CEED055076D0FD39F5F186FF8062"

New-Item -ItemType Directory -Path $nativeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null

$runtimeIsValid =
    (Test-Path -LiteralPath $runtimeArchive) -and
    ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -eq $runtimeSha256)
if (-not $runtimeIsValid) {
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

if (-not (Test-Path -LiteralPath $serverExecutable)) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeRoot -Force
}

$modelIsValid =
    (Test-Path -LiteralPath $modelFile) -and
    ((Get-FileHash -LiteralPath $modelFile -Algorithm SHA1).Hash -eq $modelSha1)
if (-not $modelIsValid) {
    if (Test-Path -LiteralPath $modelFile) {
        Remove-Item -LiteralPath $modelFile -Force
    }

    Write-Host "Downloading verified Whisper Large-v3 (about 3.1 GB)..." -ForegroundColor Cyan
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

$manifest = [ordered]@{
    runtime = "ggml-org/whisper.cpp"
    runtimeVersion = $runtimeVersion
    runtimeSha256 = $runtimeSha256
    model = "ggml-large-v3"
    modelSource = "ggerganov/whisper.cpp"
    modelSha1 = $modelSha1
    unquantized = $true
    remoteModelsAllowed = $false
}
$manifest |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $nativeRoot "native-manifest.json") -Encoding UTF8

Write-Host "Native Whisper Large-v3 is installed. No audio was uploaded." -ForegroundColor Green
