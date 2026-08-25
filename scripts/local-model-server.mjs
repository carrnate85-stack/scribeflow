import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { saveNoteDocument } from "./document-storage-utils.mjs";
import {
  reconcileTemplatePayload,
  reconcileWritingToolsPayload,
} from "./library-sync-utils.mjs";
import { deleteVerifiedPdf } from "./pdf-delete-utils.mjs";
import {
  isInstalledWhisperReleaseCurrent,
  validateWhisperRelease,
} from "./whisper-release-utils.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const whisperRelease = validateWhisperRelease(
  JSON.parse(
    readFileSync(resolve(projectRoot, "scripts", "whisper-release.json"), "utf8"),
  ),
);
const dataRoot = resolve(
  process.env.LOCALAPPDATA || resolve(projectRoot, ".scribeflow-data"),
  "ScribeFlow",
);
const modelRoot = resolve(dataRoot, "models");
const nativeWhisperRoot = resolve(dataRoot, "native-whisper");
const expectedNativeWhisperModel = resolve(
  nativeWhisperRoot,
  "models",
  whisperRelease.model.fileName,
);
const expectedNativeWhisperRuntimeRoot = resolve(
  nativeWhisperRoot,
  `runtime-${whisperRelease.runtime.version}`,
);
const nativeWhisperManifest = resolve(
  nativeWhisperRoot,
  "native-manifest.json",
);
const nativeWhisperInstaller = resolve(
  projectRoot,
  "scripts",
  "install-native-whisper.ps1",
);
const whisperInstallLog = resolve(dataRoot, "runtime", "whisper-install.log");
const nativeWhisperPidFile = resolve(
  dataRoot,
  "runtime",
  "native-whisper",
  "server.pid",
);
const defaultDocumentsRoot = process.env.OneDrive
  ? resolve(process.env.OneDrive, "Documents", "ScribeFlow")
  : resolve(homedir(), "Documents", "ScribeFlow");
const documentsRoot = resolve(
  process.env.SCRIBEFLOW_DOCUMENTS_ROOT || defaultDocumentsRoot,
);
const notesRoot = resolve(documentsRoot, "Notes");
const templatesRoot = resolve(documentsRoot, "Templates");
const templatesFile = resolve(templatesRoot, "templates.json");
const templateBackupsRoot = resolve(templatesRoot, "Backups");
const writingToolsRoot = resolve(documentsRoot, "Writing Tools");
const writingToolsFile = resolve(writingToolsRoot, "writing-tools.json");
const writingToolsBackupsRoot = resolve(writingToolsRoot, "Backups");
const templateConflictsRoot = resolve(templatesRoot, "Conflicts");
const writingToolsConflictsRoot = resolve(writingToolsRoot, "Conflicts");
const legacyTemplatesFile = resolve(dataRoot, "templates.json");
const legacyTemplateBackupsRoot = resolve(dataRoot, "template-backups");
const updateStatusFile = resolve(dataRoot, "runtime", "update-status.json");
const deviceName = String(process.env.COMPUTERNAME || hostname() || "This PC")
  .trim()
  .slice(0, 80);
const downloadsRoot = resolve(process.env.USERPROFILE || homedir(), "Downloads");
const host = "127.0.0.1";
const configuredPort = Number.parseInt(
  process.env.SCRIBEFLOW_MODEL_PORT || "3001",
  10,
);
const port =
  Number.isInteger(configuredPort) &&
  configuredPort >= 1 &&
  configuredPort <= 65535
    ? configuredPort
    : 3001;
const maxTemplateBytes = 5 * 1024 * 1024;
const maxWritingToolsBytes = 2 * 1024 * 1024;
const maxNoteBytes = 2 * 1024 * 1024;
const maxPdfDeleteRequestBytes = 8 * 1024;
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const contentTypes = new Map([
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".onnx", "application/octet-stream"],
]);
let whisperInstallerProcess = null;
let whisperInstallError = "";
let whisperStartingUntil = 0;

