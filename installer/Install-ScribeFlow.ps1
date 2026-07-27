[CmdletBinding()]
param(
    [switch]$NoLaunch,
    [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$packageRoot = $PSScriptRoot
$payloadRoot = Join-Path $packageRoot "payload"
$programsRoot = Join-Path $env:LOCALAPPDATA "Programs"
$installRoot = Join-Path $programsRoot "ScribeFlow"
$stagingRoot = Join-Path $programsRoot "ScribeFlow.installing"
$backupRoot = Join-Path $programsRoot "ScribeFlow.previous"
$settingsRoot = Join-Path $env:LOCALAPPDATA "ScribeFlow"
$runtimeStateRoot = Join-Path $settingsRoot "runtime"
$nodePath = Join-Path $payloadRoot "runtime\node\node.exe"
$launcherPath = Join-Path $payloadRoot "Launch ScribeFlow.cmd"
$modelInstallerPath = Join-Path $payloadRoot "scripts\install-native-whisper.ps1"

function Assert-SafeInstallPath {
    param([string]$Path)

    $resolvedProgramsRoot = [IO.Path]::GetFullPath($programsRoot)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (
        -not $resolvedPath.StartsWith(
            "$resolvedProgramsRoot$([IO.Path]::DirectorySeparatorChar)",
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [IO.Path]::GetFileName($resolvedPath) -notin @(
            "ScribeFlow",
            "ScribeFlow.installing",
            "ScribeFlow.previous"
        )
    ) {
        throw "The installer refused an unsafe destination path."
    }
}

function Stop-ScribeFlowProcess {
    param([string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile)) {
        return
    }
    try {
        $processId = [int](Get-Content -LiteralPath $PidFile -Raw)
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $processId -Force
            $process.WaitForExit(5000)
        }
    }
    catch {
        # A stale PID file must not prevent an otherwise safe upgrade.
    }
}

function Get-ScribeFlowDesktop {
    $knownDesktop = [Environment]::GetFolderPath("Desktop")
    $candidates = @(
        $knownDesktop,
        (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
        (Join-Path $env:USERPROFILE "Desktop")
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }

    throw "Windows Desktop folder could not be located."
}

foreach ($requiredPath in @(
    $payloadRoot,
    $nodePath,
    $launcherPath,
    $modelInstallerPath,
    (Join-Path $payloadRoot "dist\server\index.js"),
    (Join-Path $payloadRoot "dist\client")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "The installer payload is incomplete: $requiredPath"
    }
}

Assert-SafeInstallPath -Path $installRoot
Assert-SafeInstallPath -Path $stagingRoot
Assert-SafeInstallPath -Path $backupRoot

Stop-ScribeFlowProcess -PidFile (Join-Path $runtimeStateRoot "server.pid")
Stop-ScribeFlowProcess -PidFile (Join-Path $runtimeStateRoot "model-server.pid")
Stop-ScribeFlowProcess -PidFile (
    Join-Path $runtimeStateRoot "native-whisper\server.pid"
)
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

Write-Host "Installing ScribeFlow locally..." -ForegroundColor Cyan
Copy-Item -LiteralPath $payloadRoot -Destination $stagingRoot -Recurse -Force

if (Test-Path -LiteralPath $backupRoot) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
}
if (Test-Path -LiteralPath $installRoot) {
    Move-Item -LiteralPath $installRoot -Destination $backupRoot
}
Move-Item -LiteralPath $stagingRoot -Destination $installRoot
if (Test-Path -LiteralPath $backupRoot) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
}

$installedLauncher = Join-Path $installRoot "Launch ScribeFlow.cmd"
$shell = New-Object -ComObject WScript.Shell
$desktopShortcut = $shell.CreateShortcut(
    (Join-Path (Get-ScribeFlowDesktop) "ScribeFlow.lnk")
)
$desktopShortcut.TargetPath = $installedLauncher
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Local-only clinical dictation"
$desktopShortcut.Save()

$startMenuFolder = Join-Path (
    [Environment]::GetFolderPath("StartMenu")
) "Programs\ScribeFlow"
New-Item -ItemType Directory -Path $startMenuFolder -Force | Out-Null
$startMenuShortcut = $shell.CreateShortcut(
    (Join-Path $startMenuFolder "ScribeFlow.lnk")
)
$startMenuShortcut.TargetPath = $installedLauncher
$startMenuShortcut.WorkingDirectory = $installRoot
$startMenuShortcut.Description = "Local-only clinical dictation"
$startMenuShortcut.Save()

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ScribeFlow"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name DisplayName -Value "ScribeFlow"
Set-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value "0.1.0"
Set-ItemProperty -Path $uninstallKey -Name Publisher -Value "ScribeFlow"
Set-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $installRoot
Set-ItemProperty -Path $uninstallKey -Name UninstallString -Value (
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (
        Join-Path $installRoot "scripts\uninstall-scribeflow.ps1"
    )
)
New-ItemProperty -Path $uninstallKey -Name NoModify -PropertyType DWord `
    -Value 1 -Force | Out-Null
New-ItemProperty -Path $uninstallKey -Name NoRepair -PropertyType DWord `
    -Value 1 -Force | Out-Null

if (-not $SkipModelDownload) {
    Write-Host ""
    Write-Host "Installing the verified local speech model..." -ForegroundColor Cyan
    & powershell.exe `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File (Join-Path $installRoot "scripts\install-native-whisper.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "ScribeFlow was copied, but the local speech model could not be installed. Run scripts\install-native-whisper.ps1 to retry."
    }
}

Write-Host ""
Write-Host "ScribeFlow was installed successfully." -ForegroundColor Green
Write-Host "Templates remain protected in $settingsRoot"
Write-Host "No notes, PDFs, audio, templates, or patient data were included."

if (-not $NoLaunch -and -not $SkipModelDownload) {
    Start-Process -FilePath $installedLauncher
}
