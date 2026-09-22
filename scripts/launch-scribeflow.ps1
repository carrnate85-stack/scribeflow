[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipLifecycleLock,
    [switch]$SkipNativeWhisperStart,
    [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows treats environment keys case-insensitively, but some parent apps can
# supply both PATH and Path. Start-Process rejects that duplicate environment.
$currentProcessPath = $env:Path
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $currentProcessPath, "Process")

$projectRoot = Split-Path -Parent $PSScriptRoot
$lifecycleScript = Join-Path $PSScriptRoot "scribeflow-lifecycle.ps1"
if (-not (Test-Path -LiteralPath $lifecycleScript -PathType Leaf)) {
    throw "The ScribeFlow lifecycle helper is missing."
}
. $lifecycleScript

$localDataRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ScribeFlow"
} else {
    Join-Path $projectRoot ".scribeflow-data\ScribeFlow"
}
$storageSelectionPath = Join-Path $localDataRoot "storage-location.json"

function Get-ScribeFlowDocumentsSelection {
    $knownDocuments = [Environment]::GetFolderPath("MyDocuments")
    if ($knownDocuments -and (Test-ScribeFlowAbsolutePath -Path $knownDocuments)) {
        return [pscustomobject]@{
            source = "Windows Known Documents"
            root = Join-Path $knownDocuments "ScribeFlow"
        }
    }

    # Work/business OneDrive wins over personal OneDrive when Windows cannot
    # provide its authoritative Known Documents location.
    foreach ($candidate in @(
        [pscustomobject]@{ source = "OneDrive for work"; root = $env:OneDriveCommercial },
        [pscustomobject]@{ source = "OneDrive personal"; root = $env:OneDriveConsumer },
        [pscustomobject]@{ source = "OneDrive"; root = $env:OneDrive }
    )) {
        if ($candidate.root -and (Test-Path -LiteralPath $candidate.root -PathType Container)) {
            return [pscustomobject]@{
                source = $candidate.source
                root = Join-Path $candidate.root "Documents\ScribeFlow"
            }
        }
    }

    return [pscustomobject]@{
        source = "Local Documents fallback"
        root = Join-Path $env:USERPROFILE "Documents\ScribeFlow"
    }
}

function Save-ScribeFlowDocumentsSelection {
    param([object]$Selection)

    New-Item -ItemType Directory -Path $localDataRoot -Force | Out-Null
    $temporaryPath = "$storageSelectionPath.new"
    [ordered]@{
        schemaVersion = 1
        documentsRoot = [IO.Path]::GetFullPath([string]$Selection.root)
        source = [string]$Selection.source
        computerName = [string]$env:COMPUTERNAME
        selectedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $storageSelectionPath -Force
}

function Restore-PendingScribeFlowInstall {
    # The installer deliberately leaves a durable marker between its atomic
    # file swap and the real loopback health check. A normal launch must never
    # serve that unverified tree after a crash or power loss.
    $installedRoot = Join-Path $env:LOCALAPPDATA "Programs\ScribeFlow"
    if (
        -not ([IO.Path]::GetFullPath($projectRoot)).Equals(
            [IO.Path]::GetFullPath($installedRoot),
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        return
    }

    $transactionPath = Join-Path $localDataRoot `
        "runtime\install-transaction.json"
    $transactionWritingPath = "$transactionPath.writing"
    if (-not (Test-Path -LiteralPath $transactionPath -PathType Leaf)) {
        # A .writing file can only precede the atomic marker rename, which in
        # turn precedes activation. The currently installed tree is still the
        # verified one in this state.
        Remove-Item -LiteralPath $transactionWritingPath `
            -Force -ErrorAction SilentlyContinue
        return
    }

    $programsRoot = Split-Path -Parent $installedRoot
    $backupRoot = Join-Path $programsRoot "ScribeFlow.previous"
    foreach ($pidPath in @(
        (Join-Path $localDataRoot "runtime\server.pid"),
        (Join-Path $localDataRoot "runtime\model-server.pid"),
        (Join-Path $localDataRoot "runtime\native-whisper\server.pid")
    )) {
        $null = Stop-ScribeFlowTrackedProcess -PidFile $pidPath
    }
    if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        throw (
            "A first ScribeFlow installation was interrupted before it could " +
            "be verified. Run the installer again; the unverified app will not open."
        )
    }

    $quarantineRoot = Join-Path $programsRoot "ScribeFlow.unverified"
    Set-Location -LiteralPath $env:TEMP
    if (Test-Path -LiteralPath $quarantineRoot) {
        Remove-ScribeFlowPathWithRetry -Path $quarantineRoot
    }
    if (Test-Path -LiteralPath $installedRoot -PathType Container) {
        Move-Item -LiteralPath $installedRoot -Destination $quarantineRoot
    }
    try {
        Move-Item -LiteralPath $backupRoot -Destination $installedRoot
    }
    catch {
        if (
            -not (Test-Path -LiteralPath $installedRoot) -and
            (Test-Path -LiteralPath $quarantineRoot -PathType Container)
        ) {
            Move-Item -LiteralPath $quarantineRoot -Destination $installedRoot
        }
        throw
    }

    Remove-Item `
        -LiteralPath $transactionPath, $transactionWritingPath `
        -Force -ErrorAction SilentlyContinue
    try {
        Remove-ScribeFlowPathWithRetry -Path $quarantineRoot
    }
    catch {
        # The verified rollback is already active. Quarantine cleanup is best
        # effort and a later installer run can remove it safely.
    }
    Write-Warning "ScribeFlow restored its last verified version after an interrupted update."
}

