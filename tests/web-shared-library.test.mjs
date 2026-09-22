import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyWebLibraryOperations,
  createEmptyWebLibraryDeviceRecord,
  createWebLibraryOperation,
  diffWebLibraryPayload,
  materializeWebLibraryDeviceRecords,
  mergeWebSharedLibrary,
  parseWebLibraryDeviceRecord,
  payloadContainsWebLibraryMutations,
  pruneCoveredWebLibraryOperations,
  sanitizeTemplateHtml,
  stableWebLibraryJson,
  utf8ByteLength,
  webLibraryContextFromOperations,
  WEB_LIBRARY_DEVICE_MAX_BYTES,
  WEB_LIBRARY_MAX_BYTES,
} from "../app/web-library-utils.mjs";

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

test("saves only reusable writing-library fields automatically", () => {
  assert.match(page, /webSharedLibraryNamespace = "scribeflow-/);
  assert.match(page, /webSharedLibraryDevicePathPrefix = "library-device-v2-"/);
  assert.match(
    page,
    /const sharedPayload: WebSharedLibraryPayload = \{\s*version: 1,\s*updatedAt,\s*templates: nextTemplates,\s*quicktexts: nextQuicktexts,\s*vocabulary: nextVocabulary,\s*\}/,
  );
  assert.match(page, /method: "POST"/);
  assert.doesNotMatch(page, /githubPublishingToken|api\.github\.com/);
  assert.match(pagesHtml, /connect-src 'self' https:\/\/mantledb\.sh/);
});

test("keeps Mantle owner keys local and sends them only with writes", () => {
  assert.match(page, /fragment\.get\("mantle-key"\)/);
  assert.match(page, /webLibraryOwnerKey: "scribe-web-library-owner-key-v1"/);
  assert.match(page, /window\.history\.replaceState\(/);
  assert.match(page, /"X-Mantle-Key": activeOwnerKey/);
  assert.doesNotMatch(page, /[?&](?:key|mantle-key)=\$?\{/);
  assert.match(page, /method: "POST"/);
  assert.match(page, /method: "PUT"/);
  assert.match(page, /View only · owner key required to edit/);
  assert.match(page, /Reusable library fields are stored online\. Never put PHI/);
});

test("hardens template HTML, clinical editors, and PDF.js", () => {
  const sanitized = sanitizeTemplateHtml(
    '<div onclick="steal()">Safe<strong style="color:red"> text</strong>' +
      '<img src=x onerror=steal()><script>alert(1)</script><svg><a>bad</a></svg></div>',
  );
  assert.doesNotMatch(
    sanitized,
    /<(?:script|style|img|svg|a|form)|\son\w+=|\sstyle=/i,
  );
  assert.match(page, /sanitizeTemplateHtml\(template\.contentHtml\)/);
  assert.match(page, /const safeNoteHtml = sanitizeTemplateHtml/);
  assert.match(page, /isEvalSupported: false/);
  assert.match(page, /enableScripting: false/);
  assert.match(page, /aria-label="Clinical note editor"[\s\S]*?spellCheck=\{false\}/);
  assert.match(page, /data-enable-grammarly="false"/);
});

test("fallback template sanitization cannot assemble nested script tags", () => {
  const hostile = '<scr<br>ipt>alert(1)</scr</div>ipt>';
  const sanitized = sanitizeTemplateHtml(hostile, null);

  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /<|script|onerror|onclick/i);
});

test("three-way web merge preserves competing local and remote edits", () => {
  const template = (content) => ({
    id: "template-1",
    name: "Consult",
    type: "Test",
    description: "Reusable",
    content,
  });
  const base = {
    version: 1,
    updatedAt: 10,
    templates: [template("base")],
    quicktexts: [],
    vocabulary: [],
  };
  const result = mergeWebSharedLibrary({
    base,
    remote: { ...base, updatedAt: 20, templates: [template("remote")] },
    local: { ...base, updatedAt: 21, templates: [template("local")] },
    now: 30,
  });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.payload.templates.length, 2);
  assert.equal(result.payload.templates[0].content, "remote");
  assert.equal(result.payload.templates[1].content, "local");
  assert.match(result.payload.templates[1].name, /Conflict from this browser/);
});

const deviceA = "a".repeat(32);
const deviceB = "b".repeat(32);
const actorA = `${deviceA}.${"1".repeat(16)}`;
const actorB = `${deviceB}.${"2".repeat(16)}`;

function templateValue(content, id = "template-1") {
  return {
    id,
    name: "Consult",
    type: "Test",
    description: "Reusable",
    content,
  };
}

function recordWith(deviceId, operations) {
  return applyWebLibraryOperations(
    createEmptyWebLibraryDeviceRecord(deviceId, 10),
    operations,
    20,
  );
}

test("per-device records preserve unrelated interleaved computer writes", () => {
  const templateOperation = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 1,
    context: {},
    value: templateValue("from A"),
  });
  const quicktextOperation = createWebLibraryOperation({
    collection: "quicktexts",
    itemId: "quick-1",
    actorId: actorB,
    counter: 1,
    context: {},
    value: {
      id: "quick-1",
      shortcut: ".plan",
      title: "Plan",
      content: "from B",
      category: "Test",
    },
  });

  const result = materializeWebLibraryDeviceRecords([
    recordWith(deviceA, [templateOperation]),
    recordWith(deviceB, [quicktextOperation]),
  ]);
  assert.equal(result.payload.templates[0].content, "from A");
  assert.equal(result.payload.quicktexts[0].content, "from B");
  assert.equal(result.conflicts.length, 0);
});

