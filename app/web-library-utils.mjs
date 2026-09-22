const ALLOWED_TEMPLATE_ELEMENTS = new Set(["DIV", "BR", "STRONG", "B", "U"]);
const BLOCKED_TEMPLATE_ELEMENTS = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "SVG",
  "MATH",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "LINK",
  "META",
  "BASE",
  "IMG",
  "VIDEO",
  "AUDIO",
  "SOURCE",
]);

export const WEB_LIBRARY_MAX_BYTES = 60 * 1024;
export const WEB_LIBRARY_DEVICE_MAX_BYTES = 60 * 1024;
export const WEB_LIBRARY_DEVICE_SCHEMA = 2;
export const WEB_LIBRARY_COLLECTIONS = [
  "templates",
  "quicktexts",
  "vocabulary",
];

const DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/;
const ACTOR_ID_PATTERN = /^[a-f0-9]{32}\.[a-f0-9]{16}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DEVICE_OPERATIONS = 2048;
const MAX_CANONICAL_FINGERPRINTS = 16;

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])]),
  );
}

export function stableWebLibraryJson(value) {
  return JSON.stringify(stableObject(value));
}

function normalizeContext(value) {
  if (!isPlainObject(value)) return null;
  const context = {};
  for (const [actorId, counter] of Object.entries(value)) {
    if (
      !ACTOR_ID_PATTERN.test(actorId) ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      return null;
    }
    if (counter > 0) context[actorId] = counter;
  }
  return context;
}

function normalizeDeviceOperation(value, collection, deviceId) {
  if (!isPlainObject(value)) return null;
  if (
    typeof value.itemId !== "string" ||
    value.itemId.length < 1 ||
    value.itemId.length > 200 ||
    value.itemId.includes("\u0000") ||
    !isPlainObject(value.dot) ||
    typeof value.dot.actorId !== "string" ||
    !ACTOR_ID_PATTERN.test(value.dot.actorId) ||
    !value.dot.actorId.startsWith(`${deviceId}.`) ||
    !Number.isSafeInteger(value.dot.counter) ||
    value.dot.counter < 1 ||
    typeof value.tombstone !== "boolean"
  ) {
    return null;
  }
  const context = normalizeContext(value.context);
  if (!context) return null;
  if (!value.tombstone && !isPlainObject(value.value)) return null;
  return {
    collection,
    itemId: value.itemId,
    dot: {
      actorId: value.dot.actorId,
      counter: value.dot.counter,
    },
    context,
    tombstone: value.tombstone,
    ...(value.tombstone ? {} : { value: stableObject(value.value) }),
  };
}

export function parseWebLibraryDeviceRecord(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (
      !isPlainObject(parsed) ||
      parsed.schema !== WEB_LIBRARY_DEVICE_SCHEMA ||
      typeof parsed.deviceId !== "string" ||
      !DEVICE_ID_PATTERN.test(parsed.deviceId) ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      !isPlainObject(parsed.items) ||
      (parsed.canonicalFingerprints !== undefined &&
        (!Array.isArray(parsed.canonicalFingerprints) ||
          parsed.canonicalFingerprints.length > MAX_CANONICAL_FINGERPRINTS ||
          !parsed.canonicalFingerprints.every(
            (fingerprint) =>
              typeof fingerprint === "string" &&
              FINGERPRINT_PATTERN.test(fingerprint),
          )))
    ) {
      return null;
    }

    const items = { templates: [], quicktexts: [], vocabulary: [] };
    let operationCount = 0;
    for (const collection of WEB_LIBRARY_COLLECTIONS) {
      const source = parsed.items[collection];
      if (!Array.isArray(source)) return null;
      for (const candidate of source) {
        const operation = normalizeDeviceOperation(
          candidate,
          collection,
          parsed.deviceId,
        );
        if (!operation) return null;
        items[collection].push(operation);
        operationCount += 1;
        if (operationCount > MAX_DEVICE_OPERATIONS) return null;
      }
    }

    return canonicalizeWebLibraryDeviceRecord({
      schema: WEB_LIBRARY_DEVICE_SCHEMA,
      deviceId: parsed.deviceId,
      updatedAt: parsed.updatedAt,
      canonicalFingerprints: parsed.canonicalFingerprints || [],
      items,
    });
  } catch {
    return null;
  }
}

