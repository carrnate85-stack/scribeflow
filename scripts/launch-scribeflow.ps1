[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows treats environment keys case-insensitively, but some parent apps can
# supply both PATH and Path. Start-Process rejects that duplicate environment.
$currentProcessPath = $env:Path
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $currentProcessPath, "Process")

$projectRoot = Split-Path -Parent $PSScriptRoot
$localDataRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ScribeFlow"
} else {
    Join-Path $projectRoot ".scribeflow-data\ScribeFlow"
}

function Get-ScribeFlowDocumentsRoot {
    $knownDocuments = [Environment]::GetFolderPath("MyDocuments")
    if (
        $knownDocuments -and
        $knownDocuments -match "(?i)\\OneDrive(?:[^\\]*)?\\Documents$"
    ) {
        return Join-Path $knownDocuments "ScribeFlow"
    }

    foreach ($oneDriveRoot in @(
        $env:OneDriveConsumer,
        $env:OneDriveCommercial,
        $env:OneDrive
    )) {
        if ($oneDriveRoot -and (Test-Path -LiteralPath $oneDriveRoot)) {
            return Join-Path $oneDriveRoot "Documents\ScribeFlow"
        }
    }

    if ($knownDocuments) {
        return Join-Path $knownDocuments "ScribeFlow"
    }
    return Join-Path $env:USERPROFILE "Documents\ScribeFlow"
}

$documentsRoot = [IO.Path]::GetFullPath((Get-ScribeFlowDocumentsRoot))
New-Item -ItemType Directory -Path (
    Join-Path $documentsRoot "Notes"
) -Force | Out-Null
New-Item -ItemType Directory -Path (
    Join-Path $documentsRoot "Templates"
) -Force | Out-Null
$env:SCRIBEFLOW_DOCUMENTS_ROOT = $documentsRoot

$whisperReleasePath = Join-Path $projectRoot "scripts\whisper-release.json"
if (-not (Test-Path -LiteralPath $whisperReleasePath -PathType Leaf)) {
    throw "The bundled Whisper release manifest is missing."
}
$whisperRelease = Get-Content -LiteralPath $whisperReleasePath -Raw |
    ConvertFrom-Json
$nativeWhisperRuntimeVersion = [string]$whisperRelease.runtime.version
$nativeWhisperModelFileName = [string]$whisperRelease.model.fileName
if (
    $nativeWhisperRuntimeVersion -notmatch "^v[A-Za-z0-9._-]+$" -or
    $nativeWhisperModelFileName -notmatch "^[A-Za-z0-9._-]+\.bin$"
) {
    throw "The bundled Whisper release manifest is invalid."
}
$portableNodeDirectory = Join-Path $projectRoot "runtime\node"
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$bundledNodeDirectory = Join-Path $runtimeRoot "node\bin"
$runtimeDirectory = Join-Path $localDataRoot "runtime"
$standardLog = Join-Path $runtimeDirectory "server.log"
$errorLog = Join-Path $runtimeDirectory "server-error.log"
$pidFile = Join-Path $runtimeDirectory "server.pid"
$modelLog = Join-Path $runtimeDirectory "model-server.log"
$modelErrorLog = Join-Path $runtimeDirectory "model-server-error.log"
$modelPidFile = Join-Path $runtimeDirectory "model-server.pid"
$modelServerScript = Join-Path $projectRoot "scripts\local-model-server.mjs"
$portableWebServerScript = Join-Path $projectRoot "scripts\portable-web-server.mjs"
$portableNativeWhisperRoot = Join-Path $projectRoot "runtime\native-whisper"
$installedNativeWhisperRoot = Join-Path $localDataRoot "native-whisper"
$portableNativeModel = Join-Path (
    Join-Path $portableNativeWhisperRoot "models"
) $nativeWhisperModelFileName
$nativeWhisperRoot = if (Test-Path -LiteralPath $portableNativeModel) {
    $portableNativeWhisperRoot
} else {
    $installedNativeWhisperRoot
}

if ($nativeWhisperRoot -eq $installedNativeWhisperRoot) {
    $installedManifestPath = Join-Path (
        $installedNativeWhisperRoot
    ) "native-manifest.json"
    if (Test-Path -LiteralPath $installedManifestPath -PathType Leaf) {
        try {
            $installedManifest = Get-Content `
                -LiteralPath $installedManifestPath `
                -Raw |
                ConvertFrom-Json
            $installedRuntimeVersion = [string]$installedManifest.runtimeVersion
            $installedModelFileName = [string]$installedManifest.modelFileName
            $expectedRuntimeRoot = Join-Path (
                $installedNativeWhisperRoot
            ) "runtime-$nativeWhisperRuntimeVersion"
            $expectedRuntimeExists = @(
                (Join-Path $expectedRuntimeRoot "Release\whisper-server.exe"),
                (
                    Join-Path $expectedRuntimeRoot (
                        "runtime-$nativeWhisperRuntimeVersion\Release\whisper-server.exe"
                    )
                )
            ) | Where-Object {
                Test-Path -LiteralPath $_ -PathType Leaf
            }
            if (
                -not $expectedRuntimeExists -and
                $installedRuntimeVersion -match "^v[A-Za-z0-9._-]+$"
            ) {
                $nativeWhisperRuntimeVersion = $installedRuntimeVersion
            }

            $expectedInstalledModel = Join-Path (
                Join-Path $installedNativeWhisperRoot "models"
            ) $nativeWhisperModelFileName
            if (
                -not (Test-Path -LiteralPath $expectedInstalledModel) -and
                $installedModelFileName -match "^[A-Za-z0-9._-]+\.bin$"
            ) {
                $nativeWhisperModelFileName = $installedModelFileName
            }
        }
        catch {
            # A damaged manifest is handled by the in-app repair workflow.
        }
    }
}

