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
      if (!seen.has(item.id)) {
        seen.add(item.id);
        ids.push(item.id);
      }
    }
  }
  return ids;
}

function conflictLeaf(value) {
  return String(value || "this PC")
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "this-pc";
}

function cloneConflictItem(item, collection, deviceName, sequence, now) {
  const suffix = `${now}-${sequence}`;
  const label = `Conflict from ${deviceName || "another PC"}`;
  const clone = { ...item, id: `${item.id}-conflict-${suffix}` };
  if (collection === "templates") {
    clone.name = `${item.name} (${label})`;
  } else if (collection === "quicktexts") {
    clone.shortcut = `${item.shortcut}.conflict-${conflictLeaf(deviceName)}-${sequence}`;
    clone.title = `${item.title} (${label})`;
  } else if (collection === "vocabulary") {
    clone.heard = `${item.heard} (${label.toLowerCase()})`;
  }
  return clone;
}

export function mergeCollectionThreeWay({
  base = [],
  remote = [],
  local = [],
  collection,
  deviceName,
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
            cloneConflictItem(
              localItem,
              collection,
              deviceName,
              conflicts.length,
              now,
            ),
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
        cloneConflictItem(
          localItem,
          collection,
          deviceName,
          conflicts.length,
          now,
        ),
      );
    }
  }

  return { items, conflicts };
}

function nextUpdatedAt(current, incoming, now) {
  return Math.max(
    now,
    Number(current?.updatedAt || 0) + 1,
    Number(incoming?.updatedAt || 0),
  );
}

export function reconcileTemplatePayload({
  current,
  incoming,
  base,
  deviceName,
  now = Date.now(),
}) {
  if (!current) {
    return {
      payload: {
        ...incoming,
        updatedAt: nextUpdatedAt(null, incoming, now),
        lastWriter: deviceName,
      },
      conflicts: [],
    };
  }
  const merge = mergeCollectionThreeWay({
    base: base?.templates || [],
    remote: current.templates,
    local: incoming.templates,
    collection: "templates",
    deviceName,
    now,
  });
  return {
    payload: {
      version: 1,
      updatedAt: nextUpdatedAt(current, incoming, now),
      lastWriter: deviceName,
      templates: merge.items,
    },
    conflicts: merge.conflicts,
  };
}

export function reconcileWritingToolsPayload({
  current,
  incoming,
  base,
  deviceName,
  now = Date.now(),
}) {
  if (!current) {
    return {
      payload: {
        ...incoming,
        updatedAt: nextUpdatedAt(null, incoming, now),
        lastWriter: deviceName,
      },
      conflicts: [],
    };
  }
  const quicktexts = mergeCollectionThreeWay({
    base: base?.quicktexts || [],
    remote: current.quicktexts,
    local: incoming.quicktexts,
    collection: "quicktexts",
    deviceName,
    now,
  });
  const vocabulary = mergeCollectionThreeWay({
    base: base?.vocabulary || [],
    remote: current.vocabulary,
    local: incoming.vocabulary,
    collection: "vocabulary",
    deviceName,
    now,
  });
  return {
    payload: {
      version: 1,
      updatedAt: nextUpdatedAt(current, incoming, now),
      lastWriter: deviceName,
      quicktexts: quicktexts.items,
      vocabulary: vocabulary.items,
    },
    conflicts: [...quicktexts.conflicts, ...vocabulary.conflicts],
  };
}
