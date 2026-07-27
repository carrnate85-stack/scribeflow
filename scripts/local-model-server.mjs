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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
const templatesFile = resolve(dataRoot, "templates.json");
const templateBackupsRoot = resolve(dataRoot, "template-backups");
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

function readDurableTemplates() {
  const primary = readTemplatePayload(templatesFile);
  if (primary) return primary;
  if (!existsSync(templateBackupsRoot)) return null;
  const backups = readdirSync(templateBackupsRoot)
    .filter((file) => /^templates-\d+\.json$/.test(file))
    .sort()
    .reverse();
  for (const backup of backups) {
    const payload = readTemplatePayload(resolve(templateBackupsRoot, backup));
    if (payload) return payload;
  }
  return null;
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
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!isTemplatePayload(payload)) {
            sendText(response, 400, "Invalid template backup");
            return;
          }
          writeDurableTemplates(payload);
          sendText(response, 200, "Templates protected locally");
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
