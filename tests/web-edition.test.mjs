import assert from "node:assert/strict";
import test from "node:test";

async function renderWebEdition() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("web-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://scribeflow.example/", {
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

test("renders the Dragon-ready web edition without local dictation setup", async () => {
  const response = await renderWebEdition();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /ScribeFlow Web/);
  assert.match(html, /Dragon ready/);
  assert.match(html, /Clinical content stays in this browser/);
  assert.match(html, /Intake PDF/);
  assert.match(html, /PAP PDF/);
  assert.match(html, /Paste HST/);
  assert.match(html, /Clinical note editor/);
  assert.match(html, /Shared across computers/);
  assert.match(html, /Checking shared library/);
  assert.doesNotMatch(html, /Publish|GitHub token|publishing key/);
  assert.doesNotMatch(html, /Top bar microphone selection/);
  assert.doesNotMatch(html, /Persistent dictation controls/);
  assert.doesNotMatch(html, /Install Whisper|Update Whisper\?/);
  assert.doesNotMatch(html, /Open system check|Open shared library status/);
  assert.doesNotMatch(html, /Delete after import/);
});
