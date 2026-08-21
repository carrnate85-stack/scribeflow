import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the clinical dictation workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /connect-src 'self'/,
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const html = await response.text();
  assert.match(html, /<title>ScribeFlow — Clinical Dictation<\/title>/i);
  assert.match(html, /Clinical dictation/);
  assert.match(html, /Writing tools/);
  assert.match(html, /Start dictating or choose a template/);
  assert.match(html, /nothing leaves this device/);
  assert.match(html, /aria-label="Bold"/);
  assert.match(html, /aria-label="Underline"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("includes quicktext, template, and local-save workflows", async () => {
  const page = (
    await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const packageJson = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const launcher = await readFile(
    new URL("../scripts/launch-scribeflow.ps1", import.meta.url),
    "utf8",
  );
  const startLauncher = await readFile(
    new URL("../scripts/start-scribeflow.ps1", import.meta.url),
    "utf8",
  );
  const appUpdater = await readFile(
    new URL("../scripts/update-scribeflow.ps1", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const whisperWorker = await readFile(
    new URL("../app/whisper.worker.ts", import.meta.url),
    "utf8",
  );
  const whisperInstaller = await readFile(
    new URL("../scripts/install-local-whisper.ps1", import.meta.url),
    "utf8",
  );
  const nativeWhisperInstaller = await readFile(
    new URL("../scripts/install-native-whisper.ps1", import.meta.url),
    "utf8",
  );
  const whisperReleaseManifest = await readFile(
    new URL("../scripts/whisper-release.json", import.meta.url),
    "utf8",
  );
  const whisperReleaseUtils = await readFile(
    new URL("../scripts/whisper-release-utils.mjs", import.meta.url),
    "utf8",
  );
  const localModelServer = await readFile(
    new URL("../scripts/local-model-server.mjs", import.meta.url),
    "utf8",
  );
  const portableWebServer = await readFile(
    new URL("../scripts/portable-web-server.mjs", import.meta.url),
    "utf8",
  );
  const installerBuilder = await readFile(
    new URL("../scripts/build-portable-installer.ps1", import.meta.url),
    "utf8",
  );
  const installer = await readFile(
    new URL("../installer/Install-ScribeFlow.ps1", import.meta.url),
    "utf8",
  );
  const installerWorkflow = await readFile(
    new URL(
      "../.github/workflows/build-windows-installer.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const worker = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(page, /\.normalexam/);
  assert.match(page, /\.cpap/);
  assert.match(page, /\.hst/);
  assert.match(page, /extractCpapSummary/);
  assert.match(page, /extractHstSummary/);
  assert.match(page, /PAP PDF/);
  assert.match(page, /Paste HST/);
  assert.match(page, /handlePapPdfUpload/);
  assert.match(page, /editingQuicktext/);
  assert.match(page, /openQuicktextForm/);
  assert.match(page, /deleteQuicktext/);
  assert.match(page, /Quicktext deleted/);
  assert.match(page, /Edit quicktext/);
  assert.match(page, /PAP compliance summary ready for \.cpap/);
  assert.match(page, /HST summary ready for \.hst/);
  assert.match(page, /Processed only in memory and never saved/);
  assert.match(page, /patientNamesMatch/);
  assert.match(page, /Patient name mismatch — HST was not imported/);
  assert.match(page, /current intake name is required/);
  assert.match(page, /setHstPasteText\(""\)/);
  assert.match(page, /Original PDF permanently deleted/);
  assert.match(page, /SOAP Note/);
  assert.match(page, /Procedure Note/);
  assert.match(page, /SpeechRecognition/);
  assert.doesNotMatch(page, /Listening online/);
  assert.match(page, /processLocally = true/);
  assert.match(page, /Backquote/);
  assert.match(page, /interimTranscriptRef/);
  assert.match(page, /visibleTranscript/);
  assert.match(page, /Live dictation/);
  assert.match(page, /\(\^\|\\s\)uh\+/);
  assert.match(page, /new paragraph\|new line\|question mark/);
  assert.match(page, /capitalizeStart = true/);
  assert.match(page, /shouldCapitalizeDictationStart/);
  assert.ok(page.includes("/[.!?]\\s*$/"));
  assert.match(page, /toLocaleLowerCase/);
  assert.match(page, /capitalizeTranscriptStart/);
  assert.match(page, /\(\[,.;:\?!\]\)/);
  assert.match(page, /navigator\.permissions/);
  assert.doesNotMatch(page, /getUserMedia\(\{ audio: true \}\)/);
  assert.match(page, /scribe-speech-pack-ready-v1/);
  assert.match(page, /scribe-vocabulary-v1/);
  assert.match(page, /scribe-writing-tools-updated-v1/);
  assert.match(page, /WritingToolsVaultPayload/);
  assert.match(page, /mergeWritingToolsForMigration/);
  assert.match(page, /\/config\/writing-tools/);
  assert.match(page, /Syncing to Documents/);
  assert.match(page, /Updated from OneDrive/);
  assert.match(page, /refreshSharedLibrary/);
  assert.match(page, /OneDrive\\Documents\\ScribeFlow/);
  assert.match(page, /applyVocabularyCorrections/);
  assert.match(page, /SpeechRecognitionPhrase/);
  assert.match(page, /DictationEngine = "whisper" \| "chrome"/);
  assert.match(page, /getUserMedia/);
  assert.match(page, /resampleAudio/);
  assert.match(page, /encodePcm16Wav/);
  assert.match(page, /new Blob\(\[wavBuffer\], \{ type: "audio\/wav" \}\)/);
  assert.match(page, /http:\/\/127\.0\.0\.1:3002\/inference/);
  assert.match(page, /formData\.append\("beam_size", "5"\)/);
  assert.match(page, /Preferred specialty vocabulary/);
  assert.match(page, /wavBytes\.fill\(0\)/);
  assert.match(page, /cleanWhisperTranscript/);
  assert.match(page, /collapseRepeatedWhisperPhrases/);
  assert.match(page, /repeatCount >= 3/);
  assert.match(page, /thank you\(\?:\\s\+for/);
  assert.match(
    page,
    /Never add sign-offs or transcription credits such as thank you/,
  );
  assert.match(page, /subtitles\?\|captions\?/);
  assert.match(page, /amara\(\?:\\\.org\|\\s\+org\)/);
  assert.match(page, /gettranscribed\(\?:\\\.com\|\\s\+com\)/);
  assert.match(page, /captions by GetTranscribed\.com/);
  assert.match(page, /castingwords\(\?:\\\.com\|\\s\+com\)/);
  assert.match(page, /transcription by CastingWords/);
  assert.match(page, /eso\\s\+translation/);
  assert.match(page, /transcription by ESO Translation/);
  assert.match(
    page,
    /transcription\\s\+by\\s\+eso\\s\+translation\(\?:\\s\+by\)\?/,
  );
  assert.match(page, /\(\?:\\s\+by\\s\*\[—–-\]\?\)\?/);
  assert.match(page, /transcription by ESO Translation by —/);
  assert.match(page, /transcription credits/);
  assert.match(page, /previewWhisperAudio/);
  assert.match(page, /whisperLastPreviewSampleCountRef/);
  assert.match(page, /whisperSampleRateRef\.current \* 2\.5/);
  assert.match(page, /Updating live preview/);
  assert.match(page, /Use preferred vocabulary only when it is actually spoken/);
  assert.match(
    page,
    /silence\|blank audio\|no speech\|noise\|music\|inaudible\|clapping\|applause\|clicking\|clicing\|typing\|sighing\|scoffs\?\|whooshing\|whoosing\|coughs\?\|sh\+h\+/,
  );
  assert.match(page, /replace\(\/\\bsh\+h\+\\b\[\.\!\?,\]\*\/gi, " "\)/);
  assert.match(page, /replace\(\/\[\.!\?;:\]\+\/g, " "\)/);
  assert.match(page, /replace\(\/\(\?:\\s\*,\\s\*\)\{2,\}\/g, ", "\)/);
  assert.match(page, /replace\(\/\\s\*,\\s\*\/g, ", "\)/);
  assert.match(page, /replace\(\/,\\s\*\$\/g, ""\)/);
  assert.match(page, /Do not add automatic commas/);
  assert.match(page, /normalizeDictationPunctuation/);
  const spokenPunctuationFunctionBody = page.match(
    /function applySpokenPunctuation\(text: string, capitalizeStart = true\) \{([\s\S]*?)\n\}\n\nfunction normalizeDictationPunctuation/,
  )?.[1];
  assert.ok(spokenPunctuationFunctionBody);
  assert.match(
    spokenPunctuationFunctionBody,
    /transcription\\s\+by\\s\+eso\\s\+translation/,
  );
  const punctuationFunctionBody = page.match(
    /function normalizeDictationPunctuation\(text: string\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(punctuationFunctionBody);
  const normalizePunctuation = new Function("text", punctuationFunctionBody);
  assert.equal(
    normalizePunctuation(
      "who presents for a new patient consultation,, he was referred by PCP, symptom of snoring,, frequent awakening,, witness to apnea. He wakes up very tired,, feels tired during the daytime. Has never had a prior sleep study,. He has woken up gasping for air,, he wakes up with his heart racing and palpitations,.",
    ),
    "who presents for a new patient consultation, he was referred by PCP, symptom of snoring, frequent awakening, witness to apnea. He wakes up very tired, feels tired during the daytime. Has never had a prior sleep study. He has woken up gasping for air, he wakes up with his heart racing and palpitations.",
  );
  assert.match(page, /flushWhisperAudio/);
  assert.match(page, /Whisper Large-v3 unquantized · native CUDA · no API/);
  assert.match(page, /Whisper is recommended/);
  assert.match(page, /Install Whisper/);
  assert.match(page, /Repair or update Whisper/);
  assert.match(page, /Whisper update available/);
  assert.match(page, /Update Whisper\?/);
  assert.match(page, /No, not now/);
  assert.match(page, /Yes, update Whisper/);
  assert.match(page, /whisperUpdatePromptDismissed/);
  assert.match(page, /\/whisper\/install-status/);
  assert.match(page, /\/whisper\/install/);
  assert.match(page, /Audio is processed in memory on this computer/);
  assert.match(page, /Whisper local/);
  assert.match(page, /Chrome offline/);
  assert.match(page, /scribe-dictation-engine-v1/);
  assert.match(page, /scribe-microphone-id-v1/);
  assert.match(page, /enumerateDevices/);
  assert.match(page, /devicechange/);
  assert.match(page, /selectedMicrophoneId/);
  assert.match(page, /deviceId:[\s\S]*?exact: selectedMicrophoneId/);
  assert.match(page, /aria-label="Microphone input"/);
  assert.match(page, /System default/);
  assert.match(page, /Chrome offline dictation uses the browser or Windows default microphone/);
  assert.match(page, /saveVocabularyItem/);
  assert.match(page, /lastRecognizedPhrase/);
  assert.match(page, /setLastRecognizedPhrase/);
  assert.match(page, /openVoiceLearning/);
  assert.match(page, /Teach last phrase/);
  assert.match(page, /Teach voice correction/);
  assert.match(page, /learningHeard/);
  assert.match(page, /Audio and full notes are never stored/);
  assert.match(page, /It starts working with your next dictation/);
  assert.match(page, /window\.localStorage/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /contentEditable/);
  assert.match(page, /applyFormatting/);
  assert.match(page, /scribe-templates-v1/);
  assert.match(page, /scribe-templates-backup-v1/);
  assert.match(page, /scribe-templates-updated-v1/);
  assert.match(page, /parseStoredTemplates/);
  assert.match(page, /parseTemplateVaultPayload/);
  assert.match(page, /http:\/\/127\.0\.0\.1:3001\/config\/templates/);
  assert.match(page, /Synced in OneDrive/);
  assert.match(page, /Restoring your templates/);
  assert.match(page, /saveTemplate/);
  assert.match(
    page,
    /useState<\s*"quicktext" \| "templates" \| "vocabulary"\s*>\("templates"\)/,
  );
  assert.match(
    page,
    /setActivePanel\("templates"\)\}[\s\S]*?>\s*Templates\s*<\/button>[\s\S]*?setActivePanel\("quicktext"\)\}[\s\S]*?>\s*Quicktext\s*<\/button>/,
  );
  assert.match(page, /contentHtml/);
  assert.match(page, /applyTemplateFormatting/);
  assert.match(page, /Template text formatting/);
  assert.match(page, /editor\.innerHTML\s*=/);
  const templateEditorMarkup = page.match(
    /ref=\{templateEditorRef\}[\s\S]*?\/>/,
  );
  assert.ok(templateEditorMarkup, "template rich-text editor should be rendered");
  assert.doesNotMatch(templateEditorMarkup[0], /dangerouslySetInnerHTML/);
  assert.match(page, /\[search, templates\]/);
  assert.match(page, /duplicateTemplate/);
  assert.match(page, /deleteTemplate/);
  assert.match(page, /text\/html/);
  assert.match(page, /saveNote/);
  assert.match(page, /\/documents\/save-note/);
  assert.match(page, /Save note to Documents/);
  assert.match(page, /handlePdfUpload/);
  assert.match(page, /showOpenFilePicker/);
  assert.match(page, /deletePdfAfterScan, setDeletePdfAfterScan\] = useState\(true\)/);
  assert.match(page, /requestPermission/);
  assert.match(page, /mode: "readwrite"/);
  assert.match(page, /scanSucceeded && deleteOriginalAfterScan/);
  assert.match(page, /await removeOriginal\(\)/);
  assert.match(page, /crypto\.subtle\.digest\("SHA-256", pdfBytes\)/);
  assert.match(page, /\/files\/delete-uploaded-pdf/);
  assert.match(page, /sha256: pdfSha256/);
  assert.match(page, /bytesToClear\?\.fill\(0\)/);
  assert.match(page, /PDF\.js may transfer and detach this buffer/);
  assert.match(page, /Promise\.resolve\(\)\.then\(\(\) => documentToClean\?\.cleanup\(\)\)/);
  assert.match(page, /Original PDF permanently deleted/);
  assert.match(page, /Delete after import/);
  assert.match(page, /extractPdfMeasurements/);
  assert.match(page, /resolveMeasurementTokens/);
  assert.match(page, /insertTemplateField/);
  assert.match(page, /\.name/);
  assert.match(page, /\.age/);
  assert.match(page, /\.gender/);
  assert.match(page, /\.height/);
  assert.match(page, /\.weight/);
  assert.match(page, /formatImportedWeight/);
  assert.match(page, /0\.45359237/);
  assert.match(page, /lbs \(\$\{roundToOneDecimal\(kilograms\)\} kg\)/);
  assert.match(page, /\.bmi/);
  assert.match(page, /\.meds/);
  assert.match(page, /\.allergies/);
  assert.match(page, /\.pastmedicalhistory/);
  assert.match(page, /pastMedicalHistory/);
  assert.match(page, /\.sleepquestionnaire/);
  assert.match(page, /\.ess/);
  assert.match(page, /\.familyhistory/);
  assert.match(page, /\.socialhistory/);
  assert.match(page, /Epworth Sleep Score/);
  assert.match(page, /Active Medications/);
  assert.match(page, /Medication Allergies/);
  assert.match(page, /Past Medical History/);
  assert.match(page, /Past Surgical History\|Surgical History\|Sleep Questionnaire/);
  assert.match(page, /cleanMedicationListEnding/);
  assert.match(page, /replace\(\/\(\?:\\s\*\[-:\]\)\+\\s\*\$\/, ""\)/);
  assert.match(page, /Weight Health/);
  assert.match(
    page,
    /How likely is the patient to doze off in the situations below:/,
  );
  assert.match(page, /replace\(\/\[ \\t\]\+\(\?=-\\s\+\)\/g, "\\n"\)/);
  assert.match(page, /replace\(\/\[ \\t\]\+\(\?=SCORE:/);
  assert.match(page, /none: 0/);
  assert.match(page, /slight: 1/);
  assert.match(page, /moderate: 2/);
  assert.match(page, /high: 3/);
  assert.match(page, /None\|Slight\|Moderate\|High/);
  assert.match(page, /Patient reports the following social history/);
  assert.match(page, /calculateAgeFromDateOfBirth/);
  assert.match(page, /Date of Birth/);
  assert.match(page, /Gender/);
  assert.match(page, /gender\?\.toLowerCase\(\)/);
  assert.match(page, /Not saved · save to OneDrive/);
  assert.match(page, /Saved in OneDrive/);
  assert.match(page, /legacyPatientDataStorageKeys/);
  assert.doesNotMatch(page, /localStorage\.setItem\(storageKeys\.note/);
  assert.doesNotMatch(page, /localStorage\.setItem\(storageKeys\.noteHtml/);
  assert.doesNotMatch(page, /localStorage\.setItem\(storageKeys\.title/);
  assert.doesNotMatch(page, /pdfBytes\?\.fill\(0\)/);
  assert.match(page, /Promise\.allSettled/);
  assert.doesNotMatch(page, /await pdfDocument\?\.cleanup/);
  assert.match(page, /MEASUREMENTS FROM PDF/);
  assert.match(packageJson, /pdfjs-dist/);
  assert.match(packageJson, /@huggingface\/transformers/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(whisperWorker, /env\.allowRemoteModels = false/);
  assert.match(
    whisperWorker,
    /env\.localModelPath = "http:\/\/127\.0\.0\.1:3001\/models\/"/,
  );
  assert.match(whisperWorker, /env\.useBrowserCache = false/);
  assert.match(whisperWorker, /env\.backends\.onnx\.wasm\.wasmPaths = "\/wasm\/"/);
  assert.match(whisperWorker, /device: "webgpu"/);
  assert.match(whisperWorker, /encoder_model: "q4f16"/);
  assert.match(whisperWorker, /decoder_model_merged: "q4f16"/);
  assert.match(whisperWorker, /language: "english"/);
  assert.match(whisperWorker, /task: "transcribe"/);
  assert.match(whisperWorker, /num_beams: 5/);
  assert.match(whisperWorker, /audio\.fill\(0\)/);
  assert.match(whisperInstaller, /onnx-community\/whisper-large-v3-ONNX/);
  assert.match(whisperInstaller, /encoder_model_q4f16\.onnx/);
  assert.match(whisperInstaller, /decoder_model_merged_q4f16\.onnx/);
  assert.match(whisperInstaller, /No audio was uploaded/);
  assert.match(nativeWhisperInstaller, /whisper-release\.json/);
  assert.match(nativeWhisperInstaller, /Stop-InstalledWhisper/);
  assert.match(nativeWhisperInstaller, /whisperReleaseVersion/);
  assert.match(nativeWhisperInstaller, /unquantized = \$true/);
  assert.match(nativeWhisperInstaller, /remoteModelsAllowed = \$false/);
  assert.match(nativeWhisperInstaller, /No audio was uploaded/);
  assert.match(
    whisperReleaseManifest,
    /AD82BF6A9043CEED055076D0FD39F5F186FF8062/,
  );
  assert.match(
    whisperReleaseManifest,
    /whisper-cublas-12\.4\.0-bin-x64\.zip/,
  );
  assert.match(whisperReleaseManifest, /whisper-large-v3-r1/);
  assert.match(whisperReleaseUtils, /isInstalledWhisperReleaseCurrent/);
  assert.match(whisperReleaseUtils, /validateWhisperRelease/);
  assert.match(localModelServer, /server\.listen\(port, host/);
  assert.match(localModelServer, /const host = "127\.0\.0\.1"/);
  assert.match(localModelServer, /process\.env\.SCRIBEFLOW_MODEL_PORT/);
  assert.match(localModelServer, /const modelRoot = resolve\(dataRoot, "models"\)/);
  assert.match(localModelServer, /allowedOrigins/);
  assert.match(localModelServer, /process\.env\.LOCALAPPDATA/);
  assert.match(localModelServer, /process\.env\.SCRIBEFLOW_DOCUMENTS_ROOT/);
  assert.match(
    localModelServer,
    /const notesRoot = resolve\(documentsRoot, "Notes"\)/,
  );
  assert.match(
    localModelServer,
    /const templatesRoot = resolve\(documentsRoot, "Templates"\)/,
  );
  assert.match(
    localModelServer,
    /const templateBackupsRoot = resolve\(templatesRoot, "Backups"\)/,
  );
  assert.match(localModelServer, /migrateLegacyTemplates\(\)/);
  assert.match(
    localModelServer,
    /url\.pathname === "\/documents\/save-note"/,
  );
  assert.match(localModelServer, /url\.pathname === "\/config\/templates"/);
  assert.match(
    localModelServer,
    /url\.pathname === "\/config\/writing-tools"/,
  );
  assert.match(
    localModelServer,
    /const writingToolsRoot = resolve\(documentsRoot, "Writing Tools"\)/,
  );
  assert.match(localModelServer, /writing-tools\.json/);
  assert.match(localModelServer, /writeDurableWritingTools/);
  assert.match(localModelServer, /writing-tools-\$\{Date\.now\(\)\}\.json/);
  assert.match(localModelServer, /if \(backups\.length === 0\)/);
  assert.match(localModelServer, /backups\.slice\(20\)/);
  assert.match(localModelServer, /deleteVerifiedPdf\(downloadsRoot, payload\)/);
  assert.match(localModelServer, /\/files\/delete-uploaded-pdf/);
  assert.match(localModelServer, /url\.pathname === "\/whisper\/install"/);
  assert.match(
    localModelServer,
    /url\.pathname === "\/whisper\/install-status"/,
  );
  assert.match(localModelServer, /spawn\(\s*"powershell\.exe"/);
  assert.match(localModelServer, /startNativeWhisperService/);
  assert.match(localModelServer, /nativeWhisperPidFile/);
  assert.match(localModelServer, /status: "update_available"/);
  assert.match(localModelServer, /isInstalledWhisperReleaseCurrent/);
  assert.match(localModelServer, /migrateLegacyWhisperManifest/);
  assert.match(localModelServer, /migratedLegacyInstall: true/);
  assert.match(localModelServer, /replace\(\/\^\\uFEFF\//);
  assert.match(localModelServer, /origin \|\| !allowedOrigins\.has\(origin\)/);
  assert.doesNotMatch(localModelServer, /\/config\/(?:notes|audio|pdf)/);
  assert.match(localModelServer, /!url\.pathname\.startsWith\("\/models\/"\)/);
  assert.match(
    worker,
    /"connect-src 'self' http:\/\/127\.0\.0\.1:3001 http:\/\/127\.0\.0\.1:3002"/,
  );
  assert.match(worker, /"object-src 'none'"/);
  assert.match(launcher, /\$selectedPort = 3000/);
  assert.match(launcher, /\$modelPort = 3001/);
  assert.match(launcher, /\$nativeWhisperPort = 3002/);
  assert.match(launcher, /\$env:LOCALAPPDATA/);
  assert.match(launcher, /Get-ScribeFlowDocumentsRoot/);
  assert.match(
    launcher,
    /\$env:SCRIBEFLOW_DOCUMENTS_ROOT = \$documentsRoot/,
  );
  assert.match(launcher, /whisper-release\.json/);
  assert.match(launcher, /\$nativeWhisperModelFileName/);
  assert.match(launcher, /\$nativeWhisperRuntimeVersion/);
  assert.match(launcher, /whisper-server\.exe/);
  assert.match(launcher, /"--beam-size", "5"/);
  assert.match(launcher, /"--host", "127\.0\.0\.1"/);
  assert.match(launcher, /local-model-server\.mjs/);
  assert.match(launcher, /portable-web-server\.mjs/);
  assert.match(launcher, /portableNodeDirectory/);
  assert.match(launcher, /Join-Path \$portableNodeDirectory "node\.exe"/);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:\$Port\/health/);
  assert.match(
    launcher,
    /http:\/\/127\.0\.0\.1:\$Port\/\?launch=\$launchToken/,
  );
  assert.match(launcher, /ToUnixTimeMilliseconds/);
  assert.doesNotMatch(launcher, /http:\/\/localhost:\$Port/);
  assert.match(launcher, /WindowStyle Hidden/);
  assert.match(launcher, /ScribeFlow will offer to install it inside the app/);
  assert.doesNotMatch(launcher, /3000\.\.3010/);
  assert.doesNotMatch(launcher, /Find-Pnpm|wrangler/);
  assert.match(portableWebServer, /createServer/);
  assert.match(portableWebServer, /127\.0\.0\.1/);
  assert.match(portableWebServer, /dist", "client"/);
  assert.match(installerBuilder, /includesPatientData = \$false/);
  assert.match(installerBuilder, /ggml-large-v3\.bin/);
  assert.match(installerBuilder, /app-version\.json/);
  assert.match(installerBuilder, /whisper-release\.json/);
  assert.match(installerBuilder, /whisper-release-utils\.mjs/);
  assert.match(installerBuilder, /document-storage-utils\.mjs/);
  assert.match(installerBuilder, /assets\\ScribeFlow\.ico/);
  assert.match(installerBuilder, /ScribeFlow-Windows-Online-Installer\.zip\.sha256/);
  assert.match(installer, /\$installRoot = Join-Path \$programsRoot "ScribeFlow"/);
  assert.match(installer, /Templates sync through Documents\\ScribeFlow/);
  assert.match(installer, /Whisper is kept separately/);
  assert.match(installer, /whisper-release\.json/);
  assert.match(installer, /document-storage-utils\.mjs/);
  assert.match(installer, /\$desktopShortcut\.IconLocation = "\$installedIcon,0"/);
  assert.match(installer, /\$startMenuShortcut\.IconLocation = "\$installedIcon,0"/);
  assert.doesNotMatch(installer, /\$SkipModelDownload/);
  assert.match(startLauncher, /update-scribeflow\.ps1/);
  assert.match(startLauncher, /launch-scribeflow\.ps1/);
  assert.match(
    appUpdater,
    /api\.github\.com\/repos\/\$releaseRepository\/releases\/latest/,
  );
  assert.match(appUpdater, /ScribeFlow-Windows-Online-Installer\.zip/);
  assert.match(appUpdater, /Get-FileHash[\s\S]*?-Algorithm SHA256/);
  assert.match(appUpdater, /Install-ScribeFlow\.ps1/);
  assert.match(installerWorkflow, /ScribeFlow-Windows-Online-Installer\.zip\.sha256/);
  assert.doesNotMatch(installerBuilder, /templates\.json|Downloads\\.*\.pdf/);
  assert.match(styles, /\.whisper-setup-banner/);
  assert.match(
    styles,
    /\.interim-transcript\s*\{[\s\S]*?position: fixed;[\s\S]*?bottom: 154px;/,
  );
  assert.match(
    styles,
    /\.dictation-dock\s*\{[\s\S]*?position: fixed;[\s\S]*?bottom: 16px;/,
  );
  assert.match(styles, /\.dictation-dock\.recording/);
  assert.match(page, /aria-label="Persistent dictation controls"/);
});

test("extracts past medical history only through the next section", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const patternSource = page.match(
    /pastMedicalHistory:\s*findSection\(\s*(\/Past Medical History:[^\r\n]+\/i)/,
  )?.[1];
  assert.ok(patternSource, "Past medical history extraction pattern is missing");

  const pattern = Function(`"use strict"; return (${patternSource});`)();
  const intakeText = [
    "Medication Allergies: None",
    "Past Medical History:",
    "The patient has the following past medical history:",
    "Asthma",
    "Hypertension",
    "Past Surgical History:",
    "Appendectomy",
  ].join("\n");
  const extracted = intakeText.match(pattern)?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  assert.equal(extracted, "Asthma\nHypertension");
});

test("summarizes PAP compliance metrics for the .cpap field", async () => {
  const page = (
    await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const functionBody = page.match(
    /function extractCpapSummary\(text: string\) \{([\s\S]*?)\n\}\n\nfunction normalizePatientName/,
  )?.[1];
  assert.ok(functionBody, "PAP compliance extraction function is missing");

  const runnableBody = functionBody
    .replace(/\(patterns: RegExp\[\]\)/g, "(patterns)")
    .replace(/: string\[\]/g, "")
    .replace(/\(value\): value is string/g, "(value)");
  const extractCpapSummary = new Function("text", runnableBody);
  const reportText = [
    "Compliance Report",
    "Usage 07/06/2026 - 08/04/2026",
    "Usage days 28/30 days (93%)",
    ">= 4 hours 23 days (77%)",
    "Average usage (days used) 5 hours 20 minutes",
    "Mode AutoSet",
    "Min Pressure 7 cmH2O",
    "Max Pressure 12 cmH2O",
    "Pressure - cmH2O Median: 10.0 95th percentile: 11.5 Maximum: 11.8",
    "Leaks - L/min Median: 14.5 95th percentile: 23.6 Maximum: 34.4",
    "Events per hour AI: 0.4 HI: 0.1 AHI: 0.5",
  ].join("\n");

  assert.equal(
    extractCpapSummary(reportText),
    [
      "PAP compliance period: 07/06/2026 - 08/04/2026.",
      "Usage: 28/30 days (93%) used; >=4 hours 23 days (77%); average 5 hours 20 minutes on days used.",
      "Settings: AutoSet 7-12 cmH2O.",
      "95th percentile pressure: 11.5 cmH2O.",
      "95th percentile leak: 23.6 L/min.",
      "Residual AHI: 0.5 events/hour.",
    ].join("\n"),
  );
});

test("requires the pasted HST patient name to match the current intake", async () => {
  const page = (
    await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const functionSource = page.match(
    /function normalizePatientName[\s\S]*?\n\}\n\nfunction extractHstSummary/,
  )?.[0].replace(/\n\nfunction extractHstSummary$/, "");
  assert.ok(functionSource, "HST patient-name safety functions are missing");
  const runnableSource = functionSource
    .replace(/\(value: string\)/g, "(value)")
    .replace(/\(text: string\)/g, "(text)")
    .replace(/\(intakeName: string, hstName: string\)/g, "(intakeName, hstName)");
  const safety = new Function(
    `${runnableSource}; return { extractHstPatientName, patientNamesMatch };`,
  )();

  assert.equal(
    safety.extractHstPatientName(
      "Patient Name: Smith, Jordan A.  DOB: 01/02/1980 Study Date: 08/18/2026",
    ),
    "Smith, Jordan A.",
  );
  assert.equal(safety.patientNamesMatch("Jordan Smith", "Smith, Jordan A."), true);
  assert.equal(safety.patientNamesMatch("Jordan Smith", "Taylor Smith"), false);
  assert.equal(safety.patientNamesMatch("Jordan Smith", "Jordan Jones"), false);
});

test("summarizes pasted HST metrics for the .hst field", async () => {
  const page = (
    await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const functionBody = page.match(
    /function extractHstSummary\(text: string\) \{([\s\S]*?)\n\}\n\nfunction extractPdfMeasurements/,
  )?.[1];
  assert.ok(functionBody, "HST extraction function is missing");

  const runnableBody = functionBody
    .replace(/\(patterns: RegExp\[\]\)/g, "(patterns)")
    .replace(/\(labelPattern: string\)/g, "(labelPattern)")
    .replace(/\(percent: string\)/g, "(percent)")
    .replace(/\(value: string\)/g, "(value)")
    .replace(/: string\[\]/g, "")
    .replace(/\(value\): value is string/g, "(value)");
  const extractHstSummary = new Function("text", runnableBody);
  const reportText = [
    "Home Sleep Test",
    "Patient Name: Jordan Smith",
    "Study Date: 08/18/2026",
    "Total Recording Time: 7 hours 14 minutes",
    "AHI 3% (AASM 1A): 18.6 events/hour",
    "AHI-4%: 14.2 events/hour",
    "Supine REI: 27.4 events/hour",
    "ODI: 17.9 events/hour",
    "Mean SpO2: 93%",
    "SpO2 Nadir: 82%",
    "Time at <= 88%: 6.4 minutes",
    "Impression:",
    "1. Moderate obstructive sleep apnea with a positional component.",
    "2. Sleep-related hypoxemia was observed during the recording.",
    "The findings should be correlated with the patient's clinical history.",
    "Recommendations:",
    "1. Consider PAP therapy.",
    "2. Avoid driving while drowsy.",
    "Report Status:",
    "Final",
  ].join("\n");

  assert.equal(
    extractHstSummary(reportText),
    [
      "HST date: 08/18/2026.",
      "Recording time: 7 hours 14 minutes.",
      "Respiratory findings: AHI (3%) 18.6 events/hour; AHI (4%) 14.2 events/hour; supine REI 27.4 events/hour; ODI 17.9 events/hour.",
      "Oximetry: mean SpO2 93%; nadir 82%; <=88% for 6.4 minutes.",
      [
        "Impression: 1. Moderate obstructive sleep apnea with a positional component.",
        "2. Sleep-related hypoxemia was observed during the recording.",
        "The findings should be correlated with the patient's clinical history.",
      ].join("\n"),
      [
        "Recommendations: 1. Consider PAP therapy.",
        "2. Avoid driving while drowsy.",
      ].join("\n"),
    ].join("\n"),
  );
  assert.equal(
    extractHstSummary("Overall REI: 9.2 events/hour"),
    "Respiratory findings: REI 9.2 events/hour.",
    "falls back to the overall AHI or REI when scored thresholds are absent",
  );
});
