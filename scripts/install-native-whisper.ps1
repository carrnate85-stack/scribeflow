[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

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
$workRoot = Join-Path (Join-Path $nativeRoot "work") $releaseVersion
$runtimeDownload = Join-Path $workRoot "$runtimeArchiveName.download"
$runtimeStaging = Join-Path $workRoot "runtime.installing"
$runtimeHashPrefix = $runtimeSha256.Substring(0, 12).ToLowerInvariant()
$runtimeGeneration = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$runtimeDirectoryName = "runtime-$runtimeVersion-$runtimeHashPrefix-$runtimeGeneration"
$runtimeRoot = Join-Path $nativeRoot $runtimeDirectoryName
$runtimeArchiveBase = [IO.Path]::GetFileNameWithoutExtension($runtimeArchiveName)
$runtimeArchiveStoredName = "$runtimeArchiveBase-$runtimeHashPrefix.zip"
$runtimeArchiveRoot = Join-Path $nativeRoot "archives"
$runtimeArchive = Join-Path $runtimeArchiveRoot $runtimeArchiveStoredName
$legacyRuntimeArchive = Join-Path $nativeRoot $runtimeArchiveName
$modelRoot = Join-Path $nativeRoot "models"
$modelDownload = Join-Path $workRoot "$modelFileName.download"
$modelHashPrefix = $modelSha1.Substring(0, 12).ToLowerInvariant()
$modelGeneration = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$modelBaseName = [IO.Path]::GetFileNameWithoutExtension($modelFileName)
$modelStoredFileName = "$modelBaseName-$modelHashPrefix-$modelGeneration.bin"
$modelFile = Join-Path $modelRoot $modelStoredFileName
$legacyModelFile = Join-Path $modelRoot $modelFileName
$statusPath = Join-Path $localDataRoot "runtime\whisper-status.json"
$installLogPath = Join-Path $localDataRoot "runtime\whisper-install.log"
$activationPath = Join-Path $localDataRoot "runtime\whisper-activation.json"
$nativeWhisperPidFile = Join-Path $localDataRoot "runtime\native-whisper\server.pid"
$nativeWhisperRouteFile = Join-Path $localDataRoot `
    "runtime\native-whisper\request-path.json"
$nativeWhisperLogRoot = Join-Path $localDataRoot "runtime\native-whisper"
$nativeWhisperOutputLog = Join-Path $nativeWhisperLogRoot "server.out.log"
$nativeWhisperErrorLog = Join-Path $nativeWhisperLogRoot "server.err.log"
$previousManifestPath = Join-Path $nativeRoot "native-manifest.json"
$previousManifest = $null
$installerInstanceId = [Guid]::NewGuid().ToString("N")
$installerProcess = Get-Process -Id $PID -ErrorAction Stop
$installerProcessPath = [IO.Path]::GetFullPath($installerProcess.Path)
$installerProcessStartedAtUtc = $installerProcess.StartTime.ToUniversalTime().ToString("o")

function Write-WhisperLog {
    param([string]$Message)

    $parent = Split-Path -Parent $installLogPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Add-Content -LiteralPath $installLogPath -Value (
        "[{0}] {1}" -f (Get-Date).ToString("o"), $Message
    ) -Encoding UTF8
}

function Set-WhisperStatus {
    param(
        [string]$Stage,
        [string]$Message
    )

    $parent = Split-Path -Parent $statusPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$statusPath.new"
    [ordered]@{
        schemaVersion = 2
        stage = $Stage
        releaseVersion = $releaseVersion
        message = $Message
        processId = $PID
        installerInstanceId = $installerInstanceId
        processPath = $installerProcessPath
        processStartedAtUtc = $installerProcessStartedAtUtc
        installerScriptPath = [IO.Path]::GetFullPath($PSCommandPath)
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        logPath = $installLogPath
        workDirectory = $workRoot
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
    Write-WhisperLog "$Stage`: $Message"
}

