import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, resolve, sep } from "node:path";

export function deleteVerifiedPdf(root, payload) {
  const deleteRoot = resolve(root);
  const name = typeof payload?.name === "string" ? payload.name : "";
  const size = Number(payload?.size);
  const sha256 =
    typeof payload?.sha256 === "string" ? payload.sha256.toLowerCase() : "";

  if (
    !name ||
    basename(name) !== name ||
    extname(name).toLowerCase() !== ".pdf" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 25 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error("Invalid PDF deletion request");
  }

  const filePath = resolve(deleteRoot, name);
  if (
    !filePath.startsWith(`${deleteRoot}${sep}`) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile() ||
    statSync(filePath).size !== size
  ) {
    throw new Error("The selected PDF was not found in Downloads");
  }

  const actualSha256 = createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
  if (actualSha256 !== sha256) {
    throw new Error("The Downloads PDF did not match the selected file");
  }

  unlinkSync(filePath);
}
