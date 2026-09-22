import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const pagesHtml = await readFile(
  new URL("../github-pages/index.html", import.meta.url),
  "utf8",
);
const library = JSON.parse(
  await readFile(
    new URL("../public/shared-library.json", import.meta.url),
    "utf8",
  ),
);

test("ships a validated site-wide writing library without clinical notes", () => {
  assert.deepEqual(Object.keys(library).sort(), [
    "quicktexts",
    "templates",
    "updatedAt",
    "version",
    "vocabulary",
  ]);
  assert.equal(library.version, 1);
  assert.ok(Number.isFinite(library.updatedAt));
  assert.ok(Array.isArray(library.templates) && library.templates.length > 0);
  assert.ok(Array.isArray(library.quicktexts) && library.quicktexts.length > 0);
  assert.ok(Array.isArray(library.vocabulary));
  assert.equal("note" in library, false);
  assert.equal("noteHtml" in library, false);
  assert.equal("pdf" in library, false);
});

test("allows only the repository owner to publish library fields", () => {
  assert.match(page, /const webSharedLibraryFile = "public\/shared-library\.json"/);
  assert.match(page, /identity\.login\?\.toLowerCase\(\) !== webSharedLibraryOwner/);
  assert.match(
    page,
    /const sharedPayload: WebSharedLibraryPayload = \{\s*version: 1,\s*updatedAt,\s*templates,\s*quicktexts,\s*vocabulary,\s*\}/,
  );
  assert.match(page, /The key is\s*held only for this publication and is immediately forgotten/);
  assert.doesNotMatch(page, /localStorage\.setItem\([^\n]*githubPublishingToken/);
  assert.match(pagesHtml, /connect-src 'self' https:\/\/api\.github\.com/);
});
