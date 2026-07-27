import assert from "node:assert/strict";
import test from "node:test";
import {
  isInstalledWhisperReleaseCurrent,
  validateWhisperRelease,
} from "../scripts/whisper-release-utils.mjs";

const expected = validateWhisperRelease({
  schemaVersion: 1,
  releaseVersion: "whisper-large-v3-r1",
  displayName: "Whisper Large-v3",
  downloadSizeLabel: "about 3.1 GB",
  runtime: {
    source: "ggml-org/whisper.cpp",
    version: "v1.9.1",
    archiveName: "whisper.zip",
    url: "https://github.com/ggml-org/whisper.cpp/example.zip",
    sha256: "A".repeat(64),
  },
  model: {
    id: "ggml-large-v3",
    source: "ggerganov/whisper.cpp",
    fileName: "ggml-large-v3.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/model.bin",
    sha1: "B".repeat(40),
  },
});

test("recognizes both current and legacy Whisper manifests", () => {
  assert.equal(
    isInstalledWhisperReleaseCurrent(
      { whisperReleaseVersion: "whisper-large-v3-r1" },
      expected,
    ),
    true,
  );
  assert.equal(
    isInstalledWhisperReleaseCurrent(
      {
        runtimeVersion: "v1.9.1",
        runtimeSha256: "a".repeat(64),
        model: "ggml-large-v3",
        modelSha1: "b".repeat(40),
      },
      expected,
    ),
    true,
  );
});

test("detects a future Whisper runtime or model release", () => {
  assert.equal(
    isInstalledWhisperReleaseCurrent(
      {
        runtimeVersion: "v1.9.0",
        runtimeSha256: "C".repeat(64),
        model: "ggml-large-v2",
        modelSha1: "D".repeat(40),
      },
      expected,
    ),
    false,
  );
  assert.equal(isInstalledWhisperReleaseCurrent(null, expected), false);
});
