[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$modelId = "whisper-large-v3-ONNX"
$modelRepository = "onnx-community/whisper-large-v3-ONNX"
$modelRevision = "3b6257ad5e67aa523c7c07f4fea04d445eecc4a6"
$localDataRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ScribeFlow"
} else {
    Join-Path $projectRoot ".scribeflow-data\ScribeFlow"
}
$modelDirectory = Join-Path $localDataRoot "models\$modelId"
$wasmDirectory = Join-Path $projectRoot "public\wasm"
$transformersDirectory = Join-Path $projectRoot "node_modules\@huggingface\transformers"

$modelFiles = @(
    "added_tokens.json",
    "config.json",
    "generation_config.json",
    "merges.txt",
    "normalizer.json",
    "preprocessor_config.json",
    "quantize_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "onnx/encoder_model_q4f16.onnx",
    "onnx/decoder_model_merged_q4f16.onnx"
)

if (-not (Test-Path -LiteralPath $transformersDirectory)) {
    throw "Transformers.js is missing. Run 'pnpm install' before installing Whisper."
}

New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $wasmDirectory -Force | Out-Null

foreach ($relativePath in $modelFiles) {
    $destination = Join-Path $modelDirectory $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

    if ((Test-Path -LiteralPath $destination) -and (Get-Item -LiteralPath $destination).Length -gt 100) {
        Write-Host "Already installed: $relativePath" -ForegroundColor DarkGray
        continue
    }

    $normalizedPath = $relativePath.Replace("\", "/")
    $source = "https://huggingface.co/$modelRepository/resolve/$modelRevision/$normalizedPath"
    $temporaryDestination = "$destination.download"
    Write-Host "Downloading local Whisper file: $relativePath" -ForegroundColor Cyan
    & curl.exe `
        --location `
        --fail `
        --retry 5 `
        --retry-delay 2 `
        --continue-at - `
        --output $temporaryDestination `
        $source
    if ($LASTEXITCODE -ne 0) {
        throw "The local Whisper download failed: $relativePath"
    }

    if ((Get-Item -LiteralPath $temporaryDestination).Length -le 100) {
        Remove-Item -LiteralPath $temporaryDestination -Force
        throw "The downloaded Whisper file was incomplete: $relativePath"
    }

    Move-Item -LiteralPath $temporaryDestination -Destination $destination -Force
}

$runtimeFiles = @(
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm"
)

foreach ($runtimeFile in $runtimeFiles) {
    $source = Join-Path $transformersDirectory "dist\$runtimeFile"
    if (-not (Test-Path -LiteralPath $source)) {
        throw "The local ONNX runtime file is missing: $runtimeFile"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $wasmDirectory $runtimeFile) -Force
}

$installedFiles = $modelFiles | ForEach-Object {
    $path = Join-Path $modelDirectory $_
    [ordered]@{
        path = $_.Replace("\", "/")
        bytes = (Get-Item -LiteralPath $path).Length
    }
}

$manifest = [ordered]@{
    model = $modelId
    source = $modelRepository
    revision = $modelRevision
    runtime = "@huggingface/transformers"
    remoteModelsAllowed = $false
    files = $installedFiles
}

$manifest |
    ConvertTo-Json -Depth 10 |
    Set-Content -LiteralPath (Join-Path $modelDirectory "model-manifest.json") -Encoding UTF8

Write-Host "Local Whisper is installed. No audio was uploaded." -ForegroundColor Green