function Set-WhisperActivationState {
    param(
        [string]$Stage,
        [string]$RuntimeDirectoryName,
        [string]$RuntimeServerRelativePath,
        [string]$ModelStoredFileName,
        [bool]$ModelNeedsActivation,
        [bool]$RuntimeActivated,
        [bool]$ModelActivated
    )

    $parent = Split-Path -Parent $activationPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$activationPath.new"
    [ordered]@{
        schemaVersion = 2
        releaseVersion = $releaseVersion
        stage = $Stage
        processId = $PID
        installerInstanceId = $installerInstanceId
        runtimeDirectoryName = $RuntimeDirectoryName
        runtimeServerRelativePath = $RuntimeServerRelativePath.Replace("\", "/")
        runtimeActivated = $RuntimeActivated
        modelFileName = $modelFileName
        modelStoredFileName = $ModelStoredFileName
        modelSha1 = $modelSha1
        modelNeedsActivation = $ModelNeedsActivation
        modelActivated = $ModelActivated
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $activationPath -Force
}

function Clear-WhisperActivationState {
    Remove-Item `
        -LiteralPath $activationPath, "$activationPath.new" `
        -Force `
        -ErrorAction SilentlyContinue
}

function New-WhisperRequestPath {
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
    return "/scribeflow-$token"
}

function Save-WhisperRequestPath {
    param(
        [string]$RequestPath,
        [int]$ProcessId
    )

    New-Item -ItemType Directory -Path $nativeWhisperLogRoot -Force | Out-Null
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
        -Destination $nativeWhisperRouteFile `
        -Force
}

function Test-WhisperPortAvailable {
    $listener = [Net.Sockets.TcpListener]::new(
        [Net.IPAddress]::Loopback,
        3002
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

function Test-WhisperHealth {
    param(
        [string]$RequestPath,
        [int]$Port = 3002
    )

    try {
        $response = Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port$RequestPath/health" `
            -TimeoutSec 4
        return [string]$response.status -eq "ok"
    }
    catch {
        return $false
    }
}

function Invoke-WhisperVerifiedDownload {
    param(
        [string]$Url,
        [string]$Destination,
        [ValidateSet("SHA1", "SHA256")]
        [string]$Algorithm,
        [string]$ExpectedHash,
        [int]$MaximumSeconds,
        [string]$Description
    )

    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        try {
            if (
                (Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm).Hash -eq
                    $ExpectedHash
            ) {
                return
            }
        }
        catch {
            # A partial or locked download is handled by resume/fresh retry.
        }
    }

    $commonArguments = @(
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--write-out", "%{http_code}",
        "--retry", "5",
        "--retry-all-errors",
        "--retry-delay", "2",
        "--connect-timeout", "10",
        "--max-time", "$MaximumSeconds",
        "--speed-time", "60",
        "--speed-limit", "1024",
        "--output", $Destination
    )
    $downloadArguments = @($commonArguments)
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $downloadArguments += @("--continue-at", "-")
    }
    $downloadArguments += $Url
    $downloadResult = & curl.exe @downloadArguments
    $downloadExitCode = $LASTEXITCODE
    $downloadResultText = ($downloadResult -join "").Trim()
    $downloadHttpCode = if ($downloadResultText -match "(?<code>\d{3})$") {
        $Matches.code
    } else { "" }

    # A completed resumed file can make an HTTP server answer 416. Accept that
    # case only after the complete cryptographic hash succeeds.
    if ($downloadExitCode -ne 0) {
        $completedAfterCurl = $false
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            try {
                $completedAfterCurl = (
                    Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm
                ).Hash -eq $ExpectedHash
            }
            catch {
                $completedAfterCurl = $false
            }
        }
        if ($completedAfterCurl) {
            return
        }

        if ($downloadHttpCode -ne "416" -and $downloadExitCode -ne 33) {
            throw "$Description download was interrupted and can resume later."
        }

        # A corrupt complete file cannot be resumed. Make one fresh attempt at
        # a sibling work path while retaining a useful partial for a later run.
        $freshDestination = "$Destination.fresh"
        Remove-Item -LiteralPath $freshDestination `
            -Force -ErrorAction SilentlyContinue
        $freshArguments = @($commonArguments)
        $freshArguments[$freshArguments.Count - 1] = $freshDestination
        $freshArguments += $Url
        $freshResult = & curl.exe @freshArguments
        if (
            $LASTEXITCODE -ne 0 -or
            -not (Test-Path -LiteralPath $freshDestination -PathType Leaf) -or
            (Get-FileHash -LiteralPath $freshDestination -Algorithm $Algorithm).Hash -ne
                $ExpectedHash
        ) {
            Remove-Item -LiteralPath $freshDestination `
                -Force -ErrorAction SilentlyContinue
            throw "$Description download failed."
        }
        Move-Item -LiteralPath $freshDestination `
            -Destination $Destination `
            -Force
    }

    if (
        -not (Test-Path -LiteralPath $Destination -PathType Leaf) -or
        (Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm).Hash -ne
            $ExpectedHash
    ) {
        Remove-Item -LiteralPath $Destination `
            -Force -ErrorAction SilentlyContinue
        throw "$Description checksum did not match."
    }
}

function Stop-InstalledWhisper {
    $null = Stop-ScribeFlowTrackedProcess -PidFile $nativeWhisperPidFile
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

function Get-WhisperJsonProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    if (-not $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property) {
        return $null
    }
    return $property.Value
}

function Restore-UncommittedWhisperModel {
    param(
        [string]$StoredModelPath,
        [string]$DownloadPath,
        [string]$ExpectedSha1
    )

    if (-not (Test-Path -LiteralPath $StoredModelPath -PathType Leaf)) {
        return $false
    }
    $storedHash = (
        Get-FileHash -LiteralPath $StoredModelPath -Algorithm SHA1
    ).Hash
    if ($storedHash -ne $ExpectedSha1) {
        Remove-Item -LiteralPath $StoredModelPath -Force
        return $false
    }

    $resolvedStored = [IO.Path]::GetFullPath($StoredModelPath)
    $resolvedDownload = [IO.Path]::GetFullPath($DownloadPath)
    if ($resolvedStored.Equals(
        $resolvedDownload,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        return $true
    }

    $downloadParent = Split-Path -Parent $DownloadPath
    New-Item -ItemType Directory -Path $downloadParent -Force | Out-Null
    if (Test-Path -LiteralPath $DownloadPath -PathType Leaf) {
        $downloadHash = try {
            (Get-FileHash -LiteralPath $DownloadPath -Algorithm SHA1).Hash
        }
        catch {
            ""
        }
        if ($downloadHash -eq $ExpectedSha1) {
            Remove-Item -LiteralPath $StoredModelPath -Force
            return $true
        }
        Remove-Item -LiteralPath $DownloadPath -Force
    }
    Move-Item -LiteralPath $StoredModelPath -Destination $DownloadPath
    return $true
}

function Recover-InterruptedWhisperActivation {
    param(
        [object]$ActivationState,
        [object]$CommittedManifest
    )

    # An activation marker means the previous installer may have stopped or
    # started native Whisper. Stop only identity-checked/native-root processes
    # before touching the exact generation recorded by that marker.
    Stop-InstalledWhisper

    if ([int](Get-WhisperJsonProperty $ActivationState "schemaVersion") -ne 2) {
        Write-WhisperLog "The interrupted activation used a legacy marker; preserving unknown files and clearing only the marker."
        Clear-WhisperActivationState
        return
    }

    $markerRuntimeName = [string](
        Get-WhisperJsonProperty $ActivationState "runtimeDirectoryName"
    )
    $markerModelName = [string](
        Get-WhisperJsonProperty $ActivationState "modelStoredFileName"
    )
    $markerModelNeedsActivation = [bool](
        Get-WhisperJsonProperty $ActivationState "modelNeedsActivation"
    )
    $markerModelActivated = [bool](
        Get-WhisperJsonProperty $ActivationState "modelActivated"
    )
    $markerReleaseVersion = [string](
        Get-WhisperJsonProperty $ActivationState "releaseVersion"
    )
    $markerModelFileName = [string](
        Get-WhisperJsonProperty $ActivationState "modelFileName"
    )
    $markerModelSha1 = ([string](
        Get-WhisperJsonProperty $ActivationState "modelSha1"
    )).ToUpperInvariant()

    $committedRuntimeName = [string](
        Get-WhisperJsonProperty $CommittedManifest "runtimeDirectoryName"
    )
    $committedModelName = [string](
        Get-WhisperJsonProperty $CommittedManifest "modelStoredFileName"
    )

    if (
        $markerRuntimeName -match "^runtime-[A-Za-z0-9._-]+$" -and
        -not $markerRuntimeName.Equals(
            $committedRuntimeName,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        $uncommittedRuntime = Join-Path $nativeRoot $markerRuntimeName
        if (Test-Path -LiteralPath $uncommittedRuntime) {
            Remove-ScribeFlowPathWithRetry -Path $uncommittedRuntime
            Write-WhisperLog "Removed the exact uncommitted Whisper runtime generation recorded by the interrupted activation."
        }
    }

    if (
        ($markerModelNeedsActivation -or $markerModelActivated) -and
        $markerModelName -match "^[A-Za-z0-9._-]+\.bin$" -and
        -not $markerModelName.Equals(
            $committedModelName,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        $uncommittedModel = Join-Path $modelRoot $markerModelName
        if (Test-Path -LiteralPath $uncommittedModel -PathType Leaf) {
            if (
                $markerReleaseVersion -match "^[A-Za-z0-9._-]+$" -and
                $markerModelFileName -match "^[A-Za-z0-9._-]+\.bin$" -and
                $markerModelSha1 -match "^[A-F0-9]{40}$"
            ) {
                $recoveryDownload = if (
                    $markerModelSha1 -eq $modelSha1 -and
                    $markerModelFileName.Equals(
                        $modelFileName,
                        [StringComparison]::OrdinalIgnoreCase
                    )
                ) {
                    $modelDownload
                }
                else {
                    $recoveryWorkRoot = Join-Path (
                        Join-Path $nativeRoot "work"
                    ) $markerReleaseVersion
                    Join-Path `
                        $recoveryWorkRoot `
                        "$markerModelFileName.download"
                }
                if (Restore-UncommittedWhisperModel `
                    -StoredModelPath $uncommittedModel `
                    -DownloadPath $recoveryDownload `
                    -ExpectedSha1 $markerModelSha1
                ) {
                    Write-WhisperLog "Recovered the verified uncommitted Whisper model into its resumable download path."
                }
            }
            else {
                Remove-Item -LiteralPath $uncommittedModel -Force
            }
        }
    }

    Clear-WhisperActivationState
}

