[CmdletBinding()]
param(
    [switch]$Worker,
    [string]$InstallRoot = (
        Join-Path $env:LOCALAPPDATA "Programs\ScribeFlow"
    ),
    [switch]$RemoveSettings,
    [switch]$RemoveWhisper
)

$ErrorActionPreference = "Stop"
$settingsRoot = Join-Path $env:LOCALAPPDATA "ScribeFlow"
$runtimeStateRoot = Join-Path $settingsRoot "runtime"
$updatesRoot = Join-Path $settingsRoot "updates"
$nativeWhisperRoot = Join-Path $settingsRoot "native-whisper"
$programsRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:LOCALAPPDATA "Programs")
)
$resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$backupRoot = Join-Path $programsRoot "ScribeFlow.previous"
$stagingRoot = Join-Path $programsRoot "ScribeFlow.installing"

if (
    -not $resolvedInstallRoot.StartsWith(
        "$programsRoot$([IO.Path]::DirectorySeparatorChar)",
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    [IO.Path]::GetFileName($resolvedInstallRoot) -ne "ScribeFlow"
) {
    throw "The uninstaller refused an unsafe installation path."
}

if (-not $Worker) {
    $temporaryScript = Join-Path $env:TEMP (
        "ScribeFlow-uninstall-{0}.ps1" -f [Guid]::NewGuid().ToString("N")
    )
    Copy-Item -LiteralPath $PSCommandPath -Destination $temporaryScript
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$temporaryScript`"",
        "-Worker",
        "-InstallRoot", "`"$resolvedInstallRoot`""
    )
    if ($RemoveSettings) { $arguments += "-RemoveSettings" }
    if ($RemoveWhisper) { $arguments += "-RemoveWhisper" }
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments
    return
}

