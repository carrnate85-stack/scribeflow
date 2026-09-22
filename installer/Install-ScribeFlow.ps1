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
$installLogPath = Join-Path $runtimeStateRoot "install.log"
$installTransactionPath = Join-Path $runtimeStateRoot "install-transaction.json"
$installTransactionTempPath = "$installTransactionPath.writing"
$lifecycleScript = Join-Path $payloadRoot "scripts\scribeflow-lifecycle.ps1"
$nodePath = Join-Path $payloadRoot "runtime\node\node.exe"
$launcherPath = Join-Path $payloadRoot "Launch ScribeFlow.cmd"
$versionPath = Join-Path $payloadRoot "app-version.json"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ScribeFlow"
$lifecycleMutex = $null
$hadPreviousInstall = $false
$activatedNewInstall = $false
$installationSucceeded = $false

function Write-InstallLog {
    param([string]$Message)

    New-Item -ItemType Directory -Path $runtimeStateRoot -Force | Out-Null
    Add-Content -LiteralPath $installLogPath -Value (
        "[{0}] {1}" -f (Get-Date).ToString("o"), $Message
    ) -Encoding UTF8
}

function Set-ScribeFlowInstallTransaction {
    param(
        [string]$Version,
        [bool]$HadPreviousInstall
    )

    New-Item -ItemType Directory -Path $runtimeStateRoot -Force | Out-Null
    [ordered]@{
        schemaVersion = 1
        version = $Version
        hadPreviousInstall = $HadPreviousInstall
        state = "pending-health-verification"
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $installTransactionTempPath -Encoding UTF8
    Move-Item `
        -LiteralPath $installTransactionTempPath `
        -Destination $installTransactionPath `
        -Force
}

function Clear-ScribeFlowInstallTransaction {
    Remove-Item `
        -LiteralPath $installTransactionPath, $installTransactionTempPath `
        -Force `
        -ErrorAction SilentlyContinue
}

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

function Stop-ScribeFlowService {
    param(
        [string]$PidFile,
        [string]$LegacyExpectedPath = "",
        [string]$LegacyExpectedRoot = ""
    )

    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
        return
    }
    $rawPid = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($rawPid -match "^\d+$") {
        try {
            $process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
            if ($process) {
                $actualPath = [IO.Path]::GetFullPath($process.Path)
                $matchesPath = $LegacyExpectedPath -and $actualPath.Equals(
                    [IO.Path]::GetFullPath($LegacyExpectedPath),
                    [StringComparison]::OrdinalIgnoreCase
                )
                $matchesRoot = $false
                if ($LegacyExpectedRoot) {
                    $resolvedRoot = [IO.Path]::GetFullPath($LegacyExpectedRoot)
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
        }
        catch {
            Write-InstallLog "Could not stop a verified legacy service: $($_.Exception.Message)"
        }
        finally {
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        }
        return
    }
    $null = Stop-ScribeFlowTrackedProcess -PidFile $PidFile
}

function Test-InstalledScribeFlowHealth {
    param(
        [string]$ExpectedVersion,
        [int]$TimeoutSeconds = 55
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod `
                -Uri "http://127.0.0.1:3000/__health" `
                -TimeoutSec 3
            if (
                $response.ready -eq $true -and
                [string]$response.service -eq "ScribeFlow" -and
                [string]$response.version -eq $ExpectedVersion
            ) {
                $page = Invoke-WebRequest `
                    -Uri "http://127.0.0.1:3000/" `
                    -UseBasicParsing `
                    -TimeoutSec 4
                if ($page.StatusCode -eq 200 -and $page.Content -match "ScribeFlow") {
                    return $true
                }
            }
        }
        catch {
            # The new service may still be starting.
        }
        Start-Sleep -Milliseconds 500
    }
    while ((Get-Date) -lt $deadline)
    return $false
}

function New-ScribeFlowShortcut {
    param(
        [object]$Shell,
        [string]$Path,
        [string]$TargetPath,
        [string]$WorkingDirectory,
        [string]$Description,
        [string]$IconLocation,
        [string]$Arguments = ""
    )

    $shortcut = $Shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.IconLocation = "$IconLocation,0"
    if ($Arguments) {
        $shortcut.Arguments = $Arguments
    }
    $shortcut.Save()
}

function Invoke-ScribeFlowBestEffortShellIntegration {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Operation
    )

    try {
        & $Operation
        try {
            Write-InstallLog "Configured $Name."
        }
        catch {
            # Shell integration already succeeded; logging must not undo it.
        }
    }
    catch {
        $integrationFailure = $_.Exception.Message
        try {
            Write-Warning (
                (
                    "ScribeFlow installed successfully, but Windows would not allow {0}. " +
                    "The app remains available at http://127.0.0.1:3000."
                ) -f $Name
            ) -WarningAction Continue
        }
        catch {
            # A host that rejects warnings must not make integration fatal.
        }
        try {
            Write-InstallLog "$Name failed: $integrationFailure"
        }
        catch {
            # Optional Windows integration and its logging are both best-effort.
        }
    }
}

foreach ($requiredPath in @(
    $payloadRoot,
    $nodePath,
    $launcherPath,
    $versionPath,
    $lifecycleScript,
    (Join-Path $packageRoot "package-manifest.json"),
    (Join-Path $payloadRoot "scripts\start-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\update-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\launch-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\uninstall-scribeflow.ps1"),
    (Join-Path $payloadRoot "scripts\install-native-whisper.ps1"),
    (Join-Path $payloadRoot "scripts\whisper-release.json"),
    (Join-Path $payloadRoot "scripts\whisper-release-utils.mjs"),
    (Join-Path $payloadRoot "scripts\library-sync-utils.mjs"),
    (Join-Path $payloadRoot "assets\ScribeFlow.ico"),
    (Join-Path $payloadRoot "dist\server\index.js"),
    (Join-Path $payloadRoot "dist\client")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "The installer payload is incomplete: $requiredPath"
    }
}

. $lifecycleScript
$manifest = Test-ScribeFlowPayloadManifest -PackageRoot $packageRoot
$appVersion = [string]$manifest.version

Assert-SafeInstallPath -Path $installRoot
Assert-SafeInstallPath -Path $stagingRoot
Assert-SafeInstallPath -Path $backupRoot

try {
    $lifecycleMutex = Enter-ScribeFlowMutex `
        -Name $script:ScribeFlowLifecycleMutexName `
        -Timeout ([TimeSpan]::FromMinutes(8))
    Write-InstallLog "Beginning verified installation of ScribeFlow $appVersion."
    New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null

    $installedNode = Join-Path $installRoot "runtime\node\node.exe"
    $nativeWhisperRoot = Join-Path $settingsRoot "native-whisper"
    Stop-ScribeFlowService `
        -PidFile (Join-Path $runtimeStateRoot "server.pid") `
        -LegacyExpectedPath $installedNode
    Stop-ScribeFlowService `
        -PidFile (Join-Path $runtimeStateRoot "model-server.pid") `
        -LegacyExpectedPath $installedNode
    Stop-ScribeFlowService `
        -PidFile (Join-Path $runtimeStateRoot "native-whisper\server.pid") `
        -LegacyExpectedRoot $nativeWhisperRoot

    # An activated version is not trusted until its loopback health check has
    # completed. If power was lost at any point in that window, restore the
    # rollback copy before another update is allowed to replace it.
    $transactionSource = if (Test-Path -LiteralPath $installTransactionPath) {
        $installTransactionPath
    }
    elseif (Test-Path -LiteralPath $installTransactionTempPath) {
        $installTransactionTempPath
    }
    else {
        $null
    }
    if ($transactionSource) {
        $pendingHadPreviousInstall = Test-Path `
            -LiteralPath $backupRoot `
            -PathType Container
        try {
            $pendingTransaction = Get-Content `
                -LiteralPath $transactionSource `
                -Raw |
                ConvertFrom-Json
            if ($null -ne $pendingTransaction.hadPreviousInstall) {
                $pendingHadPreviousInstall = [bool]$pendingTransaction.hadPreviousInstall
            }
        }
        catch {
            Write-InstallLog "The interrupted-install marker was damaged; recovery will use the available rollback copy."
        }

        if (Test-Path -LiteralPath $installRoot) {
            Remove-ScribeFlowPathWithRetry -Path $installRoot
        }
        if (Test-Path -LiteralPath $backupRoot -PathType Container) {
            Move-Item -LiteralPath $backupRoot -Destination $installRoot
            Write-InstallLog "Restored the last-known-good installation after an interrupted unverified activation."
        }
        elseif ($pendingHadPreviousInstall) {
            Write-InstallLog "The interrupted activation had no rollback copy; reinstalling from the verified package."
        }
        else {
            Write-InstallLog "Removed an interrupted first installation before retrying."
        }
        Clear-ScribeFlowInstallTransaction
    }
    elseif (
        -not (Test-Path -LiteralPath $installRoot) -and
        (Test-Path -LiteralPath $backupRoot -PathType Container)
    ) {
        # Transition support for installations created before transaction
        # markers were introduced.
        Move-Item -LiteralPath $backupRoot -Destination $installRoot
        Write-InstallLog "Recovered the last-known-good installation after an interrupted update."
    }
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-ScribeFlowPathWithRetry -Path $stagingRoot
    }

    Write-Host "Installing ScribeFlow locally..." -ForegroundColor Cyan
    Copy-Item -LiteralPath $payloadRoot -Destination $stagingRoot -Recurse -Force
    $stagedVersion = [string](
        (Get-Content -LiteralPath (Join-Path $stagingRoot "app-version.json") -Raw |
            ConvertFrom-Json).version
    )
    if ($stagedVersion -ne $appVersion) {
        throw "The staged application version did not match the verified package."
    }

    $hadPreviousInstall = Test-Path -LiteralPath $installRoot -PathType Container
    if (Test-Path -LiteralPath $backupRoot) {
        Remove-ScribeFlowPathWithRetry -Path $backupRoot
    }
    if ($hadPreviousInstall) {
        Move-Item -LiteralPath $installRoot -Destination $backupRoot
        Write-InstallLog "Saved the prior installation as the last-known-good rollback copy."
    }
    Set-ScribeFlowInstallTransaction `
        -Version $appVersion `
        -HadPreviousInstall $hadPreviousInstall
    Move-Item -LiteralPath $stagingRoot -Destination $installRoot
    $activatedNewInstall = $true

    $verifiedInstalledVersion = [string](
        (Get-Content -LiteralPath (Join-Path $installRoot "app-version.json") -Raw |
            ConvertFrom-Json).version
    )
    if ($verifiedInstalledVersion -ne $appVersion) {
        throw "The installed version did not match the downloaded release."
    }

    $installedLauncher = Join-Path $installRoot "Launch ScribeFlow.cmd"
    $installedStartScript = Join-Path $installRoot "scripts\start-scribeflow.ps1"
    $installedPowerShell = Join-Path $env:SystemRoot `
        "System32\WindowsPowerShell\v1.0\powershell.exe"
    $installedIcon = Join-Path $installRoot "assets\ScribeFlow.ico"

    # A file swap alone is not success. Start the exact installed payload and
    # keep the rollback copy until its real loopback endpoint is healthy.
    & (Join-Path $installRoot "scripts\launch-scribeflow.ps1") `
        -NoBrowser `
        -SkipLifecycleLock `
        -SkipNativeWhisperStart `
        -ExpectedVersion $appVersion
    if (-not (Test-InstalledScribeFlowHealth -ExpectedVersion $appVersion)) {
        throw "The new ScribeFlow version did not pass its local startup health check."
    }

    Clear-ScribeFlowInstallTransaction
    $installationSucceeded = $true
    Write-InstallLog "ScribeFlow $appVersion passed its loopback health check."

    # Windows shell metadata is created only after the installed app is proven
    # healthy. Each operation is independent and optional: folder redirection,
    # registry policy, or COM restrictions must not roll back a working app.
    Invoke-ScribeFlowBestEffortShellIntegration `
        -Name "the Start menu shortcut" `
        -Operation {
            $startMenuRoot = [Environment]::GetFolderPath("StartMenu")
            if (-not $startMenuRoot) {
                throw "Windows did not report a Start menu folder."
            }
            $startMenuFolder = Join-Path $startMenuRoot "Programs\ScribeFlow"
            New-Item -ItemType Directory -Path $startMenuFolder -Force |
                Out-Null
            $shell = New-Object -ComObject WScript.Shell
            New-ScribeFlowShortcut `
                -Shell $shell `
                -Path (Join-Path $startMenuFolder "ScribeFlow.lnk") `
                -TargetPath $installedPowerShell `
                -WorkingDirectory $installRoot `
                -Description "Private local clinical documentation" `
                -IconLocation $installedIcon `
                -Arguments ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $installedStartScript)
        }

    Invoke-ScribeFlowBestEffortShellIntegration `
        -Name "the optional Desktop shortcut" `
        -Operation {
            $desktopRoot = [Environment]::GetFolderPath("Desktop")
            if (-not $desktopRoot) {
                throw "Windows did not report a Desktop folder."
            }
            $shell = New-Object -ComObject WScript.Shell
            New-ScribeFlowShortcut `
                -Shell $shell `
                -Path (Join-Path $desktopRoot "ScribeFlow.lnk") `
                -TargetPath $installedPowerShell `
                -WorkingDirectory $installRoot `
                -Description "Private local clinical documentation" `
                -IconLocation $installedIcon `
                -Arguments ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $installedStartScript)
        }

    Invoke-ScribeFlowBestEffortShellIntegration `
        -Name "the Windows startup shortcut" `
        -Operation {
            $startupFolder = [Environment]::GetFolderPath("Startup")
            if (-not $startupFolder) {
                $startupFolder = Join-Path $env:APPDATA `
                    "Microsoft\Windows\Start Menu\Programs\Startup"
            }
            New-Item -ItemType Directory -Path $startupFolder -Force |
                Out-Null
            $shell = New-Object -ComObject WScript.Shell
            New-ScribeFlowShortcut `
                -Shell $shell `
                -Path (Join-Path $startupFolder "ScribeFlow Background.lnk") `
                -TargetPath (Join-Path $env:SystemRoot `
                    "System32\WindowsPowerShell\v1.0\powershell.exe") `
                -WorkingDirectory $installRoot `
                -Description "Start ScribeFlow locally without opening a browser" `
                -IconLocation $installedIcon `
                -Arguments ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NoBrowser' -f (
                    Join-Path $installRoot "scripts\launch-scribeflow.ps1"
                ))
        }

    Invoke-ScribeFlowBestEffortShellIntegration `
        -Name "the Windows uninstall registration" `
        -Operation {
            New-Item -Path $uninstallKey -Force | Out-Null
            Set-ItemProperty -Path $uninstallKey -Name DisplayName `
                -Value "ScribeFlow"
            Set-ItemProperty -Path $uninstallKey -Name DisplayVersion `
                -Value $appVersion
            Set-ItemProperty -Path $uninstallKey -Name Publisher `
                -Value "ScribeFlow"
            Set-ItemProperty -Path $uninstallKey -Name InstallLocation `
                -Value $installRoot
            Set-ItemProperty -Path $uninstallKey -Name UninstallString -Value (
                'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (
                    Join-Path $installRoot "scripts\uninstall-scribeflow.ps1"
                )
            )
            New-ItemProperty -Path $uninstallKey -Name NoModify `
                -PropertyType DWord -Value 1 -Force | Out-Null
            New-ItemProperty -Path $uninstallKey -Name NoRepair `
                -PropertyType DWord -Value 1 -Force | Out-Null
        }
}
catch {
    $installFailure = $_
    Write-InstallLog "Installation failed: $($_.Exception.Message)"
    if ($activatedNewInstall) {
        Stop-ScribeFlowService -PidFile (Join-Path $runtimeStateRoot "server.pid")
        Stop-ScribeFlowService -PidFile (Join-Path $runtimeStateRoot "model-server.pid")
        Stop-ScribeFlowService -PidFile (
            Join-Path $runtimeStateRoot "native-whisper\server.pid"
        )
        if (Test-Path -LiteralPath $installRoot) {
            Remove-ScribeFlowPathWithRetry -Path $installRoot
        }
    }
    if ($hadPreviousInstall -and (Test-Path -LiteralPath $backupRoot)) {
        Move-Item -LiteralPath $backupRoot -Destination $installRoot
        Write-InstallLog "Restored the previous ScribeFlow version after failure."
        try {
            $restoredVersion = [string](
                (Get-Content -LiteralPath (Join-Path $installRoot "app-version.json") -Raw |
                    ConvertFrom-Json).version
            )
            Set-ItemProperty -Path $uninstallKey -Name DisplayVersion `
                -Value $restoredVersion -ErrorAction SilentlyContinue
        }
        catch {
            # The files are restored even if Windows display metadata is stale.
        }
    }
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-ScribeFlowPathWithRetry -Path $stagingRoot
    }
    if (
        (-not $hadPreviousInstall -and -not (Test-Path -LiteralPath $installRoot)) -or
        ($hadPreviousInstall -and (Test-Path -LiteralPath $installRoot))
    ) {
        Clear-ScribeFlowInstallTransaction
    }
    throw $installFailure
}
finally {
    Exit-ScribeFlowMutex -Mutex $lifecycleMutex
}

if (-not $installationSucceeded) {
    throw "ScribeFlow installation did not complete."
}

Write-Host ""
Write-Host "ScribeFlow was installed successfully." -ForegroundColor Green
Write-Host "Templates sync through Documents\ScribeFlow when the app opens."
Write-Host "Whisper is kept separately and can be installed inside ScribeFlow."
Write-Host "The last working app version is retained for automatic rollback."
Write-Host "No notes, PDFs, audio, templates, or patient data were included."
Write-Host "ScribeFlow will start silently at Windows sign-in."
Write-Host "Bookmark http://127.0.0.1:3000 to open it in your browser."

if (-not $NoLaunch) {
    Start-Process -FilePath $installedLauncher
}
