import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("release workflow verifies the exact installer assets it builds", async () => {
  const workflow = await source("../.github/workflows/build-windows-installer.yml");

  assert.match(
    workflow,
    /\$zip = "\$env:RUNNER_TEMP\\ScribeFlow-Windows-Online-Installer\.zip"/,
  );
  assert.match(workflow, /Install ScribeFlow\\\.cmd\$/);
  assert.match(workflow, /Install-ScribeFlow\\\.ps1\$/);
  assert.doesNotMatch(
    workflow,
    /\$zip = "\$env:RUNNER_TEMP\\ScribeFlow-Online-Installer\.zip"/,
  );
  assert.match(workflow, /releases\/tags\/\$tag/);
  assert.match(workflow, /\$statusCode -ne 404/);
  assert.doesNotMatch(workflow, /gh release view \$tag --json isDraft/);
});

test("portable installer pins a patched Node 22 or newer runtime", async () => {
  const builder = await source("../scripts/build-portable-installer.ps1");
  const match = builder.match(
    /\$nodeVersion = "v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)"/,
  );
  assert.ok(match?.groups, "builder must pin an exact Node version");
  const actual = [
    Number(match.groups.major),
    Number(match.groups.minor),
    Number(match.groups.patch),
  ];
  const minimum = [22, 23, 2];
  const isCurrentEnough = actual.some((value, index) => {
    if (value === minimum[index]) return false;
    return (
      value > minimum[index] &&
      actual.slice(0, index).every((entry, prior) => entry === minimum[prior])
    );
  });
  assert.ok(
    isCurrentEnough || actual.every((value, index) => value === minimum[index]),
    `expected Node >= ${minimum.join(".")}, received ${actual.join(".")}`,
  );
});

test("portable installer excludes the web fallback template library", async () => {
  const builder = await source("../scripts/build-portable-installer.ps1");

  assert.match(builder, /dist\\client\\shared-library\.json/);
  assert.match(builder, /Remove-Item -LiteralPath \$webLibraryFallback/);
  assert.match(builder, /includesTemplates = \$false/);
});

test("third-party GitHub Actions are pinned to immutable commits", async () => {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const workflowFiles = (await readdir(workflowDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );
  for (const name of workflowFiles) {
    const workflow = await readFile(new URL(name, workflowDirectory), "utf8");
    for (const line of workflow.split(/\r?\n/)) {
      const action = line.match(/^\s*uses:\s*([^\s#]+)/)?.[1];
      if (!action || action.startsWith("./")) continue;
      assert.match(action, /@[0-9a-f]{40}$/i, `${name}: ${action}`);
    }
  }
});