$lifecycleScript = Join-Path $resolvedInstallRoot `
    "scripts\scribeflow-lifecycle.ps1"
if (-not (Test-Path -LiteralPath $lifecycleScript -PathType Leaf)) {
    throw "The ScribeFlow uninstall helper is missing."
}
. $lifecycleScript

function Assert-SafeLocalDataPath {
    param([string]$Path)

    $resolvedSettingsRoot = [IO.Path]::GetFullPath($settingsRoot)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (
        -not $resolvedPath.Equals(
            $resolvedSettingsRoot,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        -not $resolvedPath.StartsWith(
            "$resolvedSettingsRoot$([IO.Path]::DirectorySeparatorChar)",
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "The uninstaller refused an unsafe local-data path."
    }
}

function Stop-LegacyOrTrackedProcess {
    param(
        [string]$PidFile,
        [string]$ExpectedPath = "",
        [string]$ExpectedRoot = ""
    )

    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
        return
    }
    $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($raw -notmatch "^\d+$") {
        $null = Stop-ScribeFlowTrackedProcess -PidFile $PidFile
        return
    }
    try {
        $process = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
        if (-not $process) { return }
        $actualPath = [IO.Path]::GetFullPath($process.Path)
        $matchesPath = $ExpectedPath -and $actualPath.Equals(
            [IO.Path]::GetFullPath($ExpectedPath),
            [StringComparison]::OrdinalIgnoreCase
        )
        $matchesRoot = $false
        if ($ExpectedRoot) {
            $resolvedRoot = [IO.Path]::GetFullPath($ExpectedRoot)
            $matchesRoot = $actualPath.StartsWith(
                "$resolvedRoot$([IO.Path]::DirectorySeparatorChar)",
                [StringComparison]::OrdinalIgnoreCase
            )
        }
        if ($matchesPath -or $matchesRoot) {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $null = $process.WaitForExit(8000)
        }
    }
    finally {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
}

$whisperMutex = $null
$lifecycleMutex = $null
try {
    # The Whisper installer owns this mutex during downloads and briefly takes
    # the lifecycle mutex for activation. Match that order so uninstall never
    # races a download or deadlocks an activation.
    $whisperMutex = Enter-ScribeFlowMutex `
        -Name $script:ScribeFlowWhisperMutexName `
        -Timeout ([TimeSpan]::FromSeconds(15))
    $lifecycleMutex = Enter-ScribeFlowMutex `
        -Name $script:ScribeFlowLifecycleMutexName `
        -Timeout ([TimeSpan]::FromMinutes(5))

    $installedNode = Join-Path $resolvedInstallRoot "runtime\node\node.exe"
    Stop-LegacyOrTrackedProcess `
        -PidFile (Join-Path $runtimeStateRoot "server.pid") `
        -ExpectedPath $installedNode
    Stop-LegacyOrTrackedProcess `
        -PidFile (Join-Path $runtimeStateRoot "model-server.pid") `
        -ExpectedPath $installedNode
    Stop-LegacyOrTrackedProcess `
        -PidFile (Join-Path $runtimeStateRoot "native-whisper\server.pid") `
        -ExpectedRoot $nativeWhisperRoot

    $desktopCandidates = @(
        [Environment]::GetFolderPath("Desktop"),
        (Join-Path $env:USERPROFILE "Desktop"),
        (Join-Path $env:USERPROFILE "OneDrive\Desktop")
    ) | Where-Object { $_ } | Select-Object -Unique
    foreach ($desktop in $desktopCandidates) {
        Remove-Item -LiteralPath (Join-Path $desktop "ScribeFlow.lnk") `
            -Force -ErrorAction SilentlyContinue
    }

    $startMenuFolder = Join-Path (
        [Environment]::GetFolderPath("StartMenu")
    ) "Programs\ScribeFlow"
    if (Test-Path -LiteralPath $startMenuFolder) {
        Remove-ScribeFlowPathWithRetry -Path $startMenuFolder
    }
    $startupFolder = [Environment]::GetFolderPath("Startup")
    if (-not $startupFolder) {
        $startupFolder = Join-Path $env:APPDATA `
            "Microsoft\Windows\Start Menu\Programs\Startup"
    }
    $startupShortcut = Join-Path $startupFolder "ScribeFlow Background.lnk"
    Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item `
        -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ScribeFlow" `
        -Recurse -Force -ErrorAction SilentlyContinue

    foreach ($appPath in @($resolvedInstallRoot, $stagingRoot, $backupRoot)) {
        if (Test-Path -LiteralPath $appPath) {
            Remove-ScribeFlowPathWithRetry -Path $appPath
        }
    }

    # Runtime logs and downloaded update packages cannot be used without the
    # app and may be large, so they are always cleaned up on uninstall.
    foreach ($localPath in @($runtimeStateRoot, $updatesRoot)) {
        Assert-SafeLocalDataPath -Path $localPath
        if (Test-Path -LiteralPath $localPath) {
            Remove-ScribeFlowPathWithRetry -Path $localPath
        }
    }

    if ($RemoveWhisper) {
        Assert-SafeLocalDataPath -Path $nativeWhisperRoot
        if (Test-Path -LiteralPath $nativeWhisperRoot) {
            Remove-ScribeFlowPathWithRetry -Path $nativeWhisperRoot
        }
    }

    if ($RemoveSettings -and (Test-Path -LiteralPath $settingsRoot)) {
        Assert-SafeLocalDataPath -Path $settingsRoot
        if ($RemoveWhisper) {
            Remove-ScribeFlowPathWithRetry -Path $settingsRoot
        }
        else {
            Get-ChildItem -LiteralPath $settingsRoot -Force |
                Where-Object { $_.Name -ne "native-whisper" } |
                ForEach-Object {
                    Remove-ScribeFlowPathWithRetry -Path $_.FullName
                }
        }
    }
}
finally {
    Exit-ScribeFlowMutex -Mutex $lifecycleMutex
    Exit-ScribeFlowMutex -Mutex $whisperMutex
}

Write-Host "ScribeFlow was uninstalled." -ForegroundColor Green
Write-Host "Documents\ScribeFlow was preserved."
if (-not $RemoveWhisper -and (Test-Path -LiteralPath $nativeWhisperRoot)) {
    Write-Host "The separately downloaded Whisper model was preserved."
}
if (-not $RemoveSettings) {
    Write-Host "Local preferences were preserved in $settingsRoot"
}
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