$nativeWhisperRuntimeFolder = "runtime-$nativeWhisperRuntimeVersion"
$nativeWhisperRuntimeCandidates = @(
    (Join-Path $nativeWhisperRoot "$nativeWhisperRuntimeFolder\Release"),
    (
        Join-Path $nativeWhisperRoot (
            "$nativeWhisperRuntimeFolder\$nativeWhisperRuntimeFolder\Release"
        )
    )
)
$nativeWhisperRuntime = $nativeWhisperRuntimeCandidates |
    Where-Object {
        Test-Path -LiteralPath (Join-Path $_ "whisper-server.exe")
    } |
    Select-Object -First 1
if (-not $nativeWhisperRuntime) {
    $nativeWhisperRuntime = $nativeWhisperRuntimeCandidates[0]
}
$nativeWhisperServer = Join-Path $nativeWhisperRuntime "whisper-server.exe"
$nativeWhisperModel = Join-Path (
    Join-Path $nativeWhisperRoot "models"
) $nativeWhisperModelFileName
$nativeWhisperLogDirectory = Join-Path $runtimeDirectory "native-whisper"
$nativeWhisperLog = Join-Path $nativeWhisperLogDirectory "server.out.log"
$nativeWhisperErrorLog = Join-Path $nativeWhisperLogDirectory "server.err.log"
$nativeWhisperPidFile = Join-Path $nativeWhisperLogDirectory "server.pid"

function Get-ScribeFlowResponse {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/" `
            -UseBasicParsing `
            -TimeoutSec 4

        if ($response.StatusCode -ne 200 -or $response.Content -notmatch "ScribeFlow") {
            return $null
        }

        $stylesheetMatch = [regex]::Match(
            $response.Content,
            'href="(?<path>/assets/[^"]+\.css)"'
        )

        if (-not $stylesheetMatch.Success) {
            return $null
        }

        $stylesheet = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port$($stylesheetMatch.Groups['path'].Value)" `
            -UseBasicParsing `
            -TimeoutSec 4

        if (
            $stylesheet.StatusCode -eq 200 -and
            $stylesheet.Headers["Content-Type"] -match "text/css"
        ) {
            return $response
        }
    }
    catch {
        return $null
    }

    return $null
}

function Test-PortAvailable {
    param([int]$Port)

    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        $Port
    )

    try {
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        $listener.Stop()
    }
}

function Get-LocalWhisperResponse {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/health" `
            -UseBasicParsing `
            -TimeoutSec 3
        if (
            $response.StatusCode -eq 200 -and
            $response.Content -match "ScribeFlow Local Whisper"
        ) {
            return $response
        }
    }
    catch {
        return $null
    }

    return $null
}

function Get-NativeWhisperResponse {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/" `
            -UseBasicParsing `
            -TimeoutSec 4
        if (
            $response.StatusCode -eq 200 -and
            $response.Content -match "Whisper.cpp Server"
        ) {
            return $response
        }
    }
    catch {
        return $null
    }

    return $null
}

function Find-Node {
    $portableNode = Join-Path $portableNodeDirectory "node.exe"
    if (Test-Path -LiteralPath $portableNode) {
        return $portableNode
    }

    $bundledNode = Join-Path $bundledNodeDirectory "node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
        return $bundledNode
    }

    $installedNode = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($installedNode) {
        return $installedNode.Source
    }

    throw "Node.js was not found. ScribeFlow needs it for the local-only model service."
}

function Open-ScribeFlow {
    param([int]$Port)

    $launchToken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $url = "http://127.0.0.1:$Port/?launch=$launchToken"
    Write-Host "ScribeFlow is ready at $url" -ForegroundColor Green

    if (-not $NoBrowser) {
        $chromeCandidates = @(
            (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
            (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
        )
        $chrome = $chromeCandidates |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1

        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList @("--new-window", $url)
        }
        else {
            Start-Process $url
        }
    }
}

Set-Location -LiteralPath $projectRoot

if (
    -not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\server\index.js")) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\client"))
) {
    throw "The ScribeFlow production build is missing."
}

$modelPort = 3001
if (
    -not (Test-Path -LiteralPath $modelServerScript) -or
    -not (Test-Path -LiteralPath $portableWebServerScript)
) {
    throw "A local ScribeFlow service is missing."
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$node = Find-Node

if (-not (Get-LocalWhisperResponse -Port $modelPort)) {
    if (-not (Test-PortAvailable -Port $modelPort)) {
        throw "Port 3001 is being used by another app. Close that app so ScribeFlow can start its loopback-only Whisper model service."
    }

    $modelServer = Start-Process `
        -FilePath $node `
        -ArgumentList @("`"$modelServerScript`"") `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $modelLog `
        -RedirectStandardError $modelErrorLog `
        -PassThru
    Set-Content -LiteralPath $modelPidFile -Value $modelServer.Id

    $modelDeadline = (Get-Date).AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 200
        if ($modelServer.HasExited) {
            $modelDetails = ""
            if (Test-Path -LiteralPath $modelErrorLog) {
                $modelDetails = (Get-Content -LiteralPath $modelErrorLog -Tail 12) -join [Environment]::NewLine
            }
            throw "The local Whisper model service stopped unexpectedly.`n$modelDetails"
        }
        if (Get-LocalWhisperResponse -Port $modelPort) {
            break
        }
    }
    while ((Get-Date) -lt $modelDeadline)

    if (-not (Get-LocalWhisperResponse -Port $modelPort)) {
        throw "The local Whisper model service did not become ready."
    }
}