$whisperMutex = $null
$lifecycleMutex = $null
$healthProcess = $null
$activationCommitted = $false
$activatedRuntime = $false
$activatedModel = $false

# Lock acquisition is intentionally outside the operation catch. A second
# installer that times out must not touch the active installer's marker/status.
$whisperMutex = Enter-ScribeFlowMutex `
    -Name $script:ScribeFlowWhisperMutexName `
    -Timeout ([TimeSpan]::FromMinutes(2))

try {
    New-Item -ItemType Directory -Path $nativeRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    Set-WhisperStatus -Stage "checking" `
        -Message "Checking the verified Whisper files on this computer."
    if (Test-Path -LiteralPath $previousManifestPath -PathType Leaf) {
        try {
            $previousManifest = Get-Content `
                -LiteralPath $previousManifestPath `
                -Raw |
                ConvertFrom-Json
        }
        catch {
            $previousManifest = $null
        }
    }

    # Recover only the exact immutable generations named by the durable marker.
    # The last committed manifest remains authoritative until health succeeds.
    if (Test-Path -LiteralPath $activationPath -PathType Leaf) {
        $lifecycleMutex = Enter-ScribeFlowMutex `
            -Name $script:ScribeFlowLifecycleMutexName `
            -Timeout ([TimeSpan]::FromMinutes(2))
        try {
            Write-WhisperLog "Recovering an interrupted Whisper activation; the last committed manifest remains authoritative."
            $interruptedActivation = try {
                Get-Content -LiteralPath $activationPath -Raw |
                    ConvertFrom-Json
            }
            catch {
                $null
            }
            Recover-InterruptedWhisperActivation `
                -ActivationState $interruptedActivation `
                -CommittedManifest $previousManifest
        }
        finally {
            Exit-ScribeFlowMutex -Mutex $lifecycleMutex
            $lifecycleMutex = $null
        }
    }
    Remove-Item `
        -LiteralPath "$previousManifestPath.new" `
        -Force `
        -ErrorAction SilentlyContinue
    $previousRuntimeRoot = $null
    $previousModelFile = $null
    $previousArchive = $null
    if ($previousManifest) {
        $runtimeDirectoryProperty = $previousManifest.PSObject.Properties[
            "runtimeDirectoryName"
        ]
        $previousRuntimeDirectoryName = if ($runtimeDirectoryProperty) {
            [string]$runtimeDirectoryProperty.Value
        } else { "" }
        if ($previousRuntimeDirectoryName -notmatch "^runtime-[A-Za-z0-9._-]+$") {
            $previousRuntimeVersion = [string]$previousManifest.runtimeVersion
            if ($previousRuntimeVersion -match "^v[A-Za-z0-9._-]+$") {
                $previousRuntimeDirectoryName = "runtime-$previousRuntimeVersion"
            }
        }
        if ($previousRuntimeDirectoryName -match "^runtime-[A-Za-z0-9._-]+$") {
            $previousRuntimeRoot = Join-Path $nativeRoot $previousRuntimeDirectoryName
        }

        $storedModelProperty = $previousManifest.PSObject.Properties[
            "modelStoredFileName"
        ]
        $previousModelStoredName = if ($storedModelProperty) {
            [string]$storedModelProperty.Value
        } else { "" }
        if ($previousModelStoredName -notmatch "^[A-Za-z0-9._-]+\.bin$") {
            $previousModelStoredName = [string]$previousManifest.modelFileName
        }
        if ($previousModelStoredName -match "^[A-Za-z0-9._-]+\.bin$") {
            $previousModelFile = Join-Path $modelRoot $previousModelStoredName
        }

        $storedArchiveProperty = $previousManifest.PSObject.Properties[
            "runtimeArchiveStoredName"
        ]
        $previousArchiveStoredName = if ($storedArchiveProperty) {
            [string]$storedArchiveProperty.Value
        } else { "" }
        if ($previousArchiveStoredName -match "^[A-Za-z0-9._-]+\.zip$") {
            $previousArchive = Join-Path $runtimeArchiveRoot $previousArchiveStoredName
        }
        else {
            $previousArchiveName = [string]$previousManifest.runtimeArchiveName
            if ($previousArchiveName -match "^[A-Za-z0-9._-]+\.zip$") {
                $previousArchive = Join-Path $nativeRoot $previousArchiveName
            }
        }
    }

    # Downloads and extraction happen under only the Whisper mutex. ScribeFlow
    # and the currently verified Whisper service remain usable throughout.
    $runtimeArchiveSource = $null
    foreach ($candidate in @(
        $previousArchive,
        $runtimeArchive,
        $legacyRuntimeArchive
    )) {
        if (
            $candidate -and
            (Test-Path -LiteralPath $candidate -PathType Leaf) -and
            (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq
                $runtimeSha256
        ) {
            $runtimeArchiveSource = $candidate
            break
        }
    }
    if (-not $runtimeArchiveSource) {
        Set-WhisperStatus -Stage "downloading" `
            -Message "Downloading the verified Whisper runtime."
        Write-Host "Downloading the official whisper.cpp CUDA runtime..." `
            -ForegroundColor Cyan
        Invoke-WhisperVerifiedDownload `
            -Url $runtimeUrl `
            -Destination $runtimeDownload `
            -Algorithm "SHA256" `
            -ExpectedHash $runtimeSha256 `
            -MaximumSeconds 1800 `
            -Description "The native Whisper CUDA runtime"
        $runtimeArchiveSource = $runtimeDownload
    }

    Set-WhisperStatus -Stage "installing" `
        -Message "Preparing a fresh verified Whisper runtime."
    if (Test-Path -LiteralPath $runtimeStaging) {
        Remove-ScribeFlowPathWithRetry -Path $runtimeStaging
    }
    New-Item -ItemType Directory -Path $runtimeStaging -Force | Out-Null
    # Always extract a fresh runtime during Install/Repair. Merely finding the
    # EXE is insufficient because a required DLL may be damaged or missing.
    Expand-Archive `
        -LiteralPath $runtimeArchiveSource `
        -DestinationPath $runtimeStaging `
        -Force
    $stagedServer = Get-ChildItem `
        -LiteralPath $runtimeStaging `
        -Filter "whisper-server.exe" `
        -File `
        -Recurse |
        Select-Object -First 1
    if (-not $stagedServer) {
        throw "The Whisper runtime archive did not contain whisper-server.exe."
    }
    $serverRelativePath = $stagedServer.FullName.Substring(
        $runtimeStaging.Length
    ).TrimStart("\", "/")

    # Keep the verified archive at a content-addressed name. Future manifests
    # may reuse a friendly archive name without ever overwriting rollback data.
    if (
        -not ([IO.Path]::GetFullPath($runtimeArchiveSource)).Equals(
            [IO.Path]::GetFullPath($runtimeArchive),
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        New-Item -ItemType Directory -Path $runtimeArchiveRoot -Force |
            Out-Null
        if (Test-Path -LiteralPath $runtimeArchive) {
            Remove-Item -LiteralPath $runtimeArchive -Force
        }
        if ($runtimeArchiveSource -eq $runtimeDownload) {
            Move-Item -LiteralPath $runtimeDownload -Destination $runtimeArchive
        }
        else {
            Copy-Item -LiteralPath $runtimeArchiveSource -Destination $runtimeArchive
        }
        if (
            (Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -ne
                $runtimeSha256
        ) {
            Remove-Item -LiteralPath $runtimeArchive -Force
            throw "The stored Whisper runtime archive checksum did not match."
        }
        $runtimeArchiveSource = $runtimeArchive
    }

    $modelCandidate = $null
    foreach ($candidate in @($previousModelFile, $legacyModelFile)) {
        if (
            $candidate -and
            (Test-Path -LiteralPath $candidate -PathType Leaf) -and
            (Get-FileHash -LiteralPath $candidate -Algorithm SHA1).Hash -eq
                $modelSha1
        ) {
            $modelCandidate = $candidate
            break
        }
    }
    $modelNeedsActivation = $false
    if (-not $modelCandidate) {
        Set-WhisperStatus -Stage "downloading" `
            -Message "Downloading and verifying $displayName ($downloadSizeLabel)."
        Write-Host "Downloading verified $displayName ($downloadSizeLabel)..." `
            -ForegroundColor Cyan
        Invoke-WhisperVerifiedDownload `
            -Url $modelUrl `
            -Destination $modelDownload `
            -Algorithm "SHA1" `
            -ExpectedHash $modelSha1 `
            -MaximumSeconds 7200 `
            -Description "The unquantized Large-v3 model"
        $modelCandidate = $modelDownload
        $modelNeedsActivation = $true
    }
    $activationModelStoredName = if ($modelNeedsActivation) {
        $modelStoredFileName
    }
    else {
        [IO.Path]::GetFileName($modelCandidate)
    }

    Set-WhisperStatus -Stage "verifying" `
        -Message "Activating the prepared Whisper files and checking local health."

    # Only the fast stop/swap/health transaction shares the global lifecycle
    # lock. Multi-gigabyte downloads never block ScribeFlow launch or updates.
    $lifecycleMutex = Enter-ScribeFlowMutex `
        -Name $script:ScribeFlowLifecycleMutexName `
        -Timeout ([TimeSpan]::FromMinutes(8))
    try {
        Set-WhisperActivationState `
            -Stage "pending-health-verification" `
            -RuntimeDirectoryName $runtimeDirectoryName `
            -RuntimeServerRelativePath $serverRelativePath `
            -ModelStoredFileName $activationModelStoredName `
            -ModelNeedsActivation $modelNeedsActivation `
            -RuntimeActivated $false `
            -ModelActivated $false
        Stop-InstalledWhisper

        Move-Item -LiteralPath $runtimeStaging -Destination $runtimeRoot
        $activatedRuntime = $true
        Set-WhisperActivationState `
            -Stage "pending-health-verification" `
            -RuntimeDirectoryName $runtimeDirectoryName `
            -RuntimeServerRelativePath $serverRelativePath `
            -ModelStoredFileName $activationModelStoredName `
            -ModelNeedsActivation $modelNeedsActivation `
            -RuntimeActivated $true `
            -ModelActivated $false
        $serverExecutable = Join-Path $runtimeRoot $serverRelativePath
        if (-not (Test-Path -LiteralPath $serverExecutable -PathType Leaf)) {
            throw "The activated Whisper runtime is incomplete."
        }

        if ($modelNeedsActivation) {
            Move-Item -LiteralPath $modelCandidate -Destination $modelFile
            $modelCandidate = $modelFile
            $activatedModel = $true
            Set-WhisperActivationState `
                -Stage "pending-health-verification" `
                -RuntimeDirectoryName $runtimeDirectoryName `
                -RuntimeServerRelativePath $serverRelativePath `
                -ModelStoredFileName $activationModelStoredName `
                -ModelNeedsActivation $modelNeedsActivation `
                -RuntimeActivated $true `
                -ModelActivated $true
        }

        if (-not (Test-WhisperPortAvailable)) {
            throw "Port 3002 is being used by another app, so Whisper could not be verified."
        }
        New-Item -ItemType Directory -Path $nativeWhisperLogRoot -Force |
            Out-Null
        $requestPath = New-WhisperRequestPath
        $healthProcess = Start-Process `
            -FilePath $serverExecutable `
            -ArgumentList @(
                "--host", "127.0.0.1", "--port", "3002",
                "--request-path", $requestPath,
                "--model", "`"$modelCandidate`"", "--threads", "12",
                "--language", "en", "--beam-size", "5", "--best-of", "5",
                "--no-timestamps", "--suppress-nst", "--flash-attn"
            ) `
            -WorkingDirectory (Split-Path -Parent $serverExecutable) `
            -WindowStyle Hidden `
            -RedirectStandardOutput $nativeWhisperOutputLog `
            -RedirectStandardError $nativeWhisperErrorLog `
            -PassThru
        Save-WhisperRequestPath `
            -RequestPath $requestPath `
            -ProcessId $healthProcess.Id
        Write-ScribeFlowPidRecord `
            -Path $nativeWhisperPidFile `
            -Process $healthProcess `
            -Kind "native-whisper" `
            -ExpectedPath $serverExecutable

        $healthDeadline = (Get-Date).AddSeconds(90)
        $whisperHealthy = $false
        do {
            Start-Sleep -Milliseconds 500
            if ($healthProcess.HasExited) {
                $details = if (Test-Path -LiteralPath $nativeWhisperErrorLog) {
                    (Get-Content -LiteralPath $nativeWhisperErrorLog -Tail 20) -join `
                        [Environment]::NewLine
                }
                else {
                    ""
                }
                throw "The new Whisper runtime stopped during its health check.`n$details"
            }
            $whisperHealthy = Test-WhisperHealth `
                -RequestPath $requestPath `
                -Port 3002
            if ($whisperHealthy) {
                break
            }
        }
        while ((Get-Date) -lt $healthDeadline)
        if (-not $whisperHealthy) {
            throw "The new Whisper runtime did not pass its tokenized local health check."
        }
        Set-WhisperActivationState `
            -Stage "health-verified" `
            -RuntimeDirectoryName $runtimeDirectoryName `
            -RuntimeServerRelativePath $serverRelativePath `
            -ModelStoredFileName $activationModelStoredName `
            -ModelNeedsActivation $modelNeedsActivation `
            -RuntimeActivated $true `
            -ModelActivated $activatedModel

        $manifest = [ordered]@{
            schemaVersion = 4
            whisperReleaseVersion = $releaseVersion
            displayName = $displayName
            runtime = $runtimeSource
            runtimeVersion = $runtimeVersion
            runtimeDirectoryName = $runtimeDirectoryName
            runtimeServerRelativePath = $serverRelativePath.Replace("\", "/")
            runtimeArchiveName = $runtimeArchiveName
            runtimeArchiveStoredName = [IO.Path]::GetFileName($runtimeArchiveSource)
            runtimeSha256 = $runtimeSha256
            model = $modelId
            modelSource = $modelSource
            modelFileName = $modelFileName
            modelStoredFileName = [IO.Path]::GetFileName($modelCandidate)
            modelSha1 = $modelSha1
            unquantized = $true
            remoteModelsAllowed = $false
            healthVerifiedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        }
        $temporaryManifestPath = "$previousManifestPath.new"
        $manifest |
            ConvertTo-Json -Depth 5 |
            Set-Content -LiteralPath $temporaryManifestPath -Encoding UTF8
        Move-Item `
            -LiteralPath $temporaryManifestPath `
            -Destination $previousManifestPath `
            -Force
        $activationCommitted = $true
        Clear-WhisperActivationState
    }
    catch {
        $activationFailure = $_
        if (-not $activationCommitted) {
            try {
                if ($healthProcess -and -not $healthProcess.HasExited) {
                    Stop-Process -Id $healthProcess.Id -Force -ErrorAction Stop
                    $null = $healthProcess.WaitForExit(8000)
                }
                $null = Stop-ScribeFlowTrackedProcess `
                    -PidFile $nativeWhisperPidFile
                if ($activatedRuntime -and (Test-Path -LiteralPath $runtimeRoot)) {
                    Remove-ScribeFlowPathWithRetry -Path $runtimeRoot
                    $activatedRuntime = $false
                }
                if ($activatedModel -and (Test-Path -LiteralPath $modelFile)) {
                    $null = Restore-UncommittedWhisperModel `
                        -StoredModelPath $modelFile `
                        -DownloadPath $modelDownload `
                        -ExpectedSha1 $modelSha1
                    $activatedModel = $false
                }
                if ($previousManifest) {
                    Clear-WhisperActivationState
                }
                else {
                    Set-WhisperActivationState `
                        -Stage "failed-health-verification" `
                        -RuntimeDirectoryName $runtimeDirectoryName `
                        -RuntimeServerRelativePath $serverRelativePath `
                        -ModelStoredFileName $activationModelStoredName `
                        -ModelNeedsActivation $modelNeedsActivation `
                        -RuntimeActivated $activatedRuntime `
                        -ModelActivated $activatedModel
                }
            }
            catch {
                Write-WhisperLog "Whisper rollback cleanup needs another repair attempt: $($_.Exception.Message)"
            }
        }
        throw $activationFailure
    }
    finally {
        Exit-ScribeFlowMutex -Mutex $lifecycleMutex
        $lifecycleMutex = $null
    }

    # The prior generation is untouched until the replacement has answered its
    # private health route and the manifest commit is durable.
    if ($previousManifest) {
        try {
            if (
                $previousRuntimeRoot -and
                -not ([IO.Path]::GetFullPath($previousRuntimeRoot)).Equals(
                    [IO.Path]::GetFullPath($runtimeRoot),
                    [StringComparison]::OrdinalIgnoreCase
                ) -and
                (Test-Path -LiteralPath $previousRuntimeRoot -PathType Container)
            ) {
                Remove-ScribeFlowPathWithRetry -Path $previousRuntimeRoot
            }
            if (
                $previousModelFile -and
                -not ([IO.Path]::GetFullPath($previousModelFile)).Equals(
                    [IO.Path]::GetFullPath($modelCandidate),
                    [StringComparison]::OrdinalIgnoreCase
                ) -and
                (Test-Path -LiteralPath $previousModelFile -PathType Leaf)
            ) {
                Remove-Item -LiteralPath $previousModelFile -Force
            }
            if (
                $previousArchive -and
                -not ([IO.Path]::GetFullPath($previousArchive)).Equals(
                    [IO.Path]::GetFullPath($runtimeArchiveSource),
                    [StringComparison]::OrdinalIgnoreCase
                ) -and
                (Test-Path -LiteralPath $previousArchive -PathType Leaf)
            ) {
                Remove-Item -LiteralPath $previousArchive -Force
            }
        }
        catch {
            Write-WhisperLog "The verified update is active, but old Whisper files could not be fully cleaned up: $($_.Exception.Message)"
        }
    }

    try {
        Set-WhisperStatus -Stage "installed" `
            -Message "$displayName is installed locally and passed verification."
    }
    catch {
        Write-Warning "Whisper passed health verification, but its optional status file could not be updated."
    }
    if (Test-Path -LiteralPath $workRoot) {
        try {
            Remove-ScribeFlowPathWithRetry -Path $workRoot
        }
        catch {
            Write-WhisperLog "Whisper is healthy, but temporary download files could not be fully cleaned up: $($_.Exception.Message)"
        }
    }

    Write-Host "$displayName is installed. No audio was uploaded." `
        -ForegroundColor Green
}
catch {
    $installFailure = $_
    try {
        Set-WhisperStatus -Stage "failed" `
            -Message "Whisper installation failed: $($installFailure.Exception.Message)"
    }
    catch {
        # Preserve the original installation error if status recording fails.
    }
    throw $installFailure
}
finally {
    Exit-ScribeFlowMutex -Mutex $lifecycleMutex
    Exit-ScribeFlowMutex -Mutex $whisperMutex
}
