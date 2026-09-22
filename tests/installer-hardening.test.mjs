import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("uses one lifecycle lock and identity-checked structured PID records", async () => {
  const lifecycle = await source("../scripts/scribeflow-lifecycle.ps1");
  const launcher = await source("../scripts/launch-scribeflow.ps1");
  const installer = await source("../installer/Install-ScribeFlow.ps1");
  const uninstaller = await source("../scripts/uninstall-scribeflow.ps1");

  assert.match(lifecycle, /Local\\ScribeFlowLifecycle/);
  assert.match(lifecycle, /Local\\ScribeFlowWhisper/);
  assert.match(lifecycle, /schemaVersion = 1/);
  assert.match(lifecycle, /expectedPath = \[IO\.Path\]::GetFullPath/);
  assert.match(lifecycle, /startedAtUtc/);
  assert.match(lifecycle, /Test-ScribeFlowProcessIdentity/);
  assert.match(lifecycle, /actualPath\.Equals\(\$expectedPath/);
  assert.match(lifecycle, /TotalSeconds/);
  assert.match(lifecycle, /Remove-Item -LiteralPath \$PidFile/);
  assert.match(launcher, /Write-ScribeFlowPidRecord/);
  assert.match(installer, /Enter-ScribeFlowMutex/);
  assert.match(uninstaller, /Enter-ScribeFlowMutex/);
});

test("builds and verifies a complete version-bound payload manifest", async () => {
  const builder = await source("../scripts/build-portable-installer.ps1");
  const lifecycle = await source("../scripts/scribeflow-lifecycle.ps1");
  const installer = await source("../installer/Install-ScribeFlow.ps1");
  const updater = await source("../scripts/update-scribeflow.ps1");

  assert.match(builder, /schemaVersion = 2/);
  assert.match(builder, /payloadFiles = \$payloadFiles/);
  assert.match(builder, /Get-ChildItem -LiteralPath \$payloadRoot -File -Recurse/);
  assert.match(builder, /Get-FileHash[\s\S]*-Algorithm SHA256/);
  assert.match(lifecycle, /actualFiles\.Count -ne \$expected\.Count/);
  assert.match(lifecycle, /unexpected file/);
  assert.match(lifecycle, /payload checksum failed/);
  assert.match(lifecycle, /payload version marker does not match its manifest/);
  assert.ok(
    installer.indexOf("Test-ScribeFlowPayloadManifest") <
      installer.indexOf("Copy-Item -LiteralPath $payloadRoot"),
  );
  assert.match(updater, /-ExpectedVersion \$latestVersionText/);
  assert.match(updater, /did not match the GitHub release tag/);
});

test("retains last-known-good until loopback health succeeds and can roll back", async () => {
  const installer = await source("../installer/Install-ScribeFlow.ps1");
  const launcher = await source("../scripts/launch-scribeflow.ps1");
  const webServer = await source("../scripts/portable-web-server.mjs");

  assert.match(installer, /ScribeFlow\.previous/);
  assert.match(installer, /last-known-good rollback copy/);
  assert.match(installer, /Test-InstalledScribeFlowHealth/);
  assert.match(installer, /127\.0\.0\.1:3000\/__health/);
  assert.match(installer, /Move-Item -LiteralPath \$backupRoot -Destination \$installRoot/);
  assert.match(installer, /Restored the previous ScribeFlow version after failure/);
  assert.match(installer, /install-transaction\.json/);
  assert.match(installer, /pending-health-verification/);
  assert.match(
    installer,
    /interrupted unverified activation/,
  );
  assert.ok(
    installer.lastIndexOf("Set-ScribeFlowInstallTransaction") <
      installer.indexOf("Move-Item -LiteralPath $stagingRoot -Destination $installRoot"),
  );
  assert.ok(
    installer.indexOf("Test-InstalledScribeFlowHealth -ExpectedVersion $appVersion") <
      installer.lastIndexOf("Clear-ScribeFlowInstallTransaction"),
  );
  assert.doesNotMatch(installer, /Removing the verified rollback copy/);
  assert.match(launcher, /-RequiredVersion \$ExpectedVersion/);
  assert.match(launcher, /function Restore-PendingScribeFlowInstall/);
  assert.match(launcher, /ScribeFlow\.unverified/);
  assert.match(launcher, /last verified version after an interrupted update/);
  assert.match(launcher, /unverified app will not open/);
  assert.doesNotMatch(launcher, /Set-Location -LiteralPath \$projectRoot/);
  assert.match(webServer, /url\.pathname === "\/__health"/);
  assert.match(webServer, /service: "ScribeFlow"/);
  assert.match(webServer, /version: appVersion/);
});

test("captures installer output and retains exactly one successful update archive", async () => {
  const updater = await source("../scripts/update-scribeflow.ps1");

  assert.match(updater, /RedirectStandardOutput \$stdoutPath/);
  assert.match(updater, /RedirectStandardError \$stderrPath/);
  const installerLaunch = updater.match(/\$process = Start-Process[\s\S]*?-PassThru/)?.[0];
  assert.ok(installerLaunch);
  assert.doesNotMatch(installerLaunch, /-Wait\b/);
  assert.match(updater, /\$process\.WaitForExit\(600000\)/);
  assert.match(updater, /\$null -ne \$exitCode -and \$exitCode -ne 0/);
  assert.match(updater, /installed version and loopback health/);
  assert.match(updater, /installerExitCode/);
  assert.match(updater, /Add-InstallerOutputToLog/);
  assert.match(updater, /Prune-ScribeFlowUpdateCache -KeepPath \$releaseRoot/);
  assert.match(updater, /Get-ScribeFlowVerifiedCachePath/);
  assert.match(
    updater,
    /latestVersion -le \$currentVersion[\s\S]*Prune-ScribeFlowUpdateCache -KeepPath \$verifiedCache/,
  );
  assert.match(updater, /no verified current repair archive was present/);
  assert.match(updater, /Remove-ScribeFlowUpdateDirectory -Path \$packageRoot/);
  assert.match(updater, /Removed old update cache/);
  assert.match(updater, /Keep exactly one verified archive/);
  assert.match(updater, /--continue-at/);
  assert.match(updater, /--max-time/);
  assert.match(updater, /http:\/\/127\.0\.0\.1:3000\/__health/);
});

test("uses Windows Known Documents and never silently prefers personal OneDrive", async () => {
  const launcher = await source("../scripts/launch-scribeflow.ps1");

  const knownDocuments = launcher.indexOf('GetFolderPath("MyDocuments")');
  const commercial = launcher.indexOf("$env:OneDriveCommercial");
  const consumer = launcher.indexOf("$env:OneDriveConsumer");
  assert.ok(knownDocuments >= 0);
  assert.ok(commercial > knownDocuments);
  assert.ok(consumer > commercial);
  assert.match(launcher, /storage-location\.json/);
  assert.match(launcher, /Save-ScribeFlowDocumentsSelection/);
  assert.match(launcher, /ScribeFlow shared library: \$documentsRoot/);
  assert.doesNotMatch(launcher, /Join-Path \$documentsRoot "Notes"/);
  assert.match(launcher, /\$env:SCRIBEFLOW_DOCUMENTS_ROOT = \$documentsRoot/);
});

test("coordinates Whisper separately and records resumable status and work", async () => {
  const whisper = await source("../scripts/install-native-whisper.ps1");
  const launcher = await source("../scripts/launch-scribeflow.ps1");
  const modelServer = await source("../scripts/local-model-server.mjs");

  assert.match(whisper, /ScribeFlowWhisperMutexName/);
  assert.match(whisper, /ScribeFlowLifecycleMutexName/);
  assert.match(whisper, /whisper-status\.json/);
  assert.match(whisper, /\$workRoot = Join-Path \(Join-Path \$nativeRoot "work"\)/);
  assert.match(whisper, /--continue-at/);
  assert.match(whisper, /runtime\.installing/);
  assert.match(whisper, /runtimeDirectoryName/);
  assert.match(whisper, /runtimeServerRelativePath/);
  assert.match(whisper, /modelStoredFileName/);
  assert.match(whisper, /runtimeArchiveStoredName/);
  assert.match(whisper, /schemaVersion = 4/);
  assert.match(whisper, /whisper-activation\.json/);
  assert.match(whisper, /pending-health-verification/);
  assert.match(whisper, /Test-WhisperHealth `[\s\S]*-RequestPath \$requestPath/);
  assert.match(whisper, /healthVerifiedAtUtc/);
  const whisperLock = whisper.indexOf("$whisperMutex = Enter-ScribeFlowMutex");
  const operationTry = whisper.indexOf("try {", whisperLock);
  const modelDownload = whisper.indexOf("-MaximumSeconds 7200");
  const activationLock = whisper.indexOf(
    "$lifecycleMutex = Enter-ScribeFlowMutex",
    modelDownload,
  );
  const stopInstalled = whisper.indexOf("Stop-InstalledWhisper", activationLock);
  const alwaysExtract = whisper.indexOf("Expand-Archive");
  assert.ok(whisperLock >= 0 && whisperLock < operationTry);
  assert.ok(modelDownload >= 0 && modelDownload < activationLock);
  assert.ok(activationLock >= 0 && activationLock < stopInstalled);
  assert.ok(alwaysExtract >= 0 && alwaysExtract < activationLock);
  assert.match(whisper, /completed resumed file can make an HTTP server answer 416/);
  assert.match(whisper, /\$downloadHttpCode -ne "416"/);
  assert.match(whisper, /download was interrupted and can resume later/);
  assert.match(whisper, /\$freshDestination = "\$Destination\.fresh"/);
  assert.doesNotMatch(
    whisper,
    /if \(-not \$serverExecutable\)[\s\S]{0,300}Expand-Archive/,
  );
  const manifestCommit = whisper.indexOf(
    "-Destination $previousManifestPath",
  );
  assert.ok(
    whisper.indexOf("if (-not $whisperHealthy)") <
      manifestCommit,
  );
  assert.ok(
    manifestCommit < whisper.indexOf("The prior generation is untouched"),
  );
  assert.match(launcher, /ScribeFlow opened without Whisper/);
  assert.ok(
    launcher.indexOf("catch {") < launcher.lastIndexOf("Open-ScribeFlow -Port 3000"),
  );
  assert.match(modelServer, /whisperActivationFile/);
  assert.match(modelServer, /await nativeWhisperHealth\(\)/);
  assert.equal(
    modelServer.match(/await getWhisperInstallStatus\(\)/g)?.length,
    2,
  );
  assert.match(modelServer, /whisperStatusFile/);
  assert.match(modelServer, /expectedPath: serverExecutable/);
  assert.match(modelServer, /runtimeDirectoryName/);
  assert.match(modelServer, /parseWhisperServerRelativePath/);
  assert.match(modelServer, /runtimeServerRelativePath/);
  assert.match(modelServer, /modelStoredFileName/);
  assert.match(modelServer, /durableFailure/);
  assert.match(modelServer, /no prior version was present/);
});

test("recovers exact Whisper activation generations and recognizes a live installer after restart", async () => {
  const whisper = await source("../scripts/install-native-whisper.ps1");
  const modelServer = await source("../scripts/local-model-server.mjs");

  assert.match(whisper, /schemaVersion = 2[\s\S]*installerInstanceId/);
  assert.match(whisper, /processPath = \$installerProcessPath/);
  assert.match(whisper, /processStartedAtUtc = \$installerProcessStartedAtUtc/);
  assert.match(whisper, /function Recover-InterruptedWhisperActivation/);
  assert.match(
    whisper,
    /Recover-InterruptedWhisperActivation `[\s\S]*-CommittedManifest \$previousManifest/,
  );
  assert.match(whisper, /Stop-InstalledWhisper[\s\S]*markerRuntimeName/);
  assert.match(whisper, /runtimeDirectoryName = \$RuntimeDirectoryName/);
  assert.match(whisper, /modelStoredFileName = \$ModelStoredFileName/);
  assert.match(whisper, /modelNeedsActivation = \$ModelNeedsActivation/);
  assert.match(whisper, /runtimeActivated = \$RuntimeActivated/);
  assert.match(whisper, /modelActivated = \$ModelActivated/);
  assert.match(whisper, /Restore-UncommittedWhisperModel/);
  assert.match(whisper, /Recovered the verified uncommitted Whisper model/);
  assert.match(whisper, /\$recoveryDownload/);
  const preMoveMarker = whisper.indexOf(
    '-Stage "pending-health-verification"',
    whisper.indexOf("$lifecycleMutex = Enter-ScribeFlowMutex", whisper.indexOf("-MaximumSeconds 7200")),
  );
  const stopWhisper = whisper.indexOf("Stop-InstalledWhisper", preMoveMarker);
  const moveRuntime = whisper.indexOf(
    "Move-Item -LiteralPath $runtimeStaging -Destination $runtimeRoot",
    stopWhisper,
  );
  assert.ok(preMoveMarker >= 0 && preMoveMarker < stopWhisper);
  assert.ok(stopWhisper < moveRuntime);

  assert.match(
    modelServer,
    /liveWhisperInstallStages = new Set\(\[[\s\S]*"checking"[\s\S]*"downloading"[\s\S]*"installing"[\s\S]*"verifying"/,
  );
  assert.match(modelServer, /isDurableWhisperInstallerLive/);
  assert.match(modelServer, /status\.processStartedAtUtc/);
  assert.match(modelServer, /Math\.abs\(actualStart - expectedStart\) <= 3_000/);
  assert.match(modelServer, /whisperInstallerLaunchPending/);
  assert.match(modelServer, /await installNativeWhisper\(\)/);
  assert.match(modelServer, /cwd: whisperInstallerWorkingDirectory/);
  assert.doesNotMatch(
    modelServer,
    /nativeWhisperInstaller,[\s\S]{0,500}cwd: projectRoot/,
  );
  assert.match(modelServer, /installed: await hasHealthyCommittedWhisper\(\)/);
});

test("launcher resolves mutable app and Whisper state only under the lifecycle lock", async () => {
  const launcher = await source("../scripts/launch-scribeflow.ps1");

  const lock = launcher.indexOf("$lifecycleMutex = Enter-ScribeFlowMutex");
  const pendingRecovery = launcher.indexOf("Restore-PendingScribeFlowInstall", lock);
  const whisperManifestRead = launcher.indexOf(
    "$whisperReleasePath =",
    pendingRecovery,
  );
  const expectedVersionRead = launcher.indexOf(
    "if (-not $ExpectedVersion)",
    whisperManifestRead,
  );
  assert.ok(lock >= 0);
  assert.ok(pendingRecovery > lock);
  assert.ok(whisperManifestRead > pendingRecovery);
  assert.ok(expectedVersionRead > whisperManifestRead);
});

test("hides native Whisper behind a per-launch 256-bit request path and bridge", async () => {
  const launcher = await source("../scripts/launch-scribeflow.ps1");
  const modelServer = await source("../scripts/local-model-server.mjs");

  assert.match(launcher, /RandomNumberGenerator\]::Create/);
  assert.match(launcher, /New-Object byte\[\] 32/);
  assert.match(launcher, /\/scribeflow-\$token/);
  assert.match(launcher, /"--request-path", \$nativeRequestPath/);
  assert.match(modelServer, /randomBytes\(32\)/);
  assert.match(modelServer, /request-path\.json/);
  assert.match(modelServer, /"--request-path",\s*requestPath/);
  assert.match(modelServer, /url\.pathname === "\/whisper\/native-health"/);
  assert.match(modelServer, /url\.pathname === "\/whisper\/inference"/);
  assert.match(modelServer, /allowedOrigins\.has\(origin\)/);
  assert.match(modelServer, /3002\$\{requestPath\}\/inference/);
  assert.doesNotMatch(modelServer, /3002\/inference/);
});

test("uninstall retries exact cleanup while preserving documents and optional Whisper", async () => {
  const uninstaller = await source("../scripts/uninstall-scribeflow.ps1");

  assert.match(uninstaller, /Remove-ScribeFlowPathWithRetry/);
  const whisperLock = uninstaller.indexOf("$whisperMutex = Enter-ScribeFlowMutex");
  const lifecycleLock = uninstaller.indexOf("$lifecycleMutex = Enter-ScribeFlowMutex");
  assert.ok(whisperLock >= 0 && whisperLock < lifecycleLock);
  assert.match(uninstaller, /ScribeFlow Background\.lnk/);
  assert.match(uninstaller, /\$runtimeStateRoot, \$updatesRoot/);
  assert.match(uninstaller, /\[switch\]\$RemoveWhisper/);
  assert.match(uninstaller, /Documents\\ScribeFlow was preserved/);
  assert.match(uninstaller, /separately downloaded Whisper model was preserved/);
});

test("shell integration runs only after health and cannot roll back a healthy install", async () => {
  const installer = await source("../installer/Install-ScribeFlow.ps1");

  const healthGate = installer.lastIndexOf(
    "if (-not (Test-InstalledScribeFlowHealth -ExpectedVersion $appVersion))",
  );
  const transactionCleared = installer.indexOf(
    "Clear-ScribeFlowInstallTransaction",
    healthGate,
  );
  const startMenu = installer.indexOf(
    '-Name "the Start menu shortcut"',
    healthGate,
  );
  const desktop = installer.indexOf(
    '-Name "the optional Desktop shortcut"',
    healthGate,
  );
  const startup = installer.indexOf(
    '-Name "the Windows startup shortcut"',
    healthGate,
  );
  const uninstall = installer.indexOf(
    '-Name "the Windows uninstall registration"',
    healthGate,
  );

  assert.ok(healthGate >= 0);
  assert.ok(transactionCleared > healthGate);
  assert.ok(startMenu > transactionCleared);
  assert.ok(desktop > startMenu);
  assert.ok(startup > desktop);
  assert.ok(uninstall > startup);
  assert.match(installer, /function Invoke-ScribeFlowBestEffortShellIntegration/);
  assert.match(
    installer,
    /Invoke-ScribeFlowBestEffortShellIntegration `[\s\S]*-Name "the Start menu shortcut"/,
  );
  assert.match(
    installer,
    /Invoke-ScribeFlowBestEffortShellIntegration `[\s\S]*-Name "the optional Desktop shortcut"/,
  );
  assert.match(
    installer,
    /Invoke-ScribeFlowBestEffortShellIntegration `[\s\S]*-Name "the Windows startup shortcut"/,
  );
  assert.match(
    installer,
    /Invoke-ScribeFlowBestEffortShellIntegration `[\s\S]*-Name "the Windows uninstall registration"/,
  );
  assert.match(installer, /Optional Windows integration and its logging are both best-effort/);
  assert.match(installer, /New-ScribeFlowShortcut/);
  assert.match(installer, /\$installedPowerShell/);
  assert.match(installer, /scripts\\start-scribeflow\.ps1/);
  assert.match(installer, /Programs\\ScribeFlow/);
  assert.match(installer, /ScribeFlow Background\.lnk/);
  assert.match(installer, /CurrentVersion\\Uninstall\\ScribeFlow/);
});