test("concurrent edits to the same item are deterministic conflict copies", () => {
  const operationA = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 1,
    context: {},
    value: templateValue("from A"),
  });
  const operationB = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorB,
    counter: 1,
    context: {},
    value: templateValue("from B"),
  });
  const left = materializeWebLibraryDeviceRecords([
    recordWith(deviceA, [operationA]),
    recordWith(deviceB, [operationB]),
  ]);
  const right = materializeWebLibraryDeviceRecords([
    recordWith(deviceB, [operationB]),
    recordWith(deviceA, [operationA]),
  ]);

  assert.equal(left.conflicts.length, 1);
  assert.equal(left.payload.templates.length, 2);
  assert.deepEqual(left.payload, right.payload);
  assert.match(left.payload.templates[1].id, /-conflict-/);
  assert.deepEqual(
    new Set(left.payload.templates.map((item) => item.content)),
    new Set(["from A", "from B"]),
  );
});

test("multiple quicktext conflicts receive distinct durable shortcuts", () => {
  const deviceC = "c".repeat(32);
  const actorC = `${deviceC}.${"3".repeat(16)}`;
  const quicktext = (content) => ({
    id: "quick-1",
    shortcut: ".plan",
    title: "Plan",
    content,
    category: "Test",
  });
  const records = [
    [deviceA, actorA, "from A"],
    [deviceB, actorB, "from B"],
    [deviceC, actorC, "from C"],
  ].map(([deviceId, actorId, content]) =>
    recordWith(deviceId, [
      createWebLibraryOperation({
        collection: "quicktexts",
        itemId: "quick-1",
        actorId,
        counter: 1,
        context: {},
        value: quicktext(content),
      }),
    ]),
  );
  const result = materializeWebLibraryDeviceRecords(records);
  assert.equal(result.payload.quicktexts.length, 3);
  assert.equal(
    new Set(result.payload.quicktexts.map((item) => item.shortcut)).size,
    3,
  );
});

