import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sanitizeDocumentFileStem(value) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  return cleaned || "Clinical note";
}

export function buildNoteDocument({ title, note, noteHtml }) {
  const documentTitle = sanitizeDocumentFileStem(title);
  const body =
    typeof noteHtml === "string" && noteHtml.trim()
      ? noteHtml
      : escapeHtml(String(note || "")).replace(/\r?\n/g, "<br>");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    body { max-width: 760px; margin: 48px auto; color: #182321; font: 16px/1.7 Georgia, serif; }
    h1 { margin-bottom: 28px; font: 600 24px/1.2 Georgia, serif; }
  </style>
</head>
<body>
  <h1>${escapeHtml(documentTitle)}</h1>
  <div>${body}</div>
</body>
</html>`;
}

export function saveNoteDocument(notesRoot, payload, now = new Date()) {
  mkdirSync(notesRoot, { recursive: true });
  const stem = sanitizeDocumentFileStem(payload.title);
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-")
    .replace("T", " ");
  const document = buildNoteDocument(payload);

  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const fileName = `${stem} - ${timestamp}${suffix === 1 ? "" : ` (${suffix})`}.html`;
    const filePath = resolve(notesRoot, fileName);
    try {
      writeFileSync(filePath, document, {
        encoding: "utf8",
        flag: "wx",
      });
      return { fileName, filePath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  throw new Error("A unique note filename could not be created");
}
