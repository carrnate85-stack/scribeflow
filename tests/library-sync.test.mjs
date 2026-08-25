import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileTemplatePayload,
  reconcileWritingToolsPayload,
} from "../scripts/library-sync-utils.mjs";

const template = (id, name, content) => ({
  id,
  name,
  type: "Test",
  description: `${name} description`,
  content,
});

const quicktext = (id, shortcut, content) => ({
  id,
  shortcut,
  title: shortcut,
  category: "Test",
  content,
});

const vocabulary = (id, heard, replacement) => ({
  id,
  heard,
  replacement,
});

test("merges unrelated template edits from two computers", () => {
  const base = {
    version: 1,
    updatedAt: 100,
    templates: [template("a", "A", "base A"), template("b", "B", "base B")],
  };
  const current = {
    ...base,
    updatedAt: 200,
    templates: [template("a", "A", "remote A"), template("b", "B", "base B")],
  };
  const incoming = {
    ...base,
    updatedAt: 210,
    templates: [template("a", "A", "base A"), template("b", "B", "local B")],
  };

  const result = reconcileTemplatePayload({
    current,
    incoming,
    base,
    deviceName: "Office-PC",
    now: 300,
  });

  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(
    result.payload.templates.map((item) => item.content),
    ["remote A", "local B"],
  );
  assert.equal(result.payload.lastWriter, "Office-PC");
});

test("preserves both versions of a concurrently edited template", () => {
  const base = {
    version: 1,
    updatedAt: 100,
    templates: [template("a", "Consult", "base")],
  };
  const result = reconcileTemplatePayload({
    current: {
      ...base,
      updatedAt: 200,
      templates: [template("a", "Consult", "remote edit")],
    },
    incoming: {
      ...base,
      updatedAt: 210,
      templates: [template("a", "Consult", "local edit")],
    },
    base,
    deviceName: "Laptop",
    now: 300,
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.payload.templates.length, 2);
  assert.equal(result.payload.templates[0].content, "remote edit");
  assert.match(result.payload.templates[1].name, /Conflict from Laptop/);
  assert.equal(result.payload.templates[1].content, "local edit");
});

test("does not silently delete a template edited on another computer", () => {
  const base = {
    version: 1,
    updatedAt: 100,
    templates: [template("a", "Follow-up", "base")],
  };
  const result = reconcileTemplatePayload({
    current: {
      ...base,
      updatedAt: 200,
      templates: [template("a", "Follow-up", "remote edit")],
    },
    incoming: { ...base, updatedAt: 210, templates: [] },
    base,
    deviceName: "Laptop",
    now: 300,
  });

  assert.equal(result.conflicts[0].type, "delete-versus-edit");
  assert.equal(result.payload.templates[0].content, "remote edit");
});

test("merges writing tools and labels competing Quicktext edits", () => {
  const base = {
    version: 1,
    updatedAt: 100,
    quicktexts: [quicktext("q1", ".plan", "base plan")],
    vocabulary: [vocabulary("v1", "ap-knee-ah", "apnea")],
  };
  const result = reconcileWritingToolsPayload({
    current: {
      ...base,
      updatedAt: 200,
      quicktexts: [quicktext("q1", ".plan", "remote plan")],
    },
    incoming: {
      ...base,
      updatedAt: 210,
      quicktexts: [quicktext("q1", ".plan", "local plan")],
      vocabulary: [
        vocabulary("v1", "ap-knee-ah", "apnea"),
        vocabulary("v2", "see-pap", "CPAP"),
      ],
    },
    base,
    deviceName: "Clinic PC",
    now: 300,
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.payload.quicktexts.length, 2);
  assert.equal(result.payload.quicktexts[0].content, "remote plan");
  assert.match(result.payload.quicktexts[1].shortcut, /\.conflict-Clinic-PC-/);
  assert.equal(result.payload.quicktexts[1].content, "local plan");
  assert.equal(result.payload.vocabulary.length, 2);
});

test("legacy writes without a base preserve previously synced items", () => {
  const result = reconcileTemplatePayload({
    current: {
      version: 1,
      updatedAt: 200,
      templates: [template("remote", "Remote", "remote")],
    },
    incoming: {
      version: 1,
      updatedAt: 210,
      templates: [template("local", "Local", "local")],
    },
    base: null,
    deviceName: "Older PC",
    now: 300,
  });

  assert.deepEqual(
    result.payload.templates.map((item) => item.id),
    ["remote", "local"],
  );
});