$nativeWhisperPort = 3002
if (
    -not (Test-Path -LiteralPath $nativeWhisperServer) -or
    -not (Test-Path -LiteralPath $nativeWhisperModel)
) {
    Write-Host (
        "Whisper Large-v3 is not installed yet. " +
        "ScribeFlow will offer to install it inside the app."
    ) -ForegroundColor Yellow
}
elseif (-not (Get-NativeWhisperResponse -Port $nativeWhisperPort)) {
    if (-not (Test-PortAvailable -Port $nativeWhisperPort)) {
        throw "Port 3002 is being used by another app. Close that app so ScribeFlow can start its loopback-only native Whisper service."
    }

    New-Item -ItemType Directory -Path $nativeWhisperLogDirectory -Force | Out-Null
    $nativeArguments = @(
        "--host", "127.0.0.1",
        "--port", "$nativeWhisperPort",
        "--model", "`"$nativeWhisperModel`"",
        "--threads", "12",
        "--language", "en",
        "--beam-size", "5",
        "--best-of", "5",
        "--no-timestamps",
        "--suppress-nst",
        "--flash-attn"
    )
    $nativeServer = Start-Process `
        -FilePath $nativeWhisperServer `
        -ArgumentList $nativeArguments `
        -WorkingDirectory $nativeWhisperRuntime `
        -WindowStyle Hidden `
        -RedirectStandardOutput $nativeWhisperLog `
        -RedirectStandardError $nativeWhisperErrorLog `
        -PassThru
    Set-Content -LiteralPath $nativeWhisperPidFile -Value $nativeServer.Id

    $nativeDeadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        if ($nativeServer.HasExited) {
            $nativeDetails = ""
            if (Test-Path -LiteralPath $nativeWhisperErrorLog) {
                $nativeDetails = (Get-Content -LiteralPath $nativeWhisperErrorLog -Tail 20) -join [Environment]::NewLine
            }
            throw "Native Whisper stopped unexpectedly.`n$nativeDetails"
        }
        if (Get-NativeWhisperResponse -Port $nativeWhisperPort) {
            break
        }
    }
    while ((Get-Date) -lt $nativeDeadline)

    if (-not (Get-NativeWhisperResponse -Port $nativeWhisperPort)) {
        throw "Native Whisper Large-v3 did not become ready."
    }
}

$selectedPort = 3000
if (Get-ScribeFlowResponse -Port $selectedPort) {
    Open-ScribeFlow -Port $selectedPort
    exit 0
}

if (-not (Test-PortAvailable -Port $selectedPort)) {
    throw "Port 3000 is being used by another app. Close that app, then launch ScribeFlow again. ScribeFlow stays on port 3000 so your synced templates remain consistent."
}

$server = Start-Process `
    -FilePath $node `
    -ArgumentList @("`"$portableWebServerScript`"") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $standardLog `
    -RedirectStandardError $errorLog `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $server.Id
Write-Host "Starting ScribeFlow..." -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds(50)
do {
    Start-Sleep -Milliseconds 350

    if ($server.HasExited) {
        $details = ""
        if (Test-Path -LiteralPath $errorLog) {
            $details = (Get-Content -LiteralPath $errorLog -Tail 12) -join [Environment]::NewLine
        }
        throw "The ScribeFlow server stopped unexpectedly.`n$details"
    }

    if (Get-ScribeFlowResponse -Port $selectedPort) {
        Open-ScribeFlow -Port $selectedPort
        exit 0
    }
}
while ((Get-Date) -lt $deadline)

throw "ScribeFlow did not become ready in time. Review $errorLog for details."
