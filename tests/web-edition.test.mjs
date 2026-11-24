import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function readWebEditionBuild() {
  const outputRoot = new URL("../dist-pages/", import.meta.url);
  const html = await readFile(new URL("index.html", outputRoot), "utf8");
  const assetNames = await readdir(new URL("assets/", outputRoot));
  const entryBundles = assetNames.filter(
    (name) => name.startsWith("index-") && name.endsWith(".js"),
  );
  assert.ok(entryBundles.length > 0, "expected a built web entry bundle");
  const javascript = (
    await Promise.all(
      entryBundles.map((name) =>
        readFile(new URL(`assets/${name}`, outputRoot), "utf8"),
      ),
    )
  ).join("\n");
  return { html, source: `${html}\n${javascript}` };
}

test("builds the Dragon-ready web edition without local dictation setup", async () => {
  const { html, source } = await readWebEditionBuild();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /assets\/index-[^"']+\.js/);
  assert.match(source, /ScribeFlow Web/);
  assert.match(source, /Dragon ready/);
  assert.match(source, /ScribeFlow itself does not upload clinical content/);
  assert.match(source, /Never put PHI/);
  assert.match(source, /Intake PDF/);
  assert.match(source, /PAP PDF/);
  assert.match(source, /Paste HST/);
  assert.match(source, /Clinical note editor/);
  assert.match(source, /Shared across computers/);
  assert.match(source, /Checking shared library/);
  assert.doesNotMatch(source, /Publish|GitHub token|publishing key/);
  assert.doesNotMatch(source, /Top bar microphone selection/);
  assert.doesNotMatch(source, /Persistent dictation controls/);
  assert.doesNotMatch(source, /Install Whisper|Update Whisper\?/);
  assert.doesNotMatch(source, /Open system check|Open shared library status/);
  assert.doesNotMatch(source, /Delete after import/);
});

test("follow-up forms keep the sleep questionnaire, Epworth and PLATO scores separate", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
  try {
    const { parseFollowUp } = await server.ssrLoadModule("/github-pages/follow-up.ts");
    const form = [
      "Medication Allergies: Latex", "Social History: Never smoked", "Sleep Questionnaire:",
      "Average hours of sleep per night: 7", "Takes naps: No", "Epworth Sleep Score:",
      "- Sitting and reading: Moderate", "- Watching TV: Slight", "SCORE: 3",
      "Daytime & Nighttime Experiences (PLATO):", "SCORE: 17",
    ].join("\n");
    const questions = { sleepQuestionnaire: "Average hours of sleep per night: 7\nTakes naps: No", ess: "- Sitting and reading: Moderate (2)\n- Watching TV: Slight (1)\nSCORE: 3" };
    assert.deepEqual(parseFollowUp(form, "cpap"), questions);
    assert.deepEqual(parseFollowUp(form, "intake"), { ...questions, allergies: "Latex", socialHistory: "Never smoked" });
    assert.deepEqual(parseFollowUp("Epworth Sleepiness Scale (ESS): 0/24", "cpap"), { ess: "0/24" });
    assert.deepEqual(parseFollowUp("Daytime & Nighttime Experiences (PLATO):\nSCORE: 17", "cpap"), {});
  } finally {
    await server.close();
  }
});
