[CmdletBinding()]
param(
    [string]$OutputRoot = (
        Join-Path ([Environment]::GetFolderPath("UserProfile")) `
            "Downloads\ScribeFlow-Online-Installer"
    ),
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$installerRoot = Join-Path $projectRoot "installer"
$resolvedOutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$outputParent = Split-Path -Parent $resolvedOutputRoot
$outputLeaf = [IO.Path]::GetFileName($resolvedOutputRoot)
$stagingRoot = Join-Path $outputParent "$outputLeaf.building"
$payloadRoot = Join-Path $stagingRoot "payload"
$archivePath = Join-Path $outputParent "ScribeFlow-Windows-Online-Installer.zip"
$includesPatientData = $false
$includeLargeModel = $false

function Assert-SafeGeneratedPath {
    param(
        [string]$Path,
        [string[]]$AllowedLeafNames
    )

    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $leafName = [IO.Path]::GetFileName($resolvedPath)
    if (
        -not $leafName -or
        $leafName -notin $AllowedLeafNames -or
        $resolvedPath -eq [IO.Path]::GetPathRoot($resolvedPath)
    ) {
        throw "Refusing unsafe generated-package path: $resolvedPath"
    }
}

Assert-SafeGeneratedPath `
    -Path $resolvedOutputRoot `
    -AllowedLeafNames @("ScribeFlow-Online-Installer")
Assert-SafeGeneratedPath `
    -Path $stagingRoot `
    -AllowedLeafNames @("ScribeFlow-Online-Installer.building")
Assert-SafeGeneratedPath `
    -Path $archivePath `
    -AllowedLeafNames @("ScribeFlow-Windows-Online-Installer.zip")

foreach ($requiredSource in @(
    (Join-Path $installerRoot "Install ScribeFlow.cmd"),
    (Join-Path $installerRoot "Install-ScribeFlow.ps1"),
    (Join-Path $projectRoot "Launch ScribeFlow.cmd"),
    (Join-Path $projectRoot "scripts\launch-scribeflow.ps1"),
    (Join-Path $projectRoot "scripts\install-native-whisper.ps1")
)) {
    if (-not (Test-Path -LiteralPath $requiredSource)) {
        throw "Required installer source is missing: $requiredSource"
    }
}

if (-not $SkipBuild) {
    $pnpm = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        throw "pnpm was not found. Install dependencies before building the installer."
    }
    Push-Location $projectRoot
    try {
        & $pnpm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "The ScribeFlow production build failed."
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($buildPath in @(
    (Join-Path $projectRoot "dist\server\index.js"),
    (Join-Path $projectRoot "dist\client")
)) {
    if (-not (Test-Path -LiteralPath $buildPath)) {
        throw "The production build is incomplete: $buildPath"
    }
}

New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
foreach ($generatedPath in @($stagingRoot, $resolvedOutputRoot)) {
    if (Test-Path -LiteralPath $generatedPath) {
        Remove-Item -LiteralPath $generatedPath -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null

Copy-Item `
    -LiteralPath (Join-Path $projectRoot "dist") `
    -Destination (Join-Path $payloadRoot "dist") `
    -Recurse `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $projectRoot "scripts") `
    -Destination (Join-Path $payloadRoot "scripts") `
    -Recurse `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $projectRoot "Launch ScribeFlow.cmd") `
    -Destination (Join-Path $payloadRoot "Launch ScribeFlow.cmd") `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $installerRoot "Install ScribeFlow.cmd") `
    -Destination (Join-Path $stagingRoot "Install ScribeFlow.cmd") `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $installerRoot "Install-ScribeFlow.ps1") `
    -Destination (Join-Path $stagingRoot "Install-ScribeFlow.ps1") `
    -Force

$nodeVersion = "v22.13.1"
$nodeArchiveName = "node-$nodeVersion-win-x64.zip"
$nodeBaseUrl = "https://nodejs.org/dist/$nodeVersion"
$cacheRoot = Join-Path $env:TEMP "ScribeFlow-installer-cache"
$nodeArchive = Join-Path $cacheRoot $nodeArchiveName
$nodeChecksums = Join-Path $cacheRoot "SHASUMS256-$nodeVersion.txt"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

Write-Host "Downloading the verified portable Node.js runtime..." -ForegroundColor Cyan
& curl.exe `
    --location `
    --fail `
    --retry 5 `
    --retry-delay 2 `
    --output $nodeArchive `
    "$nodeBaseUrl/$nodeArchiveName"
if ($LASTEXITCODE -ne 0) {
    throw "The portable Node.js download failed."
}
& curl.exe `
    --location `
    --fail `
    --retry 5 `
    --retry-delay 2 `
    --output $nodeChecksums `
    "$nodeBaseUrl/SHASUMS256.txt"
if ($LASTEXITCODE -ne 0) {
    throw "The Node.js checksum manifest download failed."
}

$checksumLine = Get-Content -LiteralPath $nodeChecksums |
    Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))$" } |
    Select-Object -First 1
if (-not $checksumLine) {
    throw "The Node.js checksum manifest did not contain $nodeArchiveName."
}
$expectedNodeSha256 = ($checksumLine -split "\s+")[0].ToUpperInvariant()
$actualNodeSha256 = (
    Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256
).Hash
if ($actualNodeSha256 -ne $expectedNodeSha256) {
    throw "The portable Node.js checksum did not match."
}

$nodeExtractRoot = Join-Path $stagingRoot "node-extract"
Expand-Archive `
    -LiteralPath $nodeArchive `
    -DestinationPath $nodeExtractRoot `
    -Force
$extractedNodeRoot = Get-ChildItem `
    -LiteralPath $nodeExtractRoot `
    -Directory |
    Select-Object -First 1
if (-not $extractedNodeRoot) {
    throw "The portable Node.js archive was empty."
}
$portableNodeRoot = Join-Path $payloadRoot "runtime\node"
New-Item -ItemType Directory -Path $portableNodeRoot -Force | Out-Null
Copy-Item `
    -Path (Join-Path $extractedNodeRoot.FullName "*") `
    -Destination $portableNodeRoot `
    -Recurse `
    -Force
Remove-Item -LiteralPath $nodeExtractRoot -Recurse -Force

$manifest = [ordered]@{
    name = "ScribeFlow"
    version = "0.1.0"
    createdUtc = (Get-Date).ToUniversalTime().ToString("o")
    includesPatientData = $includesPatientData
    includesTemplates = $false
    includesAudio = $false
    includesPdfs = $false
    includesLargeModel = $includeLargeModel
    speechModel = "ggml-large-v3.bin"
    speechModelInstall = "downloaded and checksum-verified during installation"
    nodeVersion = $nodeVersion
    nodeSha256 = $actualNodeSha256
}
$manifest |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $stagingRoot "package-manifest.json") `
        -Encoding UTF8

Move-Item -LiteralPath $stagingRoot -Destination $resolvedOutputRoot
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}
Compress-Archive `
    -Path (Join-Path $resolvedOutputRoot "*") `
    -DestinationPath $archivePath `
    -CompressionLevel Optimal

Write-Host ""
Write-Host "ScribeFlow installer created:" -ForegroundColor Green
Write-Host $archivePath
Write-Host "The verified Whisper Large-v3 model downloads during installation."
Write-Host "No templates, notes, PDFs, audio, or patient data were included."
