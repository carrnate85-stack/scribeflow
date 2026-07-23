import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the clinical dictation workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ScribeFlow — Clinical Dictation<\/title>/i);
  assert.match(html, /Clinical dictation/);
  assert.match(html, /Writing tools/);
  assert.match(html, /Start dictating or choose a template/);
  assert.match(html, /Notes saved on this device/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("includes quicktext, template, and local-save workflows", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const packageJson = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );

  assert.match(page, /\.normalexam/);
  assert.match(page, /SOAP Note/);
  assert.match(page, /Procedure Note/);
  assert.match(page, /SpeechRecognition/);
  assert.match(page, /window\.localStorage/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /downloadNote/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
