Set-StrictMode -Version 2.0

$script:ScribeFlowLifecycleMutexName = "Local\ScribeFlowLifecycle"
$script:ScribeFlowWhisperMutexName = "Local\ScribeFlowWhisper"

function Test-ScribeFlowAbsolutePath {
    [CmdletBinding()]
    param([string]$Path)

    if (-not $Path) {
        return $false
    }
    return (
        $Path -match "^[A-Za-z]:[\\/]" -or
        $Path -match "^\\\\[^\\/]+[\\/][^\\/]+"
    )
}

function Enter-ScribeFlowMutex {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [TimeSpan]$Timeout = ([TimeSpan]::FromMinutes(5))
    )

    $mutex = [Threading.Mutex]::new($false, $Name)
    $ownsMutex = $false
    try {
        try {
            $ownsMutex = $mutex.WaitOne($Timeout)
        }
        catch [Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if (-not $ownsMutex) {
            $mutex.Dispose()
            throw "Another ScribeFlow maintenance task is still running. Please try again in a moment."
        }
        return $mutex
    }
    catch {
        if (-not $ownsMutex) {
            $mutex.Dispose()
        }
        throw
    }
}

function Exit-ScribeFlowMutex {
    [CmdletBinding()]
    param([object]$Mutex)

    if (-not $Mutex) {
        return
    }
    try {
        $Mutex.ReleaseMutex()
    }
    catch [ApplicationException] {
        # The mutex was not owned by this thread. Disposing it is still safe.
    }
    finally {
        $Mutex.Dispose()
    }
}

function Write-ScribeFlowPidRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedPath
    )

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$Path.new"
    $startedAtUtc = try {
        $Process.StartTime.ToUniversalTime().ToString("o")
    }
    catch {
        (Get-Date).ToUniversalTime().ToString("o")
    }
    [ordered]@{
        schemaVersion = 1
        pid = $Process.Id
        kind = $Kind
        expectedPath = [IO.Path]::GetFullPath($ExpectedPath)
        startedAtUtc = $startedAtUtc
        writtenAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Read-ScribeFlowPidRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $record = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $expectedPath = [string]$record.expectedPath
        $startedAtUtc = if ($record.startedAtUtc -is [DateTime]) {
            ([DateTime]$record.startedAtUtc).ToUniversalTime()
        }
        else {
            [DateTimeOffset]::Parse(
                [string]$record.startedAtUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            ).UtcDateTime
        }
        if (
            [int]$record.schemaVersion -ne 1 -or
            [int64]$record.pid -le 0 -or
            [string]$record.kind -notmatch "^[A-Za-z0-9._-]+$" -or
            -not (Test-ScribeFlowAbsolutePath -Path $expectedPath)
        ) {
            return $null
        }
        return [pscustomobject]@{
            pid = [int]$record.pid
            kind = [string]$record.kind
            expectedPath = [IO.Path]::GetFullPath($expectedPath)
            startedAtUtc = $startedAtUtc
        }
    }
    catch {
        return $null
    }
}

function Test-ScribeFlowProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [object]$Record
    )

    try {
        $actualPath = [IO.Path]::GetFullPath($Process.Path)
        $expectedPath = [IO.Path]::GetFullPath([string]$Record.expectedPath)
        if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        $actualStart = $Process.StartTime.ToUniversalTime()
        $difference = [Math]::Abs(
            ($actualStart - [DateTime]$Record.startedAtUtc).TotalSeconds
        )
        return $difference -le 3
    }
    catch {
        return $false
    }
}

function Stop-ScribeFlowTrackedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PidFile,
        [int]$TimeoutMilliseconds = 8000
    )

    $record = Read-ScribeFlowPidRecord -Path $PidFile
    try {
        if (-not $record) {
            return $false
        }
        $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if (-not $process) {
            return $false
        }
        if (-not (Test-ScribeFlowProcessIdentity -Process $process -Record $record)) {
            return $false
        }
        Stop-Process -Id $record.pid -Force -ErrorAction Stop
        $null = $process.WaitForExit($TimeoutMilliseconds)
        return $true
    }
    finally {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$PidFile.new" -Force -ErrorAction SilentlyContinue
    }
}

function Remove-ScribeFlowPathWithRetry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Attempts = 6
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $lastError = ""
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $Path)) {
                return
            }
            throw "The path still exists."
        }
        catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt $Attempts) {
                Start-Sleep -Milliseconds ([Math]::Min(3000, 250 * [Math]::Pow(2, $attempt - 1)))
            }
        }
    }
    throw "Could not remove $Path after $Attempts attempts: $lastError"
}

function Test-ScribeFlowPayloadManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageRoot,
        [string]$ExpectedVersion = ""
    )

    $resolvedPackageRoot = [IO.Path]::GetFullPath($PackageRoot)
    $payloadRoot = Join-Path $resolvedPackageRoot "payload"
    $manifestPath = Join-Path $resolvedPackageRoot "package-manifest.json"
    if (
        -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $payloadRoot -PathType Container)
    ) {
        throw "The installer package is missing its payload manifest."
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "The installer payload manifest is invalid."
    }
    $manifestVersion = [string]$manifest.version
    if (
        [int]$manifest.schemaVersion -ne 2 -or
        $manifestVersion -notmatch "^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$" -or
        -not ($manifest.payloadFiles -is [System.Array]) -or
        $manifest.payloadFiles.Count -lt 1
    ) {
        throw "The installer payload manifest is invalid."
    }
    $normalizedExpectedVersion = $ExpectedVersion -replace "^[vV]", ""
    if ($ExpectedVersion -and $manifestVersion -ne $normalizedExpectedVersion) {
        throw "The downloaded payload version does not match the GitHub release tag."
    }

    $expected = @{}
    foreach ($entry in $manifest.payloadFiles) {
        $relativePath = [string]$entry.path
        $hash = ([string]$entry.sha256).ToUpperInvariant()
        $size = [int64]$entry.size
        if (
            -not $relativePath -or
            $relativePath.Contains("\") -or
            $relativePath.StartsWith("/") -or
            $relativePath -match "(^|/)\.\.?(/|$)" -or
            $hash -notmatch "^[A-F0-9]{64}$" -or
            $size -lt 0 -or
            $expected.ContainsKey($relativePath)
        ) {
            throw "The installer payload manifest contains an unsafe or duplicate file entry."
        }
        $expected[$relativePath] = $entry
    }

    $actualFiles = Get-ChildItem -LiteralPath $payloadRoot -File -Recurse
    if ($actualFiles.Count -ne $expected.Count) {
        throw "The installer payload file count does not match its signed manifest."
    }
    foreach ($file in $actualFiles) {
        $relativePath = $file.FullName.Substring($payloadRoot.Length).TrimStart("\", "/").Replace("\", "/")
        if (-not $expected.ContainsKey($relativePath)) {
            throw "The installer payload contains an unexpected file: $relativePath"
        }
        $entry = $expected[$relativePath]
        if ($file.Length -ne [int64]$entry.size) {
            throw "The installer payload size check failed for $relativePath"
        }
        $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        if ($actualHash -ne ([string]$entry.sha256).ToUpperInvariant()) {
            throw "The installer payload checksum failed for $relativePath"
        }
    }

    $versionPath = Join-Path $payloadRoot "app-version.json"
    try {
        $payloadVersion = [string](
            (Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json).version
        )
    }
    catch {
        throw "The payload version marker is invalid."
    }
    if ($payloadVersion -ne $manifestVersion) {
        throw "The payload version marker does not match its manifest."
    }
    return $manifest
}