$lifecycleMutex = $null
try {
    if (-not $SkipLifecycleLock) {
        $lifecycleMutex = Enter-ScribeFlowMutex `
            -Name $script:ScribeFlowLifecycleMutexName `
            -Timeout ([TimeSpan]::FromMinutes(2))
        Restore-PendingScribeFlowInstall
    }

$documentsSelection = Get-ScribeFlowDocumentsSelection
$documentsRoot = [IO.Path]::GetFullPath([string]$documentsSelection.root)
New-Item -ItemType Directory -Path (Join-Path $documentsRoot "Notes") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $documentsRoot "Templates") -Force | Out-Null
Save-ScribeFlowDocumentsSelection -Selection $documentsSelection
$env:SCRIBEFLOW_DOCUMENTS_ROOT = $documentsRoot
Write-Host "ScribeFlow documents: $documentsRoot ($($documentsSelection.source))" `
    -ForegroundColor DarkGray

$whisperReleasePath = Join-Path $projectRoot "scripts\whisper-release.json"
if (-not (Test-Path -LiteralPath $whisperReleasePath -PathType Leaf)) {
    throw "The bundled Whisper release manifest is missing."
}
$whisperRelease = Get-Content -LiteralPath $whisperReleasePath -Raw | ConvertFrom-Json
$nativeWhisperRuntimeVersion = [string]$whisperRelease.runtime.version
$nativeWhisperModelFileName = [string]$whisperRelease.model.fileName
$nativeWhisperRuntimeDirectoryName = ""
$nativeWhisperStoredModelFileName = ""
$nativeWhisperServerRelativePath = ""
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
$modelPort = 3001
$nativeWhisperPort = 3002
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
    $installedManifestPath = Join-Path $installedNativeWhisperRoot "native-manifest.json"
    if (Test-Path -LiteralPath $installedManifestPath -PathType Leaf) {
        try {
            $installedManifest = Get-Content -LiteralPath $installedManifestPath -Raw |
                ConvertFrom-Json
            $installedRuntimeVersion = [string]$installedManifest.runtimeVersion
            $installedModelFileName = [string]$installedManifest.modelFileName
            $runtimeDirectoryProperty = $installedManifest.PSObject.Properties[
                "runtimeDirectoryName"
            ]
            $storedModelProperty = $installedManifest.PSObject.Properties[
                "modelStoredFileName"
            ]
            $serverRelativePathProperty = $installedManifest.PSObject.Properties[
                "runtimeServerRelativePath"
            ]
            $installedRuntimeDirectoryName = if ($runtimeDirectoryProperty) {
                [string]$runtimeDirectoryProperty.Value
            } else { "" }
            $installedStoredModelFileName = if ($storedModelProperty) {
                [string]$storedModelProperty.Value
            } else { "" }
            $installedServerRelativePath = if ($serverRelativePathProperty) {
                [string]$serverRelativePathProperty.Value
            } else { "" }
            if ($installedRuntimeVersion -match "^v[A-Za-z0-9._-]+$") {
                $nativeWhisperRuntimeVersion = $installedRuntimeVersion
            }
            if ($installedModelFileName -match "^[A-Za-z0-9._-]+\.bin$") {
                $nativeWhisperModelFileName = $installedModelFileName
            }
            if ($installedRuntimeDirectoryName -match "^runtime-[A-Za-z0-9._-]+$") {
                $nativeWhisperRuntimeDirectoryName = $installedRuntimeDirectoryName
            }
            if ($installedStoredModelFileName -match "^[A-Za-z0-9._-]+\.bin$") {
                $nativeWhisperStoredModelFileName = $installedStoredModelFileName
            }
            $serverRelativeSegments = @(
                $installedServerRelativePath -split "[\\/]"
            )
            $serverRelativePathIsSafe = $serverRelativeSegments.Count -ge 2
            foreach ($segment in $serverRelativeSegments) {
                if (
                    -not $segment -or
                    $segment -in @(".", "..") -or
                    $segment -notmatch "^[A-Za-z0-9._-]+$"
                ) {
                    $serverRelativePathIsSafe = $false
                    break
                }
            }
            if (
                $serverRelativePathIsSafe -and
                $serverRelativeSegments[-1] -eq "whisper-server.exe"
            ) {
                $nativeWhisperServerRelativePath = (
                    $serverRelativeSegments -join "\"
                )
            }
        }
        catch {
            # The in-app repair flow handles a damaged optional manifest.
        }
    }
}

$nativeWhisperRuntimeFolder = if ($nativeWhisperRuntimeDirectoryName) {
    $nativeWhisperRuntimeDirectoryName
}
else {
    "runtime-$nativeWhisperRuntimeVersion"
}
$nativeWhisperRuntimeRoot = Join-Path $nativeWhisperRoot `
    $nativeWhisperRuntimeFolder