function operationKey(operation) {
  return `${operation.collection}\u0000${operation.itemId}\u0000${operation.dot.actorId}`;
}

function dotKey(operation) {
  return `${operation.dot.actorId}:${operation.dot.counter}`;
}

function compareOperations(left, right) {
  return (
    left.collection.localeCompare(right.collection) ||
    left.itemId.localeCompare(right.itemId) ||
    left.dot.actorId.localeCompare(right.dot.actorId) ||
    left.dot.counter - right.dot.counter
  );
}

export function canonicalizeWebLibraryDeviceRecord(record) {
  const items = { templates: [], quicktexts: [], vocabulary: [] };
  for (const collection of WEB_LIBRARY_COLLECTIONS) {
    items[collection] = (record.items?.[collection] || [])
      .map((operation) => ({
        itemId: operation.itemId,
        dot: {
          actorId: operation.dot.actorId,
          counter: operation.dot.counter,
        },
        context: Object.fromEntries(
          Object.entries(operation.context || {})
            .filter(([, counter]) => counter > 0)
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        tombstone: Boolean(operation.tombstone),
        ...(operation.tombstone
          ? {}
          : { value: stableObject(operation.value) }),
      }))
      .sort((left, right) =>
        compareOperations(
          { ...left, collection },
          { ...right, collection },
        ),
      );
  }
  return {
    schema: WEB_LIBRARY_DEVICE_SCHEMA,
    deviceId: record.deviceId,
    updatedAt: Number(record.updatedAt) || 0,
    canonicalFingerprints: Array.from(
      new Set(
        (record.canonicalFingerprints || []).filter(
          (fingerprint) =>
            typeof fingerprint === "string" &&
            FINGERPRINT_PATTERN.test(fingerprint),
        ),
      ),
    ).slice(-MAX_CANONICAL_FINGERPRINTS),
    items,
  };
}

export function createEmptyWebLibraryDeviceRecord(deviceId, updatedAt = Date.now()) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error("Invalid web library device id");
  }
  return canonicalizeWebLibraryDeviceRecord({
    schema: WEB_LIBRARY_DEVICE_SCHEMA,
    deviceId,
    updatedAt,
    canonicalFingerprints: [],
    items: { templates: [], quicktexts: [], vocabulary: [] },
  });
}

export function mergeWebLibraryDeviceRecords(records, deviceId) {
  const validRecords = records
    .map((record) => parseWebLibraryDeviceRecord(record))
    .filter((record) => record && record.deviceId === deviceId);
  const merged = createEmptyWebLibraryDeviceRecord(
    deviceId,
    Math.max(Date.now(), ...validRecords.map((record) => record.updatedAt)),
  );
  merged.canonicalFingerprints = validRecords.flatMap(
    (record) => record.canonicalFingerprints,
  );
  const latest = new Map();
  for (const record of validRecords) {
    for (const collection of WEB_LIBRARY_COLLECTIONS) {
      for (const operation of record.items[collection]) {
        const key = operationKey({ ...operation, collection });
        const existing = latest.get(key);
        if (
          !existing ||
          operation.dot.counter > existing.dot.counter ||
          (operation.dot.counter === existing.dot.counter &&
            stableWebLibraryJson(operation) > stableWebLibraryJson(existing))
        ) {
          latest.set(key, { ...operation, collection });
        }
      }
    }
  }
  for (const operation of latest.values()) {
    const { collection, ...stored } = operation;
    merged.items[collection].push(stored);
  }
  return canonicalizeWebLibraryDeviceRecord(merged);
}