test("observed tombstones suppress old values without allowing stale resurrection", () => {
  const put = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 1,
    context: {},
    value: templateValue("original"),
  });
  const tombstone = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorB,
    counter: 1,
    context: webLibraryContextFromOperations([put]),
    tombstone: true,
  });
  const deleted = materializeWebLibraryDeviceRecords([
    recordWith(deviceA, [put]),
    recordWith(deviceB, [tombstone]),
  ]);
  assert.equal(deleted.payload.templates.length, 0);

  const offlineEdit = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 2,
    context: { [actorA]: 1 },
    value: templateValue("offline edit"),
  });
  const recovered = materializeWebLibraryDeviceRecords([
    recordWith(deviceA, [offlineEdit]),
    recordWith(deviceB, [tombstone]),
  ]);
  assert.equal(recovered.payload.templates[0].content, "offline edit");
  assert.equal(recovered.conflicts.length, 1);
  assert.equal(recovered.conflicts[0].hasTombstone, true);
});

test("causally covered operations compact without resurrecting deleted items", () => {
  const put = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 1,
    context: {},
    value: templateValue("old"),
  });
  const tombstone = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorB,
    counter: 1,
    context: webLibraryContextFromOperations([put]),
    tombstone: true,
  });
  const recordA = recordWith(deviceA, [put]);
  const recordB = recordWith(deviceB, [tombstone]);
  const compactedA = pruneCoveredWebLibraryOperations(recordA, [recordA, recordB]);
  assert.equal(compactedA.items.templates.length, 0);
  const result = materializeWebLibraryDeviceRecords([compactedA, recordB]);
  assert.equal(result.payload.templates.length, 0);
});

test("identical simultaneous migration seeds collapse without duplication", () => {
  const value = templateValue("same seed");
  const operationA = createWebLibraryOperation({
    collection: "templates",
    itemId: value.id,
    actorId: actorA,
    counter: 1,
    context: {},
    value,
  });
  const operationB = createWebLibraryOperation({
    collection: "templates",
    itemId: value.id,
    actorId: actorB,
    counter: 1,
    context: {},
    value,
  });
  const result = materializeWebLibraryDeviceRecords([
    recordWith(deviceA, [operationA]),
    recordWith(deviceB, [operationB]),
  ]);
  assert.equal(result.payload.templates.length, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.heads.get("templates\u0000template-1").length, 2);
});

test("device records validate ownership and serialize canonically", () => {
  const operation = createWebLibraryOperation({
    collection: "templates",
    itemId: "template-1",
    actorId: actorA,
    counter: 1,
    context: {},
    value: templateValue("valid"),
  });
  const record = recordWith(deviceA, [operation]);
  assert.deepEqual(
    parseWebLibraryDeviceRecord(stableWebLibraryJson(record)),
    record,
  );
  const forged = structuredClone(record);
  forged.items.templates[0].dot.actorId = actorB;
  assert.equal(parseWebLibraryDeviceRecord(forged), null);
  const ambiguousId = structuredClone(record);
  ambiguousId.items.templates[0].itemId = "template\u0000forged";
  assert.equal(parseWebLibraryDeviceRecord(ambiguousId), null);
  const oldV2Record = structuredClone(record);
  delete oldV2Record.canonicalFingerprints;
  assert.deepEqual(
    parseWebLibraryDeviceRecord(oldV2Record).canonicalFingerprints,
    [],
  );
  const markedRecord = {
    ...record,
    canonicalFingerprints: ["f".repeat(64)],
  };
  const markedWithAnotherOperation = applyWebLibraryOperations(
    markedRecord,
    [],
  );
  assert.deepEqual(markedWithAnotherOperation.canonicalFingerprints, [
    "f".repeat(64),
  ]);
  assert.equal(WEB_LIBRARY_DEVICE_MAX_BYTES, 60 * 1024);
});

test("an older full-record write is merged additively during v2 transition", () => {
  const remote = {
    version: 1,
    updatedAt: 20,
    templates: [
      templateValue("current v2"),
      templateValue("v2 only", "v2-only"),
    ],
    quicktexts: [],
    vocabulary: [],
  };
  const olderTabWrite = {
    version: 1,
    updatedAt: 30,
    templates: [templateValue("edited in v1")],
    quicktexts: [],
    vocabulary: [],
  };
  const merged = mergeWebSharedLibrary({
    base: null,
    remote,
    local: olderTabWrite,
    now: 40,
  });
  assert.equal(merged.payload.templates.length, 3);
  assert.equal(
    merged.payload.templates.find((item) => item.id === "template-1").content,
    "current v2",
  );
  assert.ok(
    merged.payload.templates.some((item) => item.content === "edited in v1"),
  );
  assert.ok(merged.payload.templates.some((item) => item.id === "v2-only"));
});