if ($nativeWhisperServerRelativePath) {
    $nativeWhisperServer = Join-Path `
        $nativeWhisperRuntimeRoot `
        $nativeWhisperServerRelativePath
    $nativeWhisperRuntime = Split-Path -Parent $nativeWhisperServer
}
else {
    $nativeWhisperRuntimeCandidates = @(
        (Join-Path $nativeWhisperRuntimeRoot "Release"),
        (Join-Path $nativeWhisperRuntimeRoot "$nativeWhisperRuntimeFolder\Release")
    )
    $nativeWhisperRuntime = $nativeWhisperRuntimeCandidates |
        Where-Object {
            Test-Path -LiteralPath (Join-Path $_ "whisper-server.exe")
        } |
        Select-Object -First 1
    if (-not $nativeWhisperRuntime) {
        $nativeWhisperRuntime = $nativeWhisperRuntimeCandidates[0]
    }
    $nativeWhisperServer = Join-Path $nativeWhisperRuntime `
        "whisper-server.exe"
}
$nativeWhisperModel = Join-Path (
    Join-Path $nativeWhisperRoot "models"
) $(if ($nativeWhisperStoredModelFileName) {
    $nativeWhisperStoredModelFileName
} else {
    $nativeWhisperModelFileName
})
$nativeWhisperLogDirectory = Join-Path $runtimeDirectory "native-whisper"
$nativeWhisperLog = Join-Path $nativeWhisperLogDirectory "server.out.log"
$nativeWhisperErrorLog = Join-Path $nativeWhisperLogDirectory "server.err.log"
$nativeWhisperPidFile = Join-Path $nativeWhisperLogDirectory "server.pid"
$nativeWhisperRouteFile = Join-Path $nativeWhisperLogDirectory `
    "request-path.json"
$nativeWhisperActivationState = Join-Path $runtimeDirectory `
    "whisper-activation.json"

function Get-NativeWhisperRequestPath {
    if (-not (Test-Path -LiteralPath $nativeWhisperRouteFile -PathType Leaf)) {
        return $null
    }
    try {
        $requestPath = [string](
            (Get-Content -LiteralPath $nativeWhisperRouteFile -Raw |
                ConvertFrom-Json).requestPath
        )
        if ($requestPath -match "^/scribeflow-[a-f0-9]{64}$") {
            return $requestPath
        }
    }
    catch {
        # A stale token is replaced before the native service is restarted.
    }
    return $null
}

function Save-NativeWhisperRequestPath {
    param(
        [string]$RequestPath,
        [int]$ProcessId = 0
    )

    New-Item -ItemType Directory -Path $nativeWhisperLogDirectory -Force |
        Out-Null
    $temporaryPath = "$nativeWhisperRouteFile.new"
    [ordered]@{
        schemaVersion = 1
        requestPath = $RequestPath
        processId = $ProcessId
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath `
        -Destination $nativeWhisperRouteFile -Force
}

