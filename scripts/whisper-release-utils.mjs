function normalizedHash(value) {
  return typeof value === "string" ? value.toUpperCase() : "";
}

export function isInstalledWhisperReleaseCurrent(installed, expected) {
  if (!installed || !expected) return false;
  if (
    installed.whisperReleaseVersion &&
    installed.whisperReleaseVersion === expected.releaseVersion
  ) {
    return true;
  }

  return (
    installed.runtimeVersion === expected.runtime?.version &&
    normalizedHash(installed.runtimeSha256) ===
      normalizedHash(expected.runtime?.sha256) &&
    installed.model === expected.model?.id &&
    normalizedHash(installed.modelSha1) ===
      normalizedHash(expected.model?.sha1)
  );
}

export function validateWhisperRelease(release) {
  if (
    release?.schemaVersion !== 1 ||
    typeof release.releaseVersion !== "string" ||
    !release.releaseVersion ||
    typeof release.displayName !== "string" ||
    typeof release.downloadSizeLabel !== "string" ||
    typeof release.runtime?.source !== "string" ||
    typeof release.runtime?.version !== "string" ||
    typeof release.runtime?.archiveName !== "string" ||
    typeof release.runtime?.url !== "string" ||
    !/^https:\/\/github\.com\//.test(release.runtime.url) ||
    !/^[A-Fa-f0-9]{64}$/.test(release.runtime.sha256) ||
    typeof release.model?.id !== "string" ||
    typeof release.model?.source !== "string" ||
    typeof release.model?.fileName !== "string" ||
    typeof release.model?.url !== "string" ||
    !/^https:\/\/huggingface\.co\//.test(release.model.url) ||
    !/^[A-Fa-f0-9]{40}$/.test(release.model.sha1)
  ) {
    throw new Error("The bundled Whisper release manifest is invalid.");
  }
  return release;
}
