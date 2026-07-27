import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteVerifiedPdf } from "../scripts/pdf-delete-utils.mjs";

test("deletes only the exact PDF matching its size and SHA-256", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "scribeflow-pdf-delete-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const name = "selected-onboarding.pdf";
  const filePath = join(root, name);
  const contents = Buffer.from("%PDF-1.7\nSynthetic ScribeFlow deletion test\n");
  await writeFile(filePath, contents);

  deleteVerifiedPdf(root, {
    name,
    size: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });

  await assert.rejects(access(filePath));
});

test("refuses deletion when the PDF hash does not match", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "scribeflow-pdf-keep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const name = "keep-this.pdf";
  const filePath = join(root, name);
  const contents = Buffer.from("%PDF-1.7\nDo not delete this mismatched file\n");
  await writeFile(filePath, contents);

  assert.throws(() =>
    deleteVerifiedPdf(root, {
      name,
      size: contents.length,
      sha256: "0".repeat(64),
    }),
  );
  await access(filePath);
});
