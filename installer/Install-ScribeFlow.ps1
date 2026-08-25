[CmdletBinding()]
param(
    [switch]$NoLaunch
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
$versionPath = Join-Path $payloadRoot "app-version.json"

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

function Invoke-WithRetry {
    param(
        [scriptblock]$Operation,
        [string]$Description,
        [int]$Attempts = 4
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            & $Operation
            return
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw "$Description failed after $Attempts attempts: $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds (500 * $attempt)
        }
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
    $versionPath,
    (Join-Path $payloadRoot "scripts\start-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\update-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\install-native-whisper.ps1"),
    (Join-Path $payloadRoot "scripts\whisper-release.json"),
    (Join-Path $payloadRoot "scripts\whisper-release-utils.mjs"),
    (Join-Path $payloadRoot "scripts\document-storage-utils.mjs"),
    (Join-Path $payloadRoot "scripts\library-sync-utils.mjs"),
    (Join-Path $payloadRoot "assets\ScribeFlow.ico"),
    (Join-Path $payloadRoot "dist\server\index.js"),
    (Join-Path $payloadRoot "dist\client")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "The installer payload is incomplete: $requiredPath"
    }
}

$appVersion = try {
    [string](
        (Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json).version
    )
}
catch {
    throw "The installer version information is invalid."
}
if ($appVersion -notmatch "^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$") {
    throw "The installer version information is invalid."
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
    Invoke-WithRetry -Description "Removing the previous rollback copy" `
        -Operation {
            Remove-Item -LiteralPath $backupRoot -Recurse -Force
        }
}
$hadPreviousInstall = Test-Path -LiteralPath $installRoot
if (Test-Path -LiteralPath $installRoot) {
    Invoke-WithRetry -Description "Preparing the installed app for upgrade" `
        -Operation {
            Move-Item -LiteralPath $installRoot -Destination $backupRoot
        }
}

try {
    Invoke-WithRetry -Description "Activating the new ScribeFlow version" `
        -Operation {
            Move-Item -LiteralPath $stagingRoot -Destination $installRoot
        }
    $installedVersionPath = Join-Path $installRoot "app-version.json"
    if (-not (Test-Path -LiteralPath $installedVersionPath -PathType Leaf)) {
        throw "The installed version marker is missing."
    }
    $verifiedInstalledVersion = [string](
        (Get-Content -LiteralPath $installedVersionPath -Raw |
            ConvertFrom-Json).version
    )
    if ($verifiedInstalledVersion -ne $appVersion) {
        throw "The installed version did not match the downloaded release."
    }

$installedLauncher = Join-Path $installRoot "Launch ScribeFlow.cmd"
$installedIcon = Join-Path $installRoot "assets\ScribeFlow.ico"
$shell = New-Object -ComObject WScript.Shell
$desktopShortcut = $shell.CreateShortcut(
    (Join-Path (Get-ScribeFlowDesktop) "ScribeFlow.lnk")
)
$desktopShortcut.TargetPath = $installedLauncher
$desktopShortcut.WorkingDirectory = $installRoot
$desktopShortcut.Description = "Local-only clinical dictation"
$desktopShortcut.IconLocation = "$installedIcon,0"
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
$startMenuShortcut.IconLocation = "$installedIcon,0"
$startMenuShortcut.Save()

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ScribeFlow"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name DisplayName -Value "ScribeFlow"
Set-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value $appVersion
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
}
catch {
    $installFailure = $_
    if (Test-Path -LiteralPath $installRoot) {
        Invoke-WithRetry -Description "Removing the incomplete installation" `
            -Operation {
                Remove-Item -LiteralPath $installRoot -Recurse -Force
            }
    }
    if ($hadPreviousInstall -and (Test-Path -LiteralPath $backupRoot)) {
        Invoke-WithRetry -Description "Restoring the previous ScribeFlow version" `
            -Operation {
                Move-Item -LiteralPath $backupRoot -Destination $installRoot
            }
        $restoredVersionPath = Join-Path $installRoot "app-version.json"
        if (Test-Path -LiteralPath $restoredVersionPath) {
            try {
                $restoredVersion = [string](
                    (Get-Content -LiteralPath $restoredVersionPath -Raw |
                        ConvertFrom-Json).version
                )
                Set-ItemProperty -Path $uninstallKey -Name DisplayVersion `
                    -Value $restoredVersion -ErrorAction SilentlyContinue
            }
            catch {
                # Restoring the app matters more than refreshing display metadata.
            }
        }
    }
    throw $installFailure
}

if (Test-Path -LiteralPath $backupRoot) {
    try {
        Invoke-WithRetry -Description "Removing the verified rollback copy" `
            -Operation {
                Remove-Item -LiteralPath $backupRoot -Recurse -Force
            }
    }
    catch {
        Write-Warning "ScribeFlow updated, but the rollback copy could not be removed."
    }
}

Write-Host ""
Write-Host "ScribeFlow was installed successfully." -ForegroundColor Green
Write-Host "Templates sync through Documents\ScribeFlow when the app opens."
Write-Host "Whisper is kept separately and can be installed inside ScribeFlow."
Write-Host "No notes, PDFs, audio, templates, or patient data were included."

if (-not $NoLaunch) {
    Start-Process -FilePath $installedLauncher
}