function New-NativeWhisperRequestPath {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    $token = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $requestPath = "/scribeflow-$token"
    Save-NativeWhisperRequestPath -RequestPath $requestPath
    return $requestPath
}

function Get-ScribeFlowResponse {
    param(
        [int]$Port,
        [string]$RequiredVersion = ""
    )

    try {
        $health = Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port/__health" `
            -TimeoutSec 3
        if (
            $health.ready -ne $true -or
            [string]$health.service -ne "ScribeFlow" -or
            ($RequiredVersion -and [string]$health.version -ne $RequiredVersion)
        ) {
            return $null
        }
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
            return $health
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
    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$modelPort/health" `
            -UseBasicParsing `
            -TimeoutSec 3
        if ($response.StatusCode -eq 200 -and $response.Content -match "ScribeFlow Local Whisper") {
            return $response
        }
    }
    catch {
        return $null
    }
    return $null
}

function Get-NativeWhisperResponse {
    $requestPath = Get-NativeWhisperRequestPath
    if (-not $requestPath) {
        return $null
    }
    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$nativeWhisperPort$requestPath/health" `
            -UseBasicParsing `
            -TimeoutSec 4
        if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"') {
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
    throw "Node.js was not found. ScribeFlow needs its local runtime."
}

function Open-ScribeFlow {
    param([int]$Port)

    $launchToken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $url = "http://127.0.0.1:$Port/?launch=$launchToken"
    Write-Host "ScribeFlow is ready at $url" -ForegroundColor Green
    if ($NoBrowser) {
        return
    }
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
    } else {
        Start-Process $url
    }
}

if (-not $ExpectedVersion) {
    try {
        $ExpectedVersion = [string](
            (Get-Content -LiteralPath (Join-Path $projectRoot "app-version.json") -Raw |
                ConvertFrom-Json).version
        )
    }
    catch {
        $ExpectedVersion = ""
    }
}

if (
    -not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\server\index.js")) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\client"))
) {
    throw "The ScribeFlow production build is missing."
}
if (
    -not (Test-Path -LiteralPath $modelServerScript) -or
    -not (Test-Path -LiteralPath $portableWebServerScript)
) {
    throw "A local ScribeFlow service is missing."
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$node = Find-Node

    if (-not (Get-LocalWhisperResponse)) {
        $null = Stop-ScribeFlowTrackedProcess -PidFile $modelPidFile
        if (-not (Test-PortAvailable -Port $modelPort)) {
            throw "Port 3001 is being used by another app. Close that app so ScribeFlow can start its loopback-only model service."
        }
        $modelServer = Start-Process `
            -FilePath $node `
            -ArgumentList @("`"$modelServerScript`"") `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $modelLog `
            -RedirectStandardError $modelErrorLog `
            -PassThru
        Write-ScribeFlowPidRecord `
            -Path $modelPidFile `
            -Process $modelServer `
            -Kind "model-server" `
            -ExpectedPath $node
        $modelDeadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 200
            if ($modelServer.HasExited) {
                $details = if (Test-Path -LiteralPath $modelErrorLog) {
                    (Get-Content -LiteralPath $modelErrorLog -Tail 15) -join [Environment]::NewLine
                } else { "" }
                throw "The local model service stopped unexpectedly.`n$details"
            }
            if (Get-LocalWhisperResponse) { break }
        } while ((Get-Date) -lt $modelDeadline)
        if (-not (Get-LocalWhisperResponse)) {
            throw "The local model service did not become ready."
        }
    }

    $selectedPort = 3000
    if (-not (Get-ScribeFlowResponse -Port $selectedPort -RequiredVersion $ExpectedVersion)) {
        $null = Stop-ScribeFlowTrackedProcess -PidFile $pidFile
        if (-not (Test-PortAvailable -Port $selectedPort)) {
            throw "Port 3000 is being used by another app. Close that app, then launch ScribeFlow again."
        }
        $server = Start-Process `
            -FilePath $node `
            -ArgumentList @("`"$portableWebServerScript`"") `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $standardLog `
            -RedirectStandardError $errorLog `
            -PassThru
        Write-ScribeFlowPidRecord `
            -Path $pidFile `
            -Process $server `
            -Kind "web-server" `
            -ExpectedPath $node
        Write-Host "Starting ScribeFlow..." -ForegroundColor Cyan
        $deadline = (Get-Date).AddSeconds(50)
        do {
            Start-Sleep -Milliseconds 350
            if ($server.HasExited) {
                $details = if (Test-Path -LiteralPath $errorLog) {
                    (Get-Content -LiteralPath $errorLog -Tail 15) -join [Environment]::NewLine
                } else { "" }
                throw "The ScribeFlow server stopped unexpectedly.`n$details"
            }
            if (Get-ScribeFlowResponse -Port $selectedPort -RequiredVersion $ExpectedVersion) {
                break
            }
        } while ((Get-Date) -lt $deadline)
        if (-not (Get-ScribeFlowResponse -Port $selectedPort -RequiredVersion $ExpectedVersion)) {
            throw "ScribeFlow did not become ready in time. Review $errorLog for details."
        }
    }

    if (-not $SkipNativeWhisperStart) {
        # Whisper is optional. A damaged model, unsupported CUDA runtime, or
        # interrupted Whisper update must never prevent the note editor from
        # opening. The in-app status panel can then offer repair or fallback.
        try {
            if (Test-Path -LiteralPath $nativeWhisperActivationState -PathType Leaf) {
                throw "An interrupted Whisper update needs repair inside ScribeFlow."
            }
            if (
                -not (Test-Path -LiteralPath $nativeWhisperServer) -or
                -not (Test-Path -LiteralPath $nativeWhisperModel)
            ) {
                Write-Host "Whisper Large-v3 is not installed yet. ScribeFlow will offer to install it inside the app." `
                    -ForegroundColor Yellow
            }
            elseif (-not (Get-NativeWhisperResponse)) {
                $null = Stop-ScribeFlowTrackedProcess -PidFile $nativeWhisperPidFile
                if (-not (Test-PortAvailable -Port $nativeWhisperPort)) {
                    throw "Port 3002 is being used by another app."
                }
                New-Item -ItemType Directory -Path $nativeWhisperLogDirectory -Force | Out-Null
                $nativeRequestPath = New-NativeWhisperRequestPath
                $nativeServer = Start-Process `
                    -FilePath $nativeWhisperServer `
                    -ArgumentList @(
                        "--host", "127.0.0.1", "--port", "$nativeWhisperPort",
                        "--request-path", $nativeRequestPath,
                        "--model", "`"$nativeWhisperModel`"", "--threads", "12",
                        "--language", "en", "--beam-size", "5", "--best-of", "5",
                        "--no-timestamps", "--suppress-nst", "--flash-attn"
                    ) `
                    -WorkingDirectory $nativeWhisperRuntime `
                    -WindowStyle Hidden `
                    -RedirectStandardOutput $nativeWhisperLog `
                    -RedirectStandardError $nativeWhisperErrorLog `
                    -PassThru
                Save-NativeWhisperRequestPath `
                    -RequestPath $nativeRequestPath `
                    -ProcessId $nativeServer.Id
                Write-ScribeFlowPidRecord `
                    -Path $nativeWhisperPidFile `
                    -Process $nativeServer `
                    -Kind "native-whisper" `
                    -ExpectedPath $nativeWhisperServer
                $nativeDeadline = (Get-Date).AddSeconds(45)
                do {
                    Start-Sleep -Milliseconds 500
                    if ($nativeServer.HasExited) {
                        $details = if (Test-Path -LiteralPath $nativeWhisperErrorLog) {
                            (Get-Content -LiteralPath $nativeWhisperErrorLog -Tail 20) -join [Environment]::NewLine
                        } else { "" }
                        throw "Native Whisper stopped unexpectedly.`n$details"
                    }
                    if (Get-NativeWhisperResponse) { break }
                } while ((Get-Date) -lt $nativeDeadline)
                if (-not (Get-NativeWhisperResponse)) {
                    throw "Native Whisper Large-v3 did not become ready."
                }
            }
        }
        catch {
            $null = Stop-ScribeFlowTrackedProcess -PidFile $nativeWhisperPidFile
            Write-Warning "ScribeFlow opened without Whisper: $($_.Exception.Message)"
            try {
                New-Item -ItemType Directory -Path $nativeWhisperLogDirectory -Force |
                    Out-Null
                Add-Content -LiteralPath $nativeWhisperErrorLog -Encoding UTF8 `
                    -Value ("[{0}] Optional Whisper startup failed: {1}" -f (
                        Get-Date
                    ).ToString("o"), $_.Exception.Message)
            }
            catch {
                # Logging an optional failure is best effort only.
            }
        }
    }
}
finally {
    Exit-ScribeFlowMutex -Mutex $lifecycleMutex
}

Open-ScribeFlow -Port 3000