test("payload diffs create item-level puts and tombstones only", () => {
  const before = {
    version: 1,
    updatedAt: 1,
    templates: [templateValue("before")],
    quicktexts: [],
    vocabulary: [{ id: "v-1", heard: "old", replacement: "term" }],
  };
  const after = {
    ...before,
    updatedAt: 2,
    templates: [templateValue("after")],
    vocabulary: [],
  };
  const mutations = diffWebLibraryPayload(before, after);
  assert.equal(mutations.length, 2);
  assert.equal(
    mutations.find((mutation) => mutation.itemId === "template-1").tombstone,
    false,
  );
  assert.equal(
    mutations.find((mutation) => mutation.itemId === "v-1").tombstone,
    true,
  );
  assert.equal(payloadContainsWebLibraryMutations(after, mutations), true);
  assert.equal(payloadContainsWebLibraryMutations(before, mutations), false);
});

test("web sync preserves dirty copies and keeps ten local snapshots", () => {
  assert.match(page, /webSharedLibraryDirtyRef\.current/);
  assert.match(page, /\.slice\(0, 10\)/);
  assert.match(page, /Browser changes preserved · retry sync/);
  assert.match(page, /fallbackPayload\.updatedAt > localPayload\.updatedAt/);
  assert.match(page, /const savedLatestLocal =/);
  assert.match(page, /webSharedLibraryMutationEpochRef/);
  assert.match(page, /knownHeadsAtEdit/);
  assert.match(page, /recoveryOperations/);
  assert.match(
    page,
    /webSharedLibraryDirtyRef\.current\s*&&\s*pending\.length === 0/,
  );
  assert.match(
    page,
    /refreshEpoch !== webLibraryRefreshEpochRef\.current/,
  );
  assert.match(page, /Newer browser changes are preserved/);
  assert.match(page, /setInterval\([\s\S]*?300_000/);
  assert.match(page, /Restore this reusable library snapshot\?/);
  assert.match(page, /Library access & backups/);
});

test("web saves use isolated public device records and a same-browser lock", () => {
  assert.match(page, /navigator as Navigator & \{ locks\?/);
  assert.match(page, /withWebLibraryWriteLock/);
  assert.match(page, /const immutableBatchKey =/);
  assert.match(page, /remaining\.length === parsed\.length/);
  assert.match(page, /fetchWebLibraryDeviceRecords/);
  assert.match(page, /webSharedLibraryDeviceVisibilityUrl/);
  assert.match(page, /public_read: true/);
  assert.match(page, /materializeWebLibraryDeviceRecords/);
  assert.match(page, /canonicalFingerprints/);
  assert.match(page, /fetchWebSharedCanonical/);
  assert.match(page, /The older compatibility library changed during this save/);
  assert.match(page, /The canonical v1 record is compatibility-only/);
});

test("web sync rejects libraries above its conservative Mantle size cap", () => {
  assert.equal(WEB_LIBRARY_MAX_BYTES, 60 * 1024);
  assert.equal(utf8ByteLength("plain"), 5);
  assert.equal(utf8ByteLength("🩺"), 4);
  assert.match(
    page,
    /utf8ByteLength\(serializedRecord\) > WEB_LIBRARY_DEVICE_MAX_BYTES/,
  );
  assert.match(page, /Library too large to sync/);
  assert.match(page, /browser changes preserved/);
});

test("blocks the web workspace when embedded by another site", () => {
  assert.match(page, /window\.top !== window\.self/);
  assert.match(page, /if \(webEdition && isFramed\)/);
  assert.match(page, /ScribeFlow cannot run inside another site/);
  assert.match(page, /clickjacking protection/);
});