export function mergeWebLibraryContexts(...contexts) {
  const merged = {};
  for (const context of contexts) {
    if (!context) continue;
    for (const [actorId, counter] of Object.entries(context)) {
      if (!ACTOR_ID_PATTERN.test(actorId) || !Number.isSafeInteger(counter)) {
        continue;
      }
      merged[actorId] = Math.max(merged[actorId] || 0, counter);
    }
  }
  return merged;
}

export function webLibraryContextFromOperations(operations) {
  let context = {};
  for (const operation of operations || []) {
    context = mergeWebLibraryContexts(context, operation.context, {
      [operation.dot.actorId]: operation.dot.counter,
    });
  }
  return context;
}

/**
 * @param {{
 *   collection: string,
 *   itemId: string,
 *   actorId: string,
 *   counter: number,
 *   context?: Record<string, number>,
 *   tombstone?: boolean,
 *   value?: any
 * }} options
 */
export function createWebLibraryOperation({
  collection,
  itemId,
  actorId,
  counter,
  context = {},
  tombstone = false,
  value = undefined,
}) {
  if (!WEB_LIBRARY_COLLECTIONS.includes(collection)) {
    throw new Error("Invalid web library collection");
  }
  const deviceId = actorId.split(".")[0];
  const operation = normalizeDeviceOperation(
    {
      itemId,
      dot: { actorId, counter },
      context,
      tombstone,
      ...(tombstone ? {} : { value }),
    },
    collection,
    deviceId,
  );
  if (!operation) throw new Error("Invalid web library operation");
  return operation;
}

export function applyWebLibraryOperations(record, operations, now = Date.now()) {
  const parsed = parseWebLibraryDeviceRecord(record);
  if (!parsed) throw new Error("Invalid web library device record");
  const latest = new Map();
  for (const collection of WEB_LIBRARY_COLLECTIONS) {
    for (const operation of parsed.items[collection]) {
      latest.set(operationKey({ ...operation, collection }), {
        ...operation,
        collection,
      });
    }
  }
  for (const operation of operations) {
    if (!operation || !WEB_LIBRARY_COLLECTIONS.includes(operation.collection)) {
      throw new Error("Invalid web library operation");
    }
    const normalized = normalizeDeviceOperation(
      operation,
      operation.collection,
      parsed.deviceId,
    );
    if (!normalized) throw new Error("Invalid web library operation");
    const key = operationKey(normalized);
    const existing = latest.get(key);
    if (!existing || normalized.dot.counter >= existing.dot.counter) {
      latest.set(key, normalized);
    }
  }
  const next = createEmptyWebLibraryDeviceRecord(parsed.deviceId, now);
  next.canonicalFingerprints = parsed.canonicalFingerprints;
  for (const operation of latest.values()) {
    const { collection, ...stored } = operation;
    next.items[collection].push(stored);
  }
  return canonicalizeWebLibraryDeviceRecord(next);
}

export function pruneCoveredWebLibraryOperations(
  record,
  allRecords,
  now = Date.now(),
) {
  const parsed = parseWebLibraryDeviceRecord(record);
  if (!parsed) throw new Error("Invalid web library device record");
  const allOperations = [];
  for (const candidateRecord of allRecords) {
    const candidate = parseWebLibraryDeviceRecord(candidateRecord);
    if (!candidate) continue;
    for (const collection of WEB_LIBRARY_COLLECTIONS) {
      allOperations.push(
        ...candidate.items[collection].map((operation) => ({
          ...operation,
          collection,
        })),
      );
    }
  }
  const next = createEmptyWebLibraryDeviceRecord(parsed.deviceId, now);
  next.canonicalFingerprints = parsed.canonicalFingerprints;
  for (const collection of WEB_LIBRARY_COLLECTIONS) {
    for (const operation of parsed.items[collection]) {
      const candidate = { ...operation, collection };
      const covered = allOperations.some(
        (other) =>
          other.collection === collection &&
          other.itemId === operation.itemId &&
          dotKey(other) !== dotKey(candidate) &&
          operationIsCovered(candidate, other),
      );
      if (!covered) next.items[collection].push(operation);
    }
  }
  return canonicalizeWebLibraryDeviceRecord(next);
}

