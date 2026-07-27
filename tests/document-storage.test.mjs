import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  buildNoteDocument,
  sanitizeDocumentFileStem,
  saveNoteDocument,
} from "../scripts/document-storage-utils.mjs";

test("sanitizes Windows document filenames", () => {
  assert.equal(
    sanitizeDocumentFileStem('  Follow-up: <test> / "visit"  '),
    "Follow-up test visit",
  );
  assert.equal(sanitizeDocumentFileStem("..."), "Clinical note");
});

test("builds an openable note without putting title markup into HTML", () => {
  const document = buildNoteDocument({
    title: "A&B <visit>",
    note: "First line\nSecond line",
    noteHtml: "",
  });
  assert.match(document, /<title>A&amp;B visit<\/title>/);
  assert.match(document, /First line<br>Second line/);
  assert.doesNotMatch(document, /<title>.*<visit>/);
});

test("saves unique notes only inside the configured Notes folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribeflow-notes-"));
  try {
    const now = new Date("2026-07-27T14:30:45.000Z");
    const payload = {
      title: "Follow-up",
      note: "Reviewed locally.",
      noteHtml: "<b>Reviewed locally.</b>",
    };
    const first = saveNoteDocument(root, payload, now);
    const second = saveNoteDocument(root, payload, now);

    assert.equal(basename(first.filePath), first.fileName);
    assert.match(first.fileName, /^Follow-up - 2026-07-27 14-30-45Z\.html$/);
    assert.match(second.fileName, /\(2\)\.html$/);
    assert.equal(existsSync(first.filePath), true);
    assert.match(readFileSync(first.filePath, "utf8"), /Reviewed locally/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
