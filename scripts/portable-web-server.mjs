import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientRoot = resolve(projectRoot, "dist", "client");
const serverEntry = resolve(projectRoot, "dist", "server", "index.js");
const host = "127.0.0.1";
const port = Number(process.env.SCRIBEFLOW_PORT || 3000);

if (!existsSync(serverEntry) || !existsSync(clientRoot)) {
  throw new Error("The ScribeFlow production build is incomplete.");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
]);

function localAssetPath(request) {
  const url = new URL(request.url);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = resolve(clientRoot, relativePath);
  if (
    candidate !== clientRoot &&
    !candidate.startsWith(`${clientRoot}${sep}`)
  ) {
    return null;
  }
  return candidate;
}

const assets = {
  async fetch(request) {
    const filePath = localAssetPath(request);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const bytes = await readFile(filePath);
    return new Response(bytes, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type":
          contentTypes.get(extname(filePath).toLowerCase()) ||
          "application/octet-stream",
      },
    });
  },
};

const worker = (await import(pathToFileURL(serverEntry).href)).default;
const executionContext = {
  passThroughOnException() {},
  waitUntil(promise) {
    Promise.resolve(promise).catch(() => {});
  },
};

function requestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return request;
}

async function sendWebResponse(request, response, webResponse) {
  response.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers.entries()),
  );
  if (request.method === "HEAD" || !webResponse.body) {
    response.end();
    return;
  }
  for await (const chunk of webResponse.body) {
    response.write(chunk);
  }
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || `${host}:${port}`}`,
    );
    const assetPath = localAssetPath(new Request(url));
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      assetPath &&
      existsSync(assetPath) &&
      statSync(assetPath).isFile()
    ) {
      await sendWebResponse(
        request,
        response,
        await assets.fetch(new Request(url)),
      );
      return;
    }
    const webRequest = new Request(url, {
      body: requestBody(request),
      duplex: requestBody(request) ? "half" : undefined,
      headers: request.headers,
      method: request.method,
    });
    const webResponse = await worker.fetch(
      webRequest,
      { ASSETS: assets },
      executionContext,
    );
    await sendWebResponse(request, response, webResponse);
  } catch {
    response.writeHead(500, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("ScribeFlow could not render this page.");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`ScribeFlow ready at http://${host}:${port}/\n`);
});