function operationIsCovered(operation, candidate) {
  return (
    candidate !== operation &&
    Number(candidate.context?.[operation.dot.actorId] || 0) >=
      operation.dot.counter
  );
}

function cloneConflictValue(collection, value, conflictId) {
  const clone = { ...value, id: conflictId };
  if (collection === "templates") {
    clone.name = `${value.name} (Conflict from another computer)`;
  } else if (collection === "quicktexts") {
    const suffix = conflictId.slice(-12).replace(/[^a-z0-9]/gi, "");
    clone.shortcut = `${value.shortcut}.conflict${suffix}`;
    clone.title = `${value.title} (Conflict from another computer)`;
  } else {
    clone.heard = `${value.heard} (conflict from another computer)`;
  }
  return clone;
}

function conflictIdFor(itemId, operation) {
  const suffix =
    "-conflict-" +
    operation.dot.actorId.replace(".", "-") +
    "-" +
    operation.dot.counter;
  return itemId.slice(0, Math.max(1, 200 - suffix.length)) + suffix;
}

export function materializeWebLibraryDeviceRecords(records, now = Date.now()) {
  const validRecords = records
    .map((record) => parseWebLibraryDeviceRecord(record))
    .filter(Boolean);
  const groups = new Map();
  let updatedAt = 0;
  for (const record of validRecords) {
    updatedAt = Math.max(updatedAt, record.updatedAt);
    for (const collection of WEB_LIBRARY_COLLECTIONS) {
      for (const stored of record.items[collection]) {
        const operation = { ...stored, collection, deviceId: record.deviceId };
        const key = `${collection}\u0000${operation.itemId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(operation);
      }
    }
  }

  const payload = {
    version: 1,
    updatedAt: updatedAt || now,
    templates: [],
    quicktexts: [],
    vocabulary: [],
  };
  const heads = new Map();
  const conflicts = [];

  for (const [groupKey, candidates] of groups) {
    const [collection, itemId] = groupKey.split("\u0000");
    const dots = new Map();
    for (const candidate of candidates) {
      const key = dotKey(candidate);
      const existing = dots.get(key);
      if (
        !existing ||
        stableWebLibraryJson(candidate) > stableWebLibraryJson(existing)
      ) {
        dots.set(key, candidate);
      }
    }
    const unique = Array.from(dots.values());
    const currentHeads = unique
      .filter(
        (operation) =>
          !unique.some((candidate) => operationIsCovered(operation, candidate)),
      )
      .sort((left, right) => dotKey(left).localeCompare(dotKey(right)));
    heads.set(groupKey, currentHeads);

    const putGroups = new Map();
    for (const operation of currentHeads.filter((head) => !head.tombstone)) {
      const key = stableWebLibraryJson(operation.value);
      if (!putGroups.has(key)) putGroups.set(key, []);
      putGroups.get(key).push(operation);
    }
    const distinctPuts = Array.from(putGroups.values()).sort((left, right) =>
      dotKey(left[0]).localeCompare(dotKey(right[0])),
    );
    if (distinctPuts.length === 0) continue;

    payload[collection].push(distinctPuts[0][0].value);
    const materializedCopies = [];
    for (const operations of distinctPuts.slice(1)) {
      const representative = operations[0];
      const conflictId = conflictIdFor(itemId, representative);
      const value = cloneConflictValue(
        collection,
        representative.value,
        conflictId,
      );
      if (!groups.has(`${collection}\u0000${conflictId}`)) {
        payload[collection].push(value);
      }
      materializedCopies.push({ conflictId, value, operations });
    }

    const hasTombstone = currentHeads.some((head) => head.tombstone);
    if (distinctPuts.length > 1 || hasTombstone) {
      conflicts.push({
        collection,
        itemId,
        heads: currentHeads,
        primary: distinctPuts[0][0].value,
        copies: materializedCopies,
        hasTombstone,
      });
    }
  }

  for (const collection of WEB_LIBRARY_COLLECTIONS) {
    payload[collection].sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    );
  }
  return { payload, heads, conflicts, records: validRecords };
}

export function diffWebLibraryPayload(previous, next) {
  const mutations = [];
  for (const collection of WEB_LIBRARY_COLLECTIONS) {
    const previousItems = new Map(
      (previous?.[collection] || []).map((item) => [item.id, item]),
    );
    const nextItems = new Map(
      (next?.[collection] || []).map((item) => [item.id, item]),
    );
    const ids = new Set([...previousItems.keys(), ...nextItems.keys()]);
    for (const itemId of ids) {
      const before = previousItems.get(itemId);
      const after = nextItems.get(itemId);
      if (stableWebLibraryJson(before) === stableWebLibraryJson(after)) continue;
      mutations.push({
        collection,
        itemId,
        tombstone: !after,
        ...(after ? { value: after } : {}),
      });
    }
  }
  return mutations;
}

export function payloadContainsWebLibraryMutations(payload, mutations) {
  for (const mutation of mutations || []) {
    if (!WEB_LIBRARY_COLLECTIONS.includes(mutation?.collection)) return false;
    const current = (payload?.[mutation.collection] || []).find(
      (item) => item?.id === mutation.itemId,
    );
    if (mutation.tombstone) {
      if (current) return false;
      continue;
    }
    if (stableWebLibraryJson(current) !== stableWebLibraryJson(mutation.value)) {
      return false;
    }
  }
  return true;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fallbackSanitizeTemplateHtml(value) {
  // Without a DOM parser, retain text only. A single left-to-right pass never
  // rewrites the input, so nested tag fragments cannot assemble a new tag.
  let insideTag = false;
  let text = "";
  for (const character of String(value || "")) {
    if (!insideTag && character === "<") {
      insideTag = true;
    } else if (insideTag && character === ">") {
      insideTag = false;
    } else if (!insideTag) {
      text += character;
    }
  }
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/**
 * Keep only inert text and the tiny formatting subset used by templates.
 * A fresh DOM is constructed so no source attributes or element instances
 * survive serialization.
 */
export function sanitizeTemplateHtml(value, documentObject = globalThis.document) {
  if (typeof value !== "string" || !value) return "";
  if (!documentObject?.createElement) {
    return fallbackSanitizeTemplateHtml(value);
  }

  const source = documentObject.createElement("template");
  source.innerHTML = value;
  const output = documentObject.createElement("div");

  const copyChildren = (sourceParent, outputParent) => {
    for (const child of Array.from(sourceParent.childNodes)) {
      if (child.nodeType === 3) {
        outputParent.appendChild(documentObject.createTextNode(child.data));
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tagName = child.tagName.toUpperCase();
      if (BLOCKED_TEMPLATE_ELEMENTS.has(tagName)) continue;
      if (!ALLOWED_TEMPLATE_ELEMENTS.has(tagName)) {
        copyChildren(child, outputParent);
        continue;
      }

      const cleanElement = documentObject.createElement(tagName.toLowerCase());
      if (tagName !== "BR") copyChildren(child, cleanElement);
      outputParent.appendChild(cleanElement);
    }
  };

  copyChildren(source.content, output);
  return output.innerHTML;
}

function stableValue(value) {
  return JSON.stringify(value);
}

function valuesMatch(left, right) {
  return stableValue(left) === stableValue(right);
}

function orderedIds(...collections) {
  const ids = [];
  const seen = new Set();
  for (const collection of collections) {
    for (const item of collection || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      ids.push(item.id);
    }
  }
  return ids;
}

function cloneConflictItem(item, collection, sequence, now) {
  const label = "Conflict from this browser";
  const suffix = `-conflict-${now}-${sequence}`;
  const clone = {
    ...item,
    id: item.id.slice(0, Math.max(1, 200 - suffix.length)) + suffix,
  };
  if (collection === "templates") {
    clone.name = `${item.name} (${label})`;
  } else if (collection === "quicktexts") {
    clone.shortcut = `${item.shortcut}.conflict-browser-${sequence}`;
    clone.title = `${item.title} (${label})`;
  } else if (collection === "vocabulary") {
    clone.heard = `${item.heard} (${label.toLowerCase()})`;
  }
  return clone;
}

export function mergeWebLibraryCollection({
  base = [],
  remote = [],
  local = [],
  collection,
  now = Date.now(),
}) {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const items = [];
  const conflicts = [];

  for (const id of orderedIds(base, remote, local)) {
    const baseItem = baseById.get(id);
    const remoteItem = remoteById.get(id);
    const localItem = localById.get(id);

    if (!baseItem) {
      if (remoteItem && localItem) {
        items.push(remoteItem);
        if (!valuesMatch(remoteItem, localItem)) {
          conflicts.push({ collection, id, type: "concurrent-add" });
          items.push(
            cloneConflictItem(localItem, collection, conflicts.length, now),
          );
        }
      } else if (remoteItem || localItem) {
        items.push(remoteItem || localItem);
      }
      continue;
    }

    if (!remoteItem && !localItem) continue;
    if (!localItem && remoteItem) {
      if (!valuesMatch(remoteItem, baseItem)) {
        items.push(remoteItem);
        conflicts.push({ collection, id, type: "delete-versus-edit" });
      }
      continue;
    }
    if (localItem && !remoteItem) {
      if (!valuesMatch(localItem, baseItem)) {
        items.push(localItem);
        conflicts.push({ collection, id, type: "edit-versus-delete" });
      }
      continue;
    }

    const remoteChanged = !valuesMatch(remoteItem, baseItem);
    const localChanged = !valuesMatch(localItem, baseItem);
    if (!remoteChanged && !localChanged) {
      items.push(baseItem);
    } else if (remoteChanged && !localChanged) {
      items.push(remoteItem);
    } else if (!remoteChanged && localChanged) {
      items.push(localItem);
    } else if (valuesMatch(remoteItem, localItem)) {
      items.push(remoteItem);
    } else {
      items.push(remoteItem);
      conflicts.push({ collection, id, type: "concurrent-edit" });
      items.push(
        cloneConflictItem(localItem, collection, conflicts.length, now),
      );
    }
  }

  return { items, conflicts };
}

export function mergeWebSharedLibrary({ base, remote, local, now = Date.now() }) {
  const templates = mergeWebLibraryCollection({
    base: base?.templates,
    remote: remote.templates,
    local: local.templates,
    collection: "templates",
    now,
  });
  const quicktexts = mergeWebLibraryCollection({
    base: base?.quicktexts,
    remote: remote.quicktexts,
    local: local.quicktexts,
    collection: "quicktexts",
    now,
  });
  const vocabulary = mergeWebLibraryCollection({
    base: base?.vocabulary,
    remote: remote.vocabulary,
    local: local.vocabulary,
    collection: "vocabulary",
    now,
  });

  return {
    payload: {
      version: 1,
      updatedAt: Math.max(
        now,
        Number(remote.updatedAt || 0) + 1,
        Number(local.updatedAt || 0) + 1,
      ),
      templates: templates.items,
      quicktexts: quicktexts.items,
      vocabulary: vocabulary.items,
    },
    conflicts: [
      ...templates.conflicts,
      ...quicktexts.conflicts,
      ...vocabulary.conflicts,
    ],
  };
}