function sendText(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function isNativeWhisperInstalled() {
  const components = getNativeWhisperComponents();
  return Boolean(components.model && components.runtime);
}

function readInstalledWhisperManifest() {
  if (!existsSync(nativeWhisperManifest)) return null;
  try {
    return JSON.parse(
      readFileSync(nativeWhisperManifest, "utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    return null;
  }
}

function getNativeWhisperComponents() {
  const installedManifest = readInstalledWhisperManifest();
  const runtimeRoots = [expectedNativeWhisperRuntimeRoot];
  if (
    typeof installedManifest?.runtimeVersion === "string" &&
    /^v[A-Za-z0-9._-]+$/.test(installedManifest.runtimeVersion) &&
    installedManifest.runtimeVersion !== whisperRelease.runtime.version
  ) {
    runtimeRoots.push(
      resolve(
        nativeWhisperRoot,
        `runtime-${installedManifest.runtimeVersion}`,
      ),
    );
  }

  const modelFiles = [expectedNativeWhisperModel];
  if (
    typeof installedManifest?.modelFileName === "string" &&
    /^[A-Za-z0-9._-]+\.bin$/.test(installedManifest.modelFileName) &&
    installedManifest.modelFileName !== whisperRelease.model.fileName
  ) {
    modelFiles.push(
      resolve(
        nativeWhisperRoot,
        "models",
        installedManifest.modelFileName,
      ),
    );
  }

  const runtime = runtimeRoots
    .flatMap((runtimeRoot) => [
      resolve(runtimeRoot, "Release"),
      resolve(runtimeRoot, runtimeRoot.split(/[\\/]/).at(-1), "Release"),
    ])
    .find((candidate) =>
      existsSync(resolve(candidate, "whisper-server.exe")),
    );
  const model = modelFiles.find((candidate) => existsSync(candidate));
  return { model, runtime };
}

function migrateLegacyWhisperManifest(components) {
  if (readInstalledWhisperManifest()) {
    return readInstalledWhisperManifest();
  }
  if (
    components.model !== expectedNativeWhisperModel ||
    !components.runtime?.startsWith(`${expectedNativeWhisperRuntimeRoot}${sep}`)
  ) {
    return null;
  }

  const migratedManifest = {
    whisperReleaseVersion: whisperRelease.releaseVersion,
    displayName: whisperRelease.displayName,
    runtime: whisperRelease.runtime.source,
    runtimeVersion: whisperRelease.runtime.version,
    runtimeArchiveName: whisperRelease.runtime.archiveName,
    runtimeSha256: whisperRelease.runtime.sha256,
    model: whisperRelease.model.id,
    modelSource: whisperRelease.model.source,
    modelFileName: whisperRelease.model.fileName,
    modelSha1: whisperRelease.model.sha1,
    unquantized: true,
    remoteModelsAllowed: false,
    migratedLegacyInstall: true,
  };
  mkdirSync(nativeWhisperRoot, { recursive: true });
  const temporaryManifest = `${nativeWhisperManifest}.new`;
  writeFileSync(
    temporaryManifest,
    JSON.stringify(migratedManifest),
    "utf8",
  );
  renameSync(temporaryManifest, nativeWhisperManifest);
  return migratedManifest;
}

function withWhisperRelease(payload) {
  const installedManifest = readInstalledWhisperManifest();
  return {
    ...payload,
    expectedReleaseVersion: whisperRelease.releaseVersion,
    installedReleaseVersion:
      installedManifest?.whisperReleaseVersion ||
      installedManifest?.runtimeVersion ||
      null,
  };
}

function getWhisperInstallStatus() {
  if (whisperInstallerProcess) {
    return withWhisperRelease({
      status: "installing",
      installed: false,
      message: `Downloading and verifying ${whisperRelease.displayName} (${whisperRelease.downloadSizeLabel}). Keep ScribeFlow open.`,
    });
  }
  if (isNativeWhisperInstalled()) {
    const components = getNativeWhisperComponents();
    const installedManifest =
      readInstalledWhisperManifest() ||
      migrateLegacyWhisperManifest(components);
    if (
      !isInstalledWhisperReleaseCurrent(installedManifest, whisperRelease)
    ) {
      return withWhisperRelease({
        status: "update_available",
        installed: true,
        message:
          "A verified Whisper update is available. Dictation can continue until you choose to update.",
      });
    }
    if (Date.now() < whisperStartingUntil) {
      return withWhisperRelease({
        status: "starting",
        installed: true,
        message: "Whisper is installed and starting. This can take a moment.",
      });
    }
    return withWhisperRelease({
      status: "installed",
      installed: true,
      message: `${whisperRelease.displayName} is installed locally.`,
    });
  }
  if (whisperInstallError) {
    return withWhisperRelease({
      status: "failed",
      installed: false,
      message: whisperInstallError,
    });
  }
  return withWhisperRelease({
    status: "missing",
    installed: false,
    message: `Install ${whisperRelease.displayName} for private, accurate dictation on this computer.`,
  });
}

function startNativeWhisperService() {
  const { model, runtime } = getNativeWhisperComponents();
  if (!runtime || !model) return;
  const serverExecutable = resolve(runtime, "whisper-server.exe");
  const service = spawn(
    serverExecutable,
    [
      "--host",
      "127.0.0.1",
      "--port",
      "3002",
      "--model",
      model,
      "--threads",
      "12",
      "--language",
      "en",
      "--beam-size",
      "5",
      "--best-of",
      "5",
      "--no-timestamps",
      "--suppress-nst",
      "--flash-attn",
    ],
    {
      cwd: runtime,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  mkdirSync(resolve(dataRoot, "runtime", "native-whisper"), {
    recursive: true,
  });
  writeFileSync(nativeWhisperPidFile, String(service.pid), "utf8");
  service.unref();
}

function installNativeWhisper() {
  if (whisperInstallerProcess) return;
  if (!existsSync(nativeWhisperInstaller)) {
    whisperInstallError = "The ScribeFlow Whisper installer is missing.";
    return;
  }

  mkdirSync(resolve(dataRoot, "runtime"), { recursive: true });
  whisperInstallError = "";
  const logHandle = openSync(whisperInstallLog, "a");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      nativeWhisperInstaller,
    ],
    {
      cwd: projectRoot,
      stdio: ["ignore", logHandle, logHandle],
      windowsHide: true,
    },
  );
  closeSync(logHandle);
  whisperInstallerProcess = child;
  child.once("error", (error) => {
    whisperInstallError = `Whisper could not start installing: ${error.message}`;
    whisperInstallerProcess = null;
  });
  child.once("exit", (code) => {
    whisperInstallerProcess = null;
    if (code === 0 && isNativeWhisperInstalled()) {
      whisperInstallError = "";
      whisperStartingUntil = Date.now() + 60_000;
      startNativeWhisperService();
      return;
    }
    whisperInstallError =
      "Whisper installation did not finish. Check your internet connection and try again.";
  });
}

function isTemplatePayload(value) {
  return (
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(value.templates) &&
    value.templates.every(
      (template) =>
        template &&
        typeof template === "object" &&
        typeof template.id === "string" &&
        typeof template.name === "string" &&
        typeof template.type === "string" &&
        typeof template.description === "string" &&
        typeof template.content === "string" &&
        (template.contentHtml === undefined ||
          typeof template.contentHtml === "string"),
    )
  );
}

function readTemplatePayload(path) {
  if (!existsSync(path)) return null;
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return isTemplatePayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function readTemplatesFrom(primaryFile, backupsRoot) {
  const primary = readTemplatePayload(primaryFile);
  if (primary) return primary;
  if (!existsSync(backupsRoot)) return null;
  const backups = readdirSync(backupsRoot)
    .filter((file) => /^templates-\d+\.json$/.test(file))
    .sort()
    .reverse();
  for (const backup of backups) {
    const payload = readTemplatePayload(resolve(backupsRoot, backup));
    if (payload) return payload;
  }
  return null;
}

function readDurableTemplates() {
  return readTemplatesFrom(templatesFile, templateBackupsRoot);
}

function writeDurableTemplates(payload) {
  mkdirSync(templateBackupsRoot, { recursive: true });
  if (existsSync(templatesFile)) {
    const current = readFileSync(templatesFile, "utf8");
    const next = JSON.stringify(payload);
    if (current !== next) {
      copyFileSync(
        templatesFile,
        resolve(templateBackupsRoot, `templates-${Date.now()}.json`),
      );
    }
  }

  const temporaryFile = `${templatesFile}.new`;
  writeFileSync(temporaryFile, JSON.stringify(payload), "utf8");
  renameSync(temporaryFile, templatesFile);

  let backups = readdirSync(templateBackupsRoot)
    .filter((file) => /^templates-\d+\.json$/.test(file))
    .sort()
    .reverse();
  if (backups.length === 0) {
    const firstBackup = `templates-${Date.now()}.json`;
    copyFileSync(templatesFile, resolve(templateBackupsRoot, firstBackup));
    backups = [firstBackup];
  }
  backups.slice(20).forEach((backup) => {
    unlinkSync(resolve(templateBackupsRoot, backup));
  });
}

function migrateLegacyTemplates() {
  const legacyPayload = readTemplatesFrom(
    legacyTemplatesFile,
    legacyTemplateBackupsRoot,
  );
  if (!legacyPayload) return;

  const syncedPayload = readDurableTemplates();
  if (!syncedPayload || legacyPayload.updatedAt > syncedPayload.updatedAt) {
    writeDurableTemplates(legacyPayload);
  }

  const verifiedPayload = readDurableTemplates();
  if (!verifiedPayload || verifiedPayload.updatedAt < legacyPayload.updatedAt) {
    return;
  }
  if (existsSync(legacyTemplatesFile)) {
    unlinkSync(legacyTemplatesFile);
  }
  if (existsSync(legacyTemplateBackupsRoot)) {
    rmSync(legacyTemplateBackupsRoot, { recursive: true, force: true });
  }
}

function isWritingToolsPayload(value) {
  return (
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(value.quicktexts) &&
    value.quicktexts.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.shortcut === "string" &&
        typeof item.title === "string" &&
        typeof item.content === "string" &&
        typeof item.category === "string",
    ) &&
    Array.isArray(value.vocabulary) &&
    value.vocabulary.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.heard === "string" &&
        typeof item.replacement === "string",
    )
  );
}

function readWritingToolsPayload(path) {
  if (!existsSync(path)) return null;
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return isWritingToolsPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function readDurableWritingTools() {
  const primary = readWritingToolsPayload(writingToolsFile);
  if (primary) return primary;
  if (!existsSync(writingToolsBackupsRoot)) return null;
  const backups = readdirSync(writingToolsBackupsRoot)
    .filter((file) => /^writing-tools-\d+\.json$/.test(file))
    .sort()
    .reverse();
  for (const backup of backups) {
    const payload = readWritingToolsPayload(
      resolve(writingToolsBackupsRoot, backup),
    );
    if (payload) return payload;
  }
  return null;
}

function writeDurableWritingTools(payload) {
  mkdirSync(writingToolsBackupsRoot, { recursive: true });
  if (existsSync(writingToolsFile)) {
    const current = readFileSync(writingToolsFile, "utf8");
    const next = JSON.stringify(payload);
    if (current !== next) {
      copyFileSync(
        writingToolsFile,
        resolve(
          writingToolsBackupsRoot,
          `writing-tools-${Date.now()}.json`,
        ),
      );
    }
  }

  const temporaryFile = `${writingToolsFile}.new`;
  writeFileSync(temporaryFile, JSON.stringify(payload), "utf8");
  renameSync(temporaryFile, writingToolsFile);

  let backups = readdirSync(writingToolsBackupsRoot)
    .filter((file) => /^writing-tools-\d+\.json$/.test(file))
    .sort()
    .reverse();
  if (backups.length === 0) {
    const firstBackup = `writing-tools-${Date.now()}.json`;
    copyFileSync(
      writingToolsFile,
      resolve(writingToolsBackupsRoot, firstBackup),
    );
    backups = [firstBackup];
  }
  backups.slice(20).forEach((backup) => {
    unlinkSync(resolve(writingToolsBackupsRoot, backup));
  });
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeConflictArchive({
  root,
  prefix,
  base,
  current,
  incoming,
  merged,
  conflicts,
}) {
  if (conflicts.length === 0) return null;
  mkdirSync(root, { recursive: true });
  const stamp = Date.now();
  const fileName = `${prefix}-conflict-${stamp}.json`;
  const path = resolve(root, fileName);
  const temporaryPath = `${path}.new`;
  writeFileSync(
    temporaryPath,
    JSON.stringify(
      {
        version: 1,
        detectedAt: stamp,
        deviceName,
        conflicts,
        base,
        current,
        incoming,
        merged,
      },
      null,
      2,
    ),
    "utf8",
  );
  renameSync(temporaryPath, path);
  return fileName;
}

function countConflictArchives(root, prefix) {
  if (!existsSync(root)) return 0;
  return readdirSync(root).filter((file) =>
    new RegExp(`^${prefix}-conflict-\\d+\\.json$`).test(file),
  ).length;
}

function getVaultStatus(path, payload) {
  if (!payload || !existsSync(path)) {
    return { exists: false, updatedAt: null, modifiedAt: null, lastWriter: null };
  }
  return {
    exists: true,
    updatedAt: payload.updatedAt,
    modifiedAt: statSync(path).mtimeMs,
    lastWriter: payload.lastWriter || null,
  };
}

function readVaultRequest(value, validator) {
  const payload = value?.payload || value;
  const base = value?.payload ? value.base || null : null;
  if (!validator(payload) || (base && !validator(base))) return null;
  return { payload, base };
}

function sharedStorageStatus() {
  const templatePayload = readDurableTemplates();
  const writingToolsPayload = readDurableWritingTools();
  return {
    checkedAt: Date.now(),
    deviceName,
    documentsRoot,
    oneDrive: /[\\/]OneDrive(?:[^\\/]*)?[\\/]/i.test(documentsRoot),
    templates: {
      ...getVaultStatus(templatesFile, templatePayload),
      conflicts: countConflictArchives(templateConflictsRoot, "templates"),
    },
    writingTools: {
      ...getVaultStatus(writingToolsFile, writingToolsPayload),
      conflicts: countConflictArchives(
        writingToolsConflictsRoot,
        "writing-tools",
      ),
    },
    update: readJsonFile(updateStatusFile),
  };
}

migrateLegacyTemplates();

const server = createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    response.end();
    return;
  }
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");

  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/health") {
    sendText(response, 200, "ScribeFlow Local Whisper");
    return;
  }
  if (url.pathname === "/whisper/install-status") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    sendJson(response, 200, getWhisperInstallStatus());
    return;
  }
  if (url.pathname === "/whisper/install") {
    if (request.method !== "POST") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    if (!origin || !allowedOrigins.has(origin)) {
      sendText(response, 403, "ScribeFlow must be open to install Whisper");
      return;
    }
    installNativeWhisper();
    sendJson(response, 202, getWhisperInstallStatus());
    return;
  }
  if (url.pathname === "/files/delete-uploaded-pdf") {
    if (request.method !== "POST") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxPdfDeleteRequestBytes) {
        rejected = true;
        sendText(response, 413, "Deletion request is too large");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        deleteVerifiedPdf(downloadsRoot, payload);
        sendText(response, 200, "Original PDF permanently deleted");
      } catch {
        sendText(
          response,
          409,
          "The selected PDF could not be verified and deleted from Downloads",
        );
      }
    });
    return;
  }
  if (url.pathname === "/documents/save-note") {
    if (request.method !== "POST") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxNoteBytes) {
        rejected = true;
        sendText(response, 413, "The note is too large to save");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof payload.title !== "string" ||
          typeof payload.note !== "string" ||
          typeof payload.noteHtml !== "string"
        ) {
          sendText(response, 400, "Invalid note");
          return;
        }
        const saved = saveNoteDocument(notesRoot, payload);
        sendJson(response, 201, {
          fileName: saved.fileName,
          folder: notesRoot,
        });
      } catch {
        sendText(response, 500, "The note could not be saved");
      }
    });
    return;
  }
  if (url.pathname === "/config/status") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed");
      return;
    }
    const body = JSON.stringify(sharedStorageStatus());
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  if (url.pathname === "/config/writing-tools") {
    if (request.method === "GET" || request.method === "HEAD") {
      const payload = readDurableWritingTools();
      if (!payload) {
        sendText(response, 404, "No shared writing-tools copy yet");
        return;
      }
      const body = JSON.stringify(payload);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      let size = 0;
      let rejected = false;
      request.on("data", (chunk) => {
        if (rejected) return;
        size += chunk.length;
        if (size > maxWritingToolsBytes) {
          rejected = true;
          sendText(response, 413, "Writing-tools copy is too large");
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (rejected) return;
        try {
          const received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const requestPayload = readVaultRequest(
            received,
            isWritingToolsPayload,
          );
          if (!requestPayload) {
            sendText(response, 400, "Invalid writing-tools copy");
            return;
          }
          const current = readDurableWritingTools();
          const reconciled = reconcileWritingToolsPayload({
            current,
            incoming: requestPayload.payload,
            base: requestPayload.base,
            deviceName,
          });
          writeDurableWritingTools(reconciled.payload);
          const conflictFile = writeConflictArchive({
            root: writingToolsConflictsRoot,
            prefix: "writing-tools",
            base: requestPayload.base,
            current,
            incoming: requestPayload.payload,
            merged: reconciled.payload,
            conflicts: reconciled.conflicts,
          });
          sendJson(response, 200, {
            payload: reconciled.payload,
            conflictCount: reconciled.conflicts.length,
            conflictFile,
            message:
              reconciled.conflicts.length > 0
                ? "Writing-tool changes were merged; uncertain edits were preserved."
                : "Writing tools synced in Documents.",
          });
        } catch {
          sendText(response, 400, "Invalid writing-tools copy");
        }
      });
      return;
    }
    sendText(response, 405, "Method not allowed");
    return;
  }
  if (url.pathname === "/config/templates") {
    if (request.method === "GET" || request.method === "HEAD") {
      const payload = readDurableTemplates();
      if (!payload) {
        sendText(response, 404, "No durable template backup yet");
        return;
      }
      const body = JSON.stringify(payload);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      let size = 0;
      let rejected = false;
      request.on("data", (chunk) => {
        if (rejected) return;
        size += chunk.length;
        if (size > maxTemplateBytes) {
          rejected = true;
          sendText(response, 413, "Template backup is too large");
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (rejected) return;
        try {
          const received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const requestPayload = readVaultRequest(received, isTemplatePayload);
          if (!requestPayload) {
            sendText(response, 400, "Invalid template backup");
            return;
          }
          const current = readDurableTemplates();
          const reconciled = reconcileTemplatePayload({
            current,
            incoming: requestPayload.payload,
            base: requestPayload.base,
            deviceName,
          });
          writeDurableTemplates(reconciled.payload);
          const conflictFile = writeConflictArchive({
            root: templateConflictsRoot,
            prefix: "templates",
            base: requestPayload.base,
            current,
            incoming: requestPayload.payload,
            merged: reconciled.payload,
            conflicts: reconciled.conflicts,
          });
          sendJson(response, 200, {
            payload: reconciled.payload,
            conflictCount: reconciled.conflicts.length,
            conflictFile,
            message:
              reconciled.conflicts.length > 0
                ? "Template changes were merged; uncertain edits were preserved."
                : "Templates protected in Documents.",
          });
        } catch {
          sendText(response, 400, "Invalid template backup");
        }
      });
      return;
    }
    sendText(response, 405, "Method not allowed");
    return;
  }
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !url.pathname.startsWith("/models/")
  ) {
    sendText(response, 404, "Not found");
    return;
  }

  const relativePath = decodeURIComponent(url.pathname.slice("/models/".length));
  const filePath = resolve(modelRoot, relativePath);
  if (
    !filePath.startsWith(`${modelRoot}${sep}`) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    sendText(response, 404, "Model file not found");
    return;
  }

  const fileSize = statSync(filePath).size;
  const rangeHeader = request.headers.range;
  let start = 0;
  let end = fileSize - 1;
  let status = 200;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : end;
    if (start > end || end >= fileSize) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    status = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }

  response.writeHead(status, {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Length": String(end - start + 1),
    "Content-Type":
      contentTypes.get(extname(filePath).toLowerCase()) ||
      "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(response);
});

server.listen(port, host, () => {
  console.log(`ScribeFlow local model service ready at http://${host}:${port}`);
});
