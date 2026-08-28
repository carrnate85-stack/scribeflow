[CmdletBinding()]
param(
    [switch]$Worker,
    [string]$InstallRoot = (
        Join-Path $env:LOCALAPPDATA "Programs\ScribeFlow"
    ),
    [switch]$RemoveSettings
)

$ErrorActionPreference = "Stop"
$settingsRoot = Join-Path $env:LOCALAPPDATA "ScribeFlow"
$runtimeStateRoot = Join-Path $settingsRoot "runtime"
$programsRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:LOCALAPPDATA "Programs")
)
$resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)

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
    if ($RemoveSettings) {
        $arguments += "-RemoveSettings"
    }
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments
    exit 0
}

function Stop-ScribeFlowProcess {
    param([string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile)) {
        return
    }
    try {
        $processId = [int](Get-Content -LiteralPath $PidFile -Raw)
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    catch {
        # Ignore stale process identifiers.
    }
}

Stop-ScribeFlowProcess -PidFile (Join-Path $runtimeStateRoot "server.pid")
Stop-ScribeFlowProcess -PidFile (Join-Path $runtimeStateRoot "model-server.pid")
Stop-ScribeFlowProcess -PidFile (
    Join-Path $runtimeStateRoot "native-whisper\server.pid"
)
Start-Sleep -Milliseconds 700

$desktopShortcut = Join-Path (
    [Environment]::GetFolderPath("Desktop")
) "ScribeFlow.lnk"
$startMenuFolder = Join-Path (
    [Environment]::GetFolderPath("StartMenu")
) "Programs\ScribeFlow"
$startupFolder = [Environment]::GetFolderPath("Startup")
if (-not $startupFolder) {
    $startupFolder = Join-Path $env:APPDATA `
        "Microsoft\Windows\Start Menu\Programs\Startup"
}
$startupShortcut = Join-Path $startupFolder "ScribeFlow Background.lnk"
Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startMenuFolder -Recurse -Force `
    -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
Remove-Item `
    -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ScribeFlow" `
    -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force

if ($RemoveSettings -and (Test-Path -LiteralPath $settingsRoot)) {
    Remove-Item -LiteralPath $settingsRoot -Recurse -Force
}

Write-Host "ScribeFlow was uninstalled." -ForegroundColor Green
if (-not $RemoveSettings) {
    Write-Host "Templates and local settings were preserved in $settingsRoot"
}
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
