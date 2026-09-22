"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import packageInfo from "../package.json";
import {
  applyWebLibraryOperations,
  createEmptyWebLibraryDeviceRecord,
  createWebLibraryOperation,
  diffWebLibraryPayload,
  materializeWebLibraryDeviceRecords,
  mergeWebSharedLibrary,
  mergeWebLibraryDeviceRecords,
  parseWebLibraryDeviceRecord,
  payloadContainsWebLibraryMutations,
  pruneCoveredWebLibraryOperations,
  sanitizeTemplateHtml,
  stableWebLibraryJson,
  utf8ByteLength,
  webLibraryContextFromOperations,
  WEB_LIBRARY_COLLECTIONS,
  WEB_LIBRARY_DEVICE_MAX_BYTES,
  WEB_LIBRARY_MAX_BYTES,
} from "./web-library-utils.mjs";

type Template = {
  id: string;
  name: string;
  type: string;
  description: string;
  content: string;
  contentHtml?: string;
};

type TemplateVaultPayload = {
  version: 1;
  updatedAt: number;
  lastWriter?: string;
  templates: Template[];
};

type Quicktext = {
  id: string;
  shortcut: string;
  title: string;
  content: string;
  category: string;
};

type VocabularyItem = {
  id: string;
  heard: string;
  replacement: string;
};

type WritingToolsVaultPayload = {
  version: 1;
  updatedAt: number;
  lastWriter?: string;
  quicktexts: Quicktext[];
  vocabulary: VocabularyItem[];
};

type WebSharedLibraryPayload = {
  version: 1;
  updatedAt: number;
  templates: Template[];
  quicktexts: Quicktext[];
  vocabulary: VocabularyItem[];
};

type WebLibraryCollection = "templates" | "quicktexts" | "vocabulary";

type WebLibraryOperation = {
  collection: WebLibraryCollection;
  itemId: string;
  dot: { actorId: string; counter: number };
  context: Record<string, number>;
  tombstone: boolean;
  value?: Template | Quicktext | VocabularyItem;
};

type WebLibraryDeviceRecord = {
  schema: 2;
  deviceId: string;
  updatedAt: number;
  canonicalFingerprints: string[];
  items: Record<
    WebLibraryCollection,
    Array<Omit<WebLibraryOperation, "collection">>
  >;
};

type WebLibraryConflict = {
  collection: WebLibraryCollection;
  itemId: string;
  heads: WebLibraryOperation[];
  primary: Template | Quicktext | VocabularyItem;
  copies: Array<{
    conflictId: string;
    value: Template | Quicktext | VocabularyItem;
    operations: WebLibraryOperation[];
  }>;
  hasTombstone: boolean;
};

type WebLibraryPendingOperation = WebLibraryOperation & {
  mutationId: string;
  createdAt: number;
};

type WebLibrarySnapshot = {
  savedAt: number;
  reason: string;
  payload: WebSharedLibraryPayload;
};

type VaultWriteResponse<T> = {
  payload: T;
  conflictCount: number;
  conflictFile: string | null;
  message: string;
};

type SharedVaultStatus = {
  exists: boolean;
  updatedAt: number | null;
  modifiedAt: number | null;
  lastWriter: string | null;
  conflicts: number;
};

type SharedStorageStatus = {
  checkedAt: number;
  deviceName: string;
  documentsRoot: string;
  oneDrive: boolean;
  templates: SharedVaultStatus;
  writingTools: SharedVaultStatus;
  update: {
    stage?: string;
    version?: string;
    message?: string;
    updatedAt?: string;
  } | null;
};

type DictationEngine = "whisper" | "chrome";

type WhisperInstallStatus = {
  status:
    | "checking"
    | "missing"
    | "installing"
    | "starting"
    | "update_available"
    | "installed"
    | "failed";
  installed: boolean;
  message: string;
  expectedReleaseVersion?: string;
  installedReleaseVersion?: string | null;
};

type MicrophoneOption = {
  deviceId: string;
  label: string;
};

type DockPosition = {
  x: number;
  y: number;
};

type MicrophoneTestState =
  | "idle"
  | "testing"
  | "heard"
  | "quiet"
  | "failed";

type PdfMeasurements = {
  cpap?: string;
  hst?: string;
  name?: string;
  age?: string;
  gender?: string;
  height?: string;
  weight?: string;
  bmi?: string;
  meds?: string;
  allergies?: string;
  pastMedicalHistory?: string;
  sleepQuestionnaire?: string;
  ess?: string;
  familyHistory?: string;
  socialHistory?: string;
};

const pdfFieldTokens = [
  ".cpap",
  ".hst",
  ".name",
  ".age",
  ".gender",
  ".height",
  ".weight",
  ".bmi",
  ".meds",
  ".allergies",
  ".pastmedicalhistory",
  ".sleepquestionnaire",
  ".ess",
  ".familyhistory",
  ".socialhistory",
] as const;

type PdfFieldToken = (typeof pdfFieldTokens)[number];

type LocalPdfFileHandle = {
  getFile: () => Promise<File>;
  remove?: () => Promise<void>;
  requestPermission?: (options: {
    mode: "readwrite";
  }) => Promise<PermissionState>;
};

type PdfPickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options: {
      multiple: boolean;
      types: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<LocalPdfFileHandle[]>;
  };

type SpeechRecognitionPhraseLike = {
  phrase: string;
  boost: number;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: {
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
    length: number;
  };
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

type SpeechRecognitionOptions = {
  langs: string[];
  processLocally: boolean;
  quality?: "command" | "search" | "dictation" | "conversation";
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  phrases?: SpeechRecognitionPhraseLike[];
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
};

type RecognitionConstructor = {
  new (): Recognition;
  available?: (
    options: SpeechRecognitionOptions,
  ) => Promise<SpeechRecognitionAvailability>;
  install?: (options: SpeechRecognitionOptions) => Promise<boolean>;
};

type SpeechRecognitionPhraseConstructor = {
  new (phrase: string, boost: number): SpeechRecognitionPhraseLike;
};

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
    SpeechRecognitionPhrase?: SpeechRecognitionPhraseConstructor;
  }
}

const starterTemplates: Template[] = [
  {
    id: "soap",
    name: "SOAP Note",
    type: "Primary care",
    description: "Structured note for a problem-focused visit",
    content: `SUBJECTIVE
Chief complaint: [Chief complaint]

History of present illness:
[HPI]

Review of systems:
[Pertinent review of systems]

OBJECTIVE
Vital signs: [Vitals]

Physical examination:
[Exam findings]

ASSESSMENT
1. [Primary diagnosis]

PLAN
1. [Treatment and follow-up plan]
`,
  },
  {
    id: "followup",
    name: "Follow-up",
    type: "Established patient",
    description: "Interval history, response, and next steps",
    content: `FOLLOW-UP NOTE

Reason for visit:
[Reason for follow-up]

Interval history:
[Changes since last visit]

Medication response / adherence:
[Response and adherence]

Focused examination:
[Pertinent findings]

Assessment:
[Current clinical assessment]

Plan:
[Medication, testing, counseling, and follow-up]
`,
  },
  {
    id: "consult",
    name: "Consultation",
    type: "Specialty",
    description: "Comprehensive consult with recommendations",
    content: `CONSULTATION NOTE

Reason for consultation:
[Consult question]

History:
[Relevant history]

Prior evaluation:
[Imaging, labs, and treatments]

Examination:
[Pertinent examination]

Impression:
[Clinical impression]

Recommendations:
1. [Recommendation]
2. [Follow-up]
`,
  },
  {
    id: "procedure",
    name: "Procedure Note",
    type: "Procedure",
    description: "Consent, technique, findings, and disposition",
    content: `PROCEDURE NOTE

Procedure: [Procedure name]
Indication: [Indication]

Consent:
The risks, benefits, and alternatives were discussed. Informed consent was obtained.

Technique:
[Technique and equipment]

Findings:
[Findings]

Complications: None immediate.
Estimated blood loss: [Amount]

Disposition:
[Post-procedure condition and instructions]
`,
  },
];

const starterQuicktexts: Quicktext[] = [
  {
    id: "normal-exam",
    shortcut: ".normalexam",
    title: "Normal exam",
    category: "Exam",
    content:
      "General: Alert, well appearing, and in no acute distress.\nCardiovascular: Regular rate and rhythm. No murmurs, rubs, or gallops.\nRespiratory: Clear to auscultation bilaterally. Normal work of breathing.\nAbdomen: Soft, non-tender, and non-distended.\nNeurologic: Alert and oriented. No focal deficits.",
  },
  {
    id: "ros-negative",
    shortcut: ".rosneg",
    title: "Negative review of systems",
    category: "ROS",
    content:
      "Review of systems is negative except as documented in the history of present illness.",
  },
  {
    id: "counsel",
    shortcut: ".counsel",
    title: "Counseling",
    category: "Plan",
    content:
      "The diagnosis, expected course, treatment options, and return precautions were reviewed with the patient. Questions were answered, and the patient expressed understanding of the plan.",
  },
  {
    id: "return",
    shortcut: ".return",
    title: "Return precautions",
    category: "Plan",
    content:
      "The patient was advised to seek urgent care for new or worsening symptoms and to return as scheduled, or sooner if concerns arise.",
  },
  {
    id: "medreview",
    shortcut: ".medreview",
    title: "Medication review",
    category: "Medication",
    content:
      "Medication reconciliation was completed. Indications, dosing, adherence, and potential adverse effects were reviewed.",
  },
];

const storageKeys = {
  quicktexts: "scribe-quicktexts-v1",
  templates: "scribe-templates-v1",
  templatesBackup: "scribe-templates-backup-v1",
  templatesUpdatedAt: "scribe-templates-updated-v1",
  vocabulary: "scribe-vocabulary-v1",
  writingToolsUpdatedAt: "scribe-writing-tools-updated-v1",
  speechPackReady: "scribe-speech-pack-ready-v1",
  dictationEngine: "scribe-dictation-engine-v1",
  microphoneId: "scribe-microphone-id-v1",
  dictationDockCollapsed: "scribe-dictation-dock-collapsed-v1",
  dictationDockPosition: "scribe-dictation-dock-position-v1",
  webLibraryOwnerKey: "scribe-web-library-owner-key-v1",
  webLibraryDirty: "scribe-web-library-dirty-v1",
  webLibraryBase: "scribe-web-library-base-v1",
  webLibrarySnapshots: "scribe-web-library-snapshots-v1",
  webLibraryDeviceId: "scribe-web-library-device-id-v2",
  webLibraryDeviceRecord: "scribe-web-library-device-record-v2",
};

const webLibraryOutboxPrefix = "scribe-web-library-outbox-v2:";

const legacyPatientDataStorageKeys = [
  "scribe-note-v1",
  "scribe-note-html-v1",
  "scribe-title-v1",
];

const webEdition =
  (
    import.meta.env as ImportMetaEnv & {
      readonly VITE_SCRIBEFLOW_WEB?: string;
    }
  ).VITE_SCRIBEFLOW_WEB === "1";
const webSharedLibraryNamespace = "scribeflow-carrnate85-a4d72f39";
const webSharedLibraryRemoteUrl =
  `https://mantledb.sh/v2/${webSharedLibraryNamespace}/library`;
const webSharedLibraryDevicePathPrefix = "library-device-v2-";

function webSharedLibraryUrl() {
  return webSharedLibraryRemoteUrl;
}

function webSharedLibraryFallbackUrl() {
  return `${import.meta.env.BASE_URL}shared-library.json`;
}

function webSharedLibraryListUrl() {
  return `https://mantledb.sh/v2/list/${webSharedLibraryNamespace}`;
}

function webSharedLibraryDevicePath(deviceId: string) {
  return `${webSharedLibraryDevicePathPrefix}${deviceId}`;
}

function webSharedLibraryDeviceUrl(deviceId: string) {
  return `https://mantledb.sh/v2/${webSharedLibraryNamespace}/${webSharedLibraryDevicePath(
    deviceId,
  )}`;
}

function webSharedLibraryDeviceVisibilityUrl(deviceId: string) {
  return `https://mantledb.sh/v2/visibility/${webSharedLibraryNamespace}/${webSharedLibraryDevicePath(
    deviceId,
  )}`;
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function currentTimestamp() {
  return Date.now();
}

async function fingerprintWebLibrary(payload: WebSharedLibraryPayload) {
  const bytes = new TextEncoder().encode(stableWebLibraryJson(payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function webLibraryConflictSeed(fingerprint: string) {
  return Number.parseInt(fingerprint.slice(0, 10), 16);
}

function collectCanonicalFingerprints(
  records: WebLibraryDeviceRecord[],
  additions: string[] = [],
) {
  return Array.from(
    new Set([
      ...records.flatMap((record) => record.canonicalFingerprints),
      ...additions,
    ]),
  ).slice(-16);
}

function detectWindowFraming() {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function parseDockPosition(value: string | null): DockPosition | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DockPosition>;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: Number(parsed.x), y: Number(parsed.y) };
  } catch {
    return null;
  }
}

function parseStoredTemplates(value: string | null): Template[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((template) => {
        if (!template || typeof template !== "object") return false;
        const candidate = template as Partial<Template>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.name === "string" &&
          typeof candidate.type === "string" &&
          typeof candidate.description === "string" &&
          typeof candidate.content === "string" &&
          (candidate.contentHtml === undefined ||
            typeof candidate.contentHtml === "string")
        );
      })
    ) {
      return null;
    }
    return (parsed as Template[]).map((template) => ({
      ...template,
      contentHtml:
        typeof template.contentHtml === "string"
          ? sanitizeTemplateHtml(template.contentHtml)
          : undefined,
    }));
  } catch {
    return null;
  }
}

function parseTemplateVaultPayload(
  value: string | null,
): TemplateVaultPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TemplateVaultPayload>;
    const templates = Array.isArray(parsed.templates)
      ? parseStoredTemplates(JSON.stringify(parsed.templates))
      : null;
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      !templates
    ) {
      return null;
    }
    return {
      version: 1,
      updatedAt: parsed.updatedAt,
      lastWriter:
        typeof parsed.lastWriter === "string" ? parsed.lastWriter : undefined,
      templates,
    };
  } catch {
    return null;
  }
}

function parseStoredQuicktexts(value: string | null): Quicktext[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<Quicktext>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.shortcut === "string" &&
          typeof candidate.title === "string" &&
          typeof candidate.content === "string" &&
          typeof candidate.category === "string"
        );
      })
    ) {
      return null;
    }
    return parsed as Quicktext[];
  } catch {
    return null;
  }
}

function parseStoredVocabulary(value: string | null): VocabularyItem[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<VocabularyItem>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.heard === "string" &&
          typeof candidate.replacement === "string"
        );
      })
    ) {
      return null;
    }
    return parsed as VocabularyItem[];
  } catch {
    return null;
  }
}

function parseWritingToolsVaultPayload(
  value: string | null,
): WritingToolsVaultPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WritingToolsVaultPayload>;
    const quicktexts = Array.isArray(parsed.quicktexts)
      ? parseStoredQuicktexts(JSON.stringify(parsed.quicktexts))
      : null;
    const vocabulary = Array.isArray(parsed.vocabulary)
      ? parseStoredVocabulary(JSON.stringify(parsed.vocabulary))
      : null;
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      !quicktexts ||
      !vocabulary
    ) {
      return null;
    }
    return {
      version: 1,
      updatedAt: parsed.updatedAt,
      lastWriter:
        typeof parsed.lastWriter === "string" ? parsed.lastWriter : undefined,
      quicktexts,
      vocabulary,
    };
  } catch {
    return null;
  }
}

function parseWebSharedLibraryPayload(
  value: string | null,
): WebSharedLibraryPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WebSharedLibraryPayload>;
    const templates = Array.isArray(parsed.templates)
      ? parseStoredTemplates(JSON.stringify(parsed.templates))
      : null;
    const quicktexts = Array.isArray(parsed.quicktexts)
      ? parseStoredQuicktexts(JSON.stringify(parsed.quicktexts))
      : null;
    const vocabulary = Array.isArray(parsed.vocabulary)
      ? parseStoredVocabulary(JSON.stringify(parsed.vocabulary))
      : null;
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      !templates ||
      !quicktexts ||
      !vocabulary
    ) {
      return null;
    }
    return {
      version: 1,
      updatedAt: parsed.updatedAt,
      templates,
      quicktexts,
      vocabulary,
    };
  } catch {
    return null;
  }
}

function parseWebLibrarySnapshots(value: string | null): WebLibrarySnapshot[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((snapshot): WebLibrarySnapshot | null => {
        if (!snapshot || typeof snapshot !== "object") return null;
        const candidate = snapshot as Partial<WebLibrarySnapshot>;
        const payload = parseWebSharedLibraryPayload(
          JSON.stringify(candidate.payload),
        );
        if (
          !payload ||
          typeof candidate.savedAt !== "number" ||
          !Number.isFinite(candidate.savedAt) ||
          typeof candidate.reason !== "string"
        ) {
          return null;
        }
        return {
          savedAt: candidate.savedAt,
          reason: candidate.reason,
          payload,
        };
      })
      .filter((snapshot): snapshot is WebLibrarySnapshot => Boolean(snapshot))
      .slice(0, 10);
  } catch {
    return [];
  }
}

function parseWebLibraryDeviceRecordForApp(
  value: string | WebLibraryDeviceRecord | null,
): WebLibraryDeviceRecord | null {
  const parsed = parseWebLibraryDeviceRecord(value) as WebLibraryDeviceRecord | null;
  if (!parsed) return null;

  const items: WebLibraryDeviceRecord["items"] = {
    templates: [],
    quicktexts: [],
    vocabulary: [],
  };
  for (const collection of WEB_LIBRARY_COLLECTIONS as WebLibraryCollection[]) {
    for (const operation of parsed.items[collection]) {
      if (operation.tombstone) {
        items[collection].push(operation);
        continue;
      }
      const serialized = JSON.stringify([operation.value]);
      const candidates =
        collection === "templates"
          ? parseStoredTemplates(serialized)
          : collection === "quicktexts"
            ? parseStoredQuicktexts(serialized)
            : parseStoredVocabulary(serialized);
      const candidate = candidates?.[0];
      if (!candidate || candidate.id !== operation.itemId) return null;
      items[collection].push({ ...operation, value: candidate });
    }
  }
  return { ...parsed, items };
}

function mergeWritingToolsForMigration(
  diskPayload: WritingToolsVaultPayload,
  browserPayload: WritingToolsVaultPayload,
): WritingToolsVaultPayload {
  const quicktexts = new Map<string, Quicktext>();
  diskPayload.quicktexts.forEach((item) =>
    quicktexts.set(item.shortcut.trim().toLowerCase(), item),
  );
  browserPayload.quicktexts.forEach((item) =>
    quicktexts.set(item.shortcut.trim().toLowerCase(), item),
  );

  const vocabulary = new Map<string, VocabularyItem>();
  diskPayload.vocabulary.forEach((item) =>
    vocabulary.set(item.heard.trim().toLowerCase(), item),
  );
  browserPayload.vocabulary.forEach((item) =>
    vocabulary.set(item.heard.trim().toLowerCase(), item),
  );

  return {
    version: 1,
    updatedAt: Math.max(currentTimestamp(), diskPayload.updatedAt + 1),
    quicktexts: Array.from(quicktexts.values()),
    vocabulary: Array.from(vocabulary.values()),
  };
}

function formatSyncTime(value: number | null | undefined) {
  if (!value) return "Not synced yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function plainTextToHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function applySpokenPunctuation(text: string, capitalizeStart = true) {
  const punctuatedText = normalizeDictationPunctuation(
    text
      .replace(
        /\btranscription\s+by\s+eso\s+translation(?:\s+by)?(?:\s*[—–-])?/gi,
        " ",
      )
      .replace(/(^|\s)uh+(?:\s*[,;])?(?=\s|$)/gi, "$1")
      .replace(
        /[\[\(\{]\s*(new paragraph|new line|question mark|exclamation (?:mark|point)|semicolon|colon|comma|period|full stop)\s*[\]\)\}]/gi,
        (_, command: string) => {
          const replacements: Record<string, string> = {
            "new paragraph": "\n\n",
            "new line": "\n",
            "question mark": "?",
            "exclamation mark": "!",
            "exclamation point": "!",
            semicolon: ";",
            colon: ":",
            comma: ",",
            period: ".",
            "full stop": ".",
          };
          return replacements[command.toLowerCase()] || command;
        },
      )
      .replace(/[\[\(\{]\s*([,.;:?!])\s*[\]\)\}]/g, "$1")
      .replace(/\bnew paragraph\b/gi, "\n\n")
      .replace(/\bnew line\b/gi, "\n")
      .replace(/\bquestion mark\b/gi, "?")
      .replace(/\bexclamation (?:mark|point)\b/gi, "!")
      .replace(/\bsemicolon\b/gi, ";")
      .replace(/\bcolon\b/gi, ":")
      .replace(/\bcomma\b/gi, ",")
      .replace(/\b(?:period|full stop)\b/gi, "."),
  );

  const sentenceFormattedText = punctuatedText
    .replace(
      /([.!?]\s+|\n+)([a-z])/g,
      (_, prefix: string, letter: string) =>
        `${prefix}${letter.toUpperCase()}`,
    )
    .replace(
      /(,\s+)([A-Z])(?=[a-z])/g,
      (_, prefix: string, letter: string) =>
        `${prefix}${letter.toLowerCase()}`,
    );
  return capitalizeStart
    ? sentenceFormattedText.replace(/^([a-z])/, (letter) =>
        letter.toUpperCase(),
      )
    : sentenceFormattedText.replace(
        /^([A-Z])(?=[a-z])/,
        (letter) => letter.toLocaleLowerCase(),
      );
}

function normalizeDictationPunctuation(text: string) {
  return text
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/,\s*([.!?;:])/g, "$1")
    .replace(/([.!?;:])\s*,/g, "$1")
    .replace(/([.!?;:])(?:\s*\1)+/g, "$1")
    .replace(/[ \t]+([,.;:?!])/g, "$1")
    .replace(/([,.;:?!])(?=[a-zA-Z0-9])/g, "$1 ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function applyVocabularyCorrections(
  text: string,
  vocabulary: VocabularyItem[],
) {
  return [...vocabulary]
    .sort((left, right) => right.heard.length - left.heard.length)
    .reduce((correctedText, item) => {
      const heard = item.heard.trim();
      const replacement = item.replacement.trim();
      if (!heard || !replacement) return correctedText;
      const escapedHeard = heard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return correctedText.replace(
        new RegExp(`\\b${escapedHeard}\\b`, "gi"),
        replacement,
      );
    }, text);
}

function calculateAgeFromDateOfBirth(dateOfBirth: string | undefined) {
  if (!dateOfBirth) return undefined;
  const match = dateOfBirth.match(
    /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2}|\d{4})$/,
  );
  if (!match) return undefined;

  const today = new Date();
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) {
    const currentTwoDigitYear = today.getFullYear() % 100;
    year += year <= currentTwoDigitYear ? 2000 : 1900;
  }

  const parsedDate = new Date(year, month - 1, day);
  if (
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    return undefined;
  }

  let age = today.getFullYear() - year;
  const birthdayHasPassed =
    today.getMonth() > month - 1 ||
    (today.getMonth() === month - 1 && today.getDate() >= day);
  if (!birthdayHasPassed) age -= 1;
  return age >= 0 && age <= 130 ? String(age) : undefined;
}

function formatImportedWeight(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(
    /^(\d{1,4}(?:\.\d+)?)\s*(kg|kgs|kilograms|lb|lbs|pounds)?$/i,
  );
  if (!match) return value;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return value;
  const unit = match[2]?.toLowerCase();
  const roundToOneDecimal = (number: number) =>
    String(Math.round(number * 10) / 10);

  if (unit === "kg" || unit === "kgs" || unit === "kilograms") {
    const pounds = amount / 0.45359237;
    return `${roundToOneDecimal(pounds)} lbs (${roundToOneDecimal(amount)} kg)`;
  }

  const kilograms = amount * 0.45359237;
  return `${roundToOneDecimal(amount)} lbs (${roundToOneDecimal(kilograms)} kg)`;
}

function extractCpapSummary(text: string) {
  const normalizedText = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const findValue = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
    }
    return undefined;
  };

  const reportPeriod = findValue([
    /\bUsage\s+(\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    /\bReport(?:ing)? Period\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
  ]);
  const usageDays = findValue([
    /\bUsage days\s+(\d+\/\d+(?:\s+days?)?\s*\(\d+%\))/i,
    /\bDays used\s+(\d+\/\d+(?:\s+days?)?\s*\(\d+%\))/i,
  ]);
  const fourHourUsage = findValue([
    />=\s*4\s*hours?\s+(\d+(?:\/\d+)?(?:\s+days?)?\s*\(\d+%\))/i,
    /\b>=\s*4\s*hour days\s+(\d+(?:\/\d+)?(?:\s+days?)?\s*\(\d+%\))/i,
  ]);
  const averageUsage = findValue([
    /\bAverage usage\s*\(days used\)\s+(\d+\s+hours?(?:\s+\d+\s+minutes?)?)/i,
    /\bUsed\/day\s*\(avg\.\)\s+(\d+(?:\.\d+)?\s*(?:hrs?|hours?))/i,
    /\bAverage usage\s*\(total days\)\s+(\d+\s+hours?(?:\s+\d+\s+minutes?)?)/i,
  ]);
  const mode = findValue([
    /\bMode\s+(.{1,40}?)(?=\s+(?:(?:Set\s+)?(?:Min|Max|Set)\s+Pressure|Pressure\s*-\s*cmH2O|EPR|Ramp|AHI\b))/i,
    /\bMode\s+([A-Za-z][A-Za-z0-9-]*)\b/i,
  ]);
  const minimumPressure = findValue([
    /\b(?:Set\s+)?Min(?:imum)? Pressure\s+(\d+(?:\.\d+)?)\b/i,
    /\bMin EPAP\s+(\d+(?:\.\d+)?)\b/i,
  ]);
  const maximumPressure = findValue([
    /\b(?:Set\s+)?Max(?:imum)? Pressure\s+(\d+(?:\.\d+)?)\b/i,
    /\bMax IPAP\s+(\d+(?:\.\d+)?)\b/i,
  ]);
  const fixedPressure = findValue([
    /\bSet Pressure\s+(\d+(?:\.\d+)?)\b/i,
    /\bCPAP Pressure\s+(\d+(?:\.\d+)?)\b/i,
  ]);
  const pressure95 = findValue([
    /\bPressure\s*-\s*cmH2O[\s\S]{0,120}?95th percentile\s*:\s*(\d+(?:\.\d+)?)\b/i,
    /\b95(?:th)? percentile pressure\s*:?\s*(\d+(?:\.\d+)?)\b/i,
  ]);
  const leak95 = findValue([
    /\bLeaks?\s*-\s*L\/min[\s\S]{0,120}?95th percentile\s*:\s*(\d+(?:\.\d+)?)\b/i,
    /\b95(?:th)? percentile leaks?\s*:?\s*(\d+(?:\.\d+)?)\b/i,
  ]);
  const ahi = findValue([
    /\bEvents per hour\b[\s\S]{0,180}?\bAHI\s*:?\s*(\d+(?:\.\d+)?)\b/i,
    /\bAHI\s*\(events\/hour\)\s*:?\s*(\d+(?:\.\d+)?)\b/i,
    /\bAHI\s*:\s*(\d+(?:\.\d+)?)\b/i,
  ]);

  if (!usageDays && !fourHourUsage && !mode && !pressure95 && !leak95 && !ahi) {
    return undefined;
  }

  const lines: string[] = [];
  if (reportPeriod) lines.push(`PAP compliance period: ${reportPeriod}.`);

  if (usageDays) lines.push(`Usage days: ${usageDays}.`);
  if (fourHourUsage) {
    lines.push(`Days with at least 4 hours: ${fourHourUsage}.`);
  }
  if (averageUsage) {
    lines.push(`Average usage on days used: ${averageUsage}.`);
  }

  let settings = mode;
  if (minimumPressure && maximumPressure) {
    settings = `${mode ? `${mode} ` : ""}${minimumPressure}-${maximumPressure} cmH2O`;
  } else if (fixedPressure) {
    settings = `${mode ? `${mode} ` : ""}${fixedPressure} cmH2O`;
  }
  if (settings) lines.push(`Settings: ${settings}.`);
  if (pressure95) {
    lines.push(`95th percentile pressure: ${pressure95} cmH2O.`);
  }
  if (leak95) lines.push(`95th percentile leak: ${leak95} L/min.`);
  if (ahi) lines.push(`Residual AHI: ${ahi} events/hour.`);
  return lines.join("\n");
}

function normalizePatientName(value: string) {
  const commaParts = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(",")
    .map((part) => part.match(/[a-z0-9]+/g) || []);
  const tokens =
    commaParts.length > 1
      ? [...commaParts.slice(1).flat(), ...commaParts[0]]
      : commaParts[0];
  const meaningfulTokens = tokens.filter(
    (token) => !/^(?:jr|sr|ii|iii|iv)$/.test(token),
  );
  return {
    first: meaningfulTokens[0] || "",
    last: meaningfulTokens[meaningfulTokens.length - 1] || "",
  };
}

function extractHstPatientName(text: string) {
  const sectionText = text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
  const normalizedText = sectionText.replace(/\s+/g, " ").trim();
  const lastName = normalizedText.match(
    /\bLast Name\s*[:=-]\s*([A-Za-zÀ-ž][A-Za-zÀ-ž .'-]{0,59}?)(?=\s+First Name\s*[:=-]|\s+(?:DOB|Date of Birth|MRN|Medical Record|Patient ID|Gender|Sex|Age|Study Date|Date of Study)\s*[:=-]|$)/i,
  )?.[1];
  const firstName = normalizedText.match(
    /\bFirst Name\s*[:=-]\s*([A-Za-zÀ-ž][A-Za-zÀ-ž .'-]{0,59}?)(?=\s+Last Name\s*[:=-]|\s+(?:DOB|Date of Birth|MRN|Medical Record|Patient ID|Gender|Sex|Age|Study Date|Date of Study)\s*[:=-]|$)/i,
  )?.[1];
  if (firstName && lastName) return `${firstName.trim()} ${lastName.trim()}`;

  const labeledLine = sectionText.match(
    /(?:^|\n)\s*(?:Patient(?:'s)?(?:\s+Name)?|Name)\s*[:=-]\s*([^\n]{2,100})/i,
  )?.[1];
  if (!labeledLine) return undefined;
  const cleanedName = labeledLine
    .replace(
      /\s+(?:DOB|Date of Birth|MRN|Medical Record(?: Number)?|Patient ID|Gender|Sex|Age|Study Date|Date of Study)\s*[:=-].*$/i,
      "",
    )
    .trim();
  return cleanedName || undefined;
}

function patientNamesMatch(intakeName: string, hstName: string) {
  const intake = normalizePatientName(intakeName);
  const hst = normalizePatientName(hstName);
  return Boolean(
    intake.first &&
      intake.last &&
      hst.first &&
      hst.last &&
      intake.first === hst.first &&
      intake.last === hst.last,
  );
}

function extractHstSummary(text: string) {
  const sectionText = text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
  const normalizedText = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedText) return undefined;

  const findValue = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
    }
    return undefined;
  };
  const findIndex = (labelPattern: string) => {
    const overallPattern = new RegExp(
      `\\b(?:overall|total)\\s+(${labelPattern})\\s*(?:\\([^)]*\\))?\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b(?!\\s*%)`,
      "i",
    );
    const overallMatch = normalizedText.match(overallPattern);
    if (overallMatch?.[1] && overallMatch[2]) {
      return { label: overallMatch[1], value: overallMatch[2] };
    }

    const generalPattern = new RegExp(
      `\\b(${labelPattern})\\s*(?:\\([^)]*\\))?\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b(?!\\s*%)`,
      "gi",
    );
    for (const match of normalizedText.matchAll(generalPattern)) {
      const prefix = normalizedText.slice(
        Math.max(0, match.index - 18),
        match.index,
      );
      if (/supine|non[- ]?supine/i.test(prefix)) continue;
      return { label: match[1], value: match[2] };
    }
    return undefined;
  };
  const findScoredIndex = (percent: string) => {
    const descriptor =
      "(?:oxygen\\s+desat(?:uration)?s?|desat(?:uration)?s?|criterion|criteria|rule|scoring|AASM\\s*[\\w.-]+|CMS)";
    const afterLabelPattern = new RegExp(
      `\\b(?:overall\\s+|total\\s+)?(p?AHI|REI)\\s*(?:[-–—:]\\s*)?(?:\\(\\s*)?${percent}\\s*%\\s*(?:${descriptor}\\s*)*\\)?(?:\\s*\\([^)]*\\))?\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b`,
      "i",
    );
    const afterLabelMatch = normalizedText.match(afterLabelPattern);
    if (afterLabelMatch?.[1] && afterLabelMatch[2]) {
      return { label: afterLabelMatch[1], value: afterLabelMatch[2] };
    }

    const beforeLabelPattern = new RegExp(
      `(?:\\(\\s*)?\\b${percent}\\s*%\\s*(?:${descriptor}\\s*)*\\)?\\s*(?:[-–—:]\\s*)?(p?AHI|REI)\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b`,
      "i",
    );
    const beforeLabelMatch = normalizedText.match(beforeLabelPattern);
    if (beforeLabelMatch?.[1] && beforeLabelMatch[2]) {
      return { label: beforeLabelMatch[1], value: beforeLabelMatch[2] };
    }
    return undefined;
  };

  const studyDate = findValue([
    /\b(?:Date of Study|Study Date|Recording Date)\s*[:=-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/i,
  ]);
  const recordingTime = findValue([
    /\b(?:Total )?(?:Recording|Monitoring|Analysis|Sleep) Time\s*[:=-]?\s*(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)(?:\s+\d+(?:\.\d+)?\s*(?:minutes?|mins?))?)/i,
  ]);
  const respiratoryIndex = findIndex("p?AHI|REI");
  const ahi3Percent = findScoredIndex("3");
  const ahi4Percent = findScoredIndex("4");
  const supineIndexMatch = normalizedText.match(
    /\bSupine\s+(p?AHI|REI)\s*(?:\([^)]*\))?\s*[:=-]?\s*(\d+(?:\.\d+)?)\b/i,
  );
  const rdi = findValue([
    /\b(?:Overall\s+|Total\s+)?RDI\s*(?:\([^)]*\))?\s*[:=-]?\s*(\d+(?:\.\d+)?)\b/i,
  ]);
  const odi = findValue([
    /\b(?:Overall\s+|Total\s+)?(?:ODI|Oxygen Desaturation Index)\s*(?:\([^)]*\))?\s*[:=-]?\s*(\d+(?:\.\d+)?)\b/i,
  ]);
  const meanSpo2 = findValue([
    /\b(?:Mean|Average|Avg\.?)\s+(?:SpO2|Oxygen Saturation|SaO2)\s*[:=-]?\s*(\d+(?:\.\d+)?\s*%?)/i,
    /\b(?:SpO2|Oxygen Saturation|SaO2)\s+(?:Mean|Average|Avg\.?)\s*[:=-]?\s*(\d+(?:\.\d+)?\s*%?)/i,
  ]);
  const oxygenNadir = findValue([
    /\b(?:SpO2|Oxygen Saturation|SaO2)?\s*(?:Nadir|Minimum|Min\.?)\s*(?:SpO2|Oxygen Saturation|SaO2)?\s*[:=-]?\s*(\d+(?:\.\d+)?\s*%?)/i,
    /\bLowest\s+(?:SpO2|Oxygen Saturation|SaO2)\s*[:=-]?\s*(\d+(?:\.\d+)?\s*%?)/i,
  ]);
  const timeAtOrBelow88 = findValue([
    /\b(?:Time\s+)?(?:(?:at|below|under)\s*(?:<=?\s*)?|<=?\s*|≤\s*)88\s*%\s*[:=-]?\s*(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?))/i,
    /\b(?:SpO2|Oxygen Saturation|SaO2)\s*(?:<=?|≤)\s*88\s*%\s*[:=-]?\s*(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?))/i,
  ]);
  const impression = sectionText
    .match(
      /(?:^|\n)\s*(?:Impression|Interpretation|Diagnosis)\s*[:=-]?\s*([\s\S]*?)(?=\n\s*(?:(?:Recommendations?|Plan|Comments?|Notes?|Technique|Methodology|Report Status)\s*[:=-]|(?:Electronically\s+signed|Signed\s+by|Interpreting\s+Physician|Physician)\b)|$)/i,
    )?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  const recommendations = sectionText
    .match(
      /(?:^|\n)\s*Recommendations?\s*[:=-]?\s*([\s\S]*?)(?=\n\s*(?:(?:Plan|Comments?|Notes?|Technique|Methodology|Report Status)\s*[:=-]|(?:Electronically\s+signed|Signed\s+by|Interpreting\s+Physician|Physician)\b)|$)/i,
    )?.[1]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (
    !respiratoryIndex &&
    !ahi3Percent &&
    !ahi4Percent &&
    !supineIndexMatch &&
    !rdi &&
    !odi &&
    !oxygenNadir &&
    !meanSpo2 &&
    !timeAtOrBelow88 &&
    !impression &&
    !recommendations
  ) {
    return undefined;
  }

  const withPercent = (value: string) =>
    value.includes("%") ? value : `${value}%`;
  const lines: string[] = [];
  if (studyDate) lines.push(`HST date: ${studyDate}.`);
  if (recordingTime) lines.push(`Recording time: ${recordingTime}.`);
  const respiratoryParts = [
    ahi3Percent
      ? `${ahi3Percent.label.toUpperCase()} (3%) ${ahi3Percent.value} events/hour`
      : null,
    ahi4Percent
      ? `${ahi4Percent.label.toUpperCase()} (4%) ${ahi4Percent.value} events/hour`
      : null,
    !ahi3Percent && !ahi4Percent && respiratoryIndex
      ? `${respiratoryIndex.label.toUpperCase()} ${respiratoryIndex.value} events/hour`
      : null,
    supineIndexMatch
      ? `supine ${supineIndexMatch[1].toUpperCase()} ${supineIndexMatch[2]} events/hour`
      : null,
    rdi ? `RDI ${rdi} events/hour` : null,
    odi ? `ODI ${odi} events/hour` : null,
  ].filter((value): value is string => Boolean(value));
  if (respiratoryParts.length > 0) {
    lines.push(`Respiratory findings: ${respiratoryParts.join("; ")}.`);
  }
  const oxygenParts = [
    meanSpo2 ? `mean SpO2 ${withPercent(meanSpo2)}` : null,
    oxygenNadir ? `nadir ${withPercent(oxygenNadir)}` : null,
    timeAtOrBelow88 ? `<=88% for ${timeAtOrBelow88}` : null,
  ].filter((value): value is string => Boolean(value));
  if (oxygenParts.length > 0) lines.push(`Oximetry: ${oxygenParts.join("; ")}.`);
  if (impression) lines.push(`Impression: ${impression}`);
  if (recommendations) lines.push(`Recommendations: ${recommendations}`);
  return lines.join("\n");
}

function extractPdfMeasurements(text: string): PdfMeasurements {
  const normalizedText = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const sectionText = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ");
  const findValue = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
    }
    return undefined;
  };
  const findSection = (pattern: RegExp) => {
    const match = sectionText.match(pattern);
    if (!match?.[1]) return undefined;
    return match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  };
  const cleanMedicationListEnding = (value: string | undefined) => {
    if (!value) return undefined;
    const cleaned = value.replace(/(?:\s*[-:])+\s*$/, "").trim();
    return cleaned || undefined;
  };
  const formatEssSection = (value: string | undefined) => {
    if (!value) return undefined;
    const essRatingScores: Record<string, number> = {
      none: 0,
      slight: 1,
      moderate: 2,
      high: 3,
    };
    return value
      .replace(
        /(How likely is the patient to doze off in the situations below:)\s*/i,
        "$1\n",
      )
      .replace(/[ \t]+(?=-\s+)/g, "\n")
      .replace(/[ \t]+(?=SCORE:\s*\d+)/gi, "\n")
      .replace(/\n{2,}/g, "\n")
      .split("\n")
      .map((line) =>
        line.replace(
          /:\s*(None|Slight|Moderate|High)\s*$/i,
          (_match, rating: string) => {
            const normalizedRating =
              rating.charAt(0).toUpperCase() + rating.slice(1).toLowerCase();
            return `: ${normalizedRating} (${essRatingScores[rating.toLowerCase()]})`;
          },
        ),
      )
      .join("\n")
      .trim();
  };
  const essSection = findSection(
    /Epworth Sleep Score:\s*([\s\S]*?)\s*Weight Health:/i,
  );
  const dateOfBirth = findValue([
    /\bDate of Birth\s*:\s*(\d{1,2}[/. -]\d{1,2}[/. -](?:\d{2}|\d{4}))\b/i,
    /\bDOB\s*:\s*(\d{1,2}[/. -]\d{1,2}[/. -](?:\d{2}|\d{4}))\b/i,
  ]);
  const gender = findValue([
    /\bGender\s*:\s*(Female|Male|Non[- ]?binary|Woman|Man|Other|Unknown|Prefer not to (?:answer|say)|Declined|[MFX])\b/i,
    /\bPatient Sex\s*:\s*(Female|Male|Other|Unknown|[MFX])\b/i,
  ]);
  const medications = findSection(
    /Active Medications:\s*(?:The patient is currently taking the following medications:\s*)?([\s\S]*?)\s*Medication Allergies:/i,
  );
  const weight = findValue([
    /\b(?:weight|wt)\b\s*[:=-]?\s*(\d{2,4}(?:\.\d+)?\s*(?:kg|kgs|kilograms|lb|lbs|pounds))\b/i,
    /\b(?:weight|wt)\b\s*[:=-]?\s*(\d{2,4}(?:\.\d+)?)\b/i,
  ]);

  return {
    name: findValue([
      /\bName\s*:\s*([\s\S]{1,100}?)\s+Date of Birth\s*:/i,
      /\bPatient Name\s*:\s*([\s\S]{1,100}?)\s+(?:DOB|Gender)\s*:/i,
    ]),
    age:
      findValue([/\bPatient Age\s*:\s*(\d{1,3})\b/i]) ||
      calculateAgeFromDateOfBirth(dateOfBirth),
    gender: gender?.toLowerCase(),
    height: findValue([
      /\b(?:height|ht)\b\s*[:=-]?\s*(\d{1,2}\s*(?:ft|feet|foot|')\s*\d{1,2}(?:\.\d+)?\s*(?:inches|inch|in|")?)/i,
      /\b(?:height|ht)\b\s*[:=-]?\s*(\d{2,3}(?:\.\d+)?\s*(?:cm|centimeters|inches|inch|in|"))/i,
      /\b(?:height|ht)\b\s*[:=-]?\s*(\d(?:\.\d{1,2})\s*(?:m|meters|metres))\b/i,
    ]),
    weight: formatImportedWeight(weight),
    bmi: findValue([
      /\b(?:body mass index|bmi)\b\s*[:=-]?\s*(\d{1,2}(?:\.\d+)?)\b/i,
    ]),
    meds: cleanMedicationListEnding(medications),
    allergies: findSection(
      /Medication Allergies:\s*(?:The patient is allergic to the following medications:\s*)?([\s\S]*?)\s*Past Medical History:/i,
    ),
    pastMedicalHistory: findSection(
      /Past Medical History:\s*(?:The patient (?:has|reports) the following (?:past )?medical history:\s*)?([\s\S]*?)(?=\s*(?:Past Surgical History|Surgical History|Sleep Questionnaire|Patient reports the following social history|Social History|Family History|Patient has had a sleep study|Active Medications|$))/i,
    ),
    sleepQuestionnaire: findSection(
      /Sleep Questionnaire:\s*([\s\S]*?)\s*Epworth Sleep Score:/i,
    ),
    ess:
      formatEssSection(essSection) ||
      findValue([
        /\bEpworth(?: Sleepiness)? Score\b\s*[:=-]?\s*(\d{1,2})\b/i,
      ]),
    familyHistory: findSection(
      /Family History:\s*([\s\S]*?)\s*Patient has had a sleep study/i,
    ),
    socialHistory: findSection(
      /Patient reports the following social history:\s*([\s\S]*?)\s*Family History:/i,
    ),
  };
}

function resolveMeasurementTokens(
  content: string,
  measurements: PdfMeasurements | null,
  forHtml = false,
) {
  if (!measurements) return content;
  const fieldValue = (value: string | undefined, fallback: string) =>
    value ? (forHtml ? plainTextToHtml(value) : value) : fallback;
  return content
    .replace(/\.cpap\b/gi, fieldValue(measurements.cpap, ".cpap"))
    .replace(/\.hst\b/gi, fieldValue(measurements.hst, ".hst"))
    .replace(
      /\.sleepquestionnaire\b/gi,
      fieldValue(measurements.sleepQuestionnaire, ".sleepquestionnaire"),
    )
    .replace(
      /\.familyhistory\b/gi,
      fieldValue(measurements.familyHistory, ".familyhistory"),
    )
    .replace(
      /\.socialhistory\b/gi,
      fieldValue(measurements.socialHistory, ".socialhistory"),
    )
    .replace(
      /\.pastmedicalhistory\b/gi,
      fieldValue(measurements.pastMedicalHistory, ".pastmedicalhistory"),
    )
    .replace(/\.name\b/gi, fieldValue(measurements.name, ".name"))
    .replace(/\.age\b/gi, fieldValue(measurements.age, ".age"))
    .replace(/\.gender\b/gi, fieldValue(measurements.gender, ".gender"))
    .replace(/\.height\b/gi, fieldValue(measurements.height, ".height"))
    .replace(/\.weight\b/gi, fieldValue(measurements.weight, ".weight"))
    .replace(/\.bmi\b/gi, fieldValue(measurements.bmi, ".bmi"))
    .replace(/\.meds\b/gi, fieldValue(measurements.meds, ".meds"))
    .replace(
      /\.allergies\b/gi,
      fieldValue(measurements.allergies, ".allergies"),
    )
    .replace(/\.ess\b/gi, fieldValue(measurements.ess, ".ess"));
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function resampleAudio(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16000,
) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceStart = Math.floor(outputIndex * ratio);
    const sourceEnd = Math.min(
      input.length,
      Math.max(sourceStart + 1, Math.floor((outputIndex + 1) * ratio)),
    );
    let total = 0;
    for (
      let sourceIndex = sourceStart;
      sourceIndex < sourceEnd;
      sourceIndex += 1
    ) {
      total += input[sourceIndex];
    }
    output[outputIndex] = total / (sourceEnd - sourceStart);
  }
  return output;
}

function encodePcm16Wav(audio: Float32Array, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + audio.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, audio.length * 2, true);

  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index]));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return buffer;
}

function cleanWhisperTranscript(text: string) {
  const cleaned = text
    .replace(
      /[\[(]\s*(?:silence|blank audio|no speech|noise|music|inaudible|clapping|applause|clicking|clicing|typing|sighing|scoffs?|whooshing|whoosing|coughs?|sh+h+)\s*[\])]/gi,
      " ",
    )
    .replace(/\bsh+h+\b[.!?,]*/gi, " ")
    .replace(
      /\s*(?:thank you(?:\s+for\s+(?:watching|listening))?|thanks\s+for\s+(?:watching|listening))[.!?]*\s*$/gi,
      " ",
    )
    .replace(
      /\b(?:subtitles?|captions?)\s+(?:by|provided\s+by)\s+(?:the\s+)?amara(?:\.org|\s+org)?(?:\s+community)?\b/gi,
      " ",
    )
    .replace(
      /\b(?:subtitles?|captions?)\s+(?:by|provided\s+by)\s+gettranscribed(?:\.com|\s+com)?\b/gi,
      " ",
    )
    .replace(
      /\btranscription\s+by\s+eso\s+translation(?:\s+by)?(?:\s*[—–-])?/gi,
      " ",
    )
    .replace(
      /\b(?:transcription|transcribed|subtitles?|captions?)\s+(?:by|provided\s+by)\s+(?:castingwords(?:\.com|\s+com)?|eso\s+translation)\b(?:\s+by\s*[—–-]?)?/gi,
      " ",
    )
    .replace(/[.!?;:]+/g, " ")
    .replace(/(?:\s*,\s*){2,}/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return collapseRepeatedWhisperPhrases(cleaned);
}

function collapseRepeatedWhisperPhrases(text: string) {
  const words = text.split(/\s+/).filter(Boolean);
  const collapsed: string[] = [];
  let index = 0;

  while (index < words.length) {
    let repeatedPhraseLength = 0;
    let repeatedPhraseCount = 0;
    const maxPhraseLength = Math.min(5, Math.floor((words.length - index) / 3));

    for (let phraseLength = 1; phraseLength <= maxPhraseLength; phraseLength += 1) {
      const phrase = words
        .slice(index, index + phraseLength)
        .map((word) => word.toLocaleLowerCase());
      let repeatCount = 1;

      while (index + (repeatCount + 1) * phraseLength <= words.length) {
        const candidate = words
          .slice(
            index + repeatCount * phraseLength,
            index + (repeatCount + 1) * phraseLength,
          )
          .map((word) => word.toLocaleLowerCase());
        if (!candidate.every((word, wordIndex) => word === phrase[wordIndex])) {
          break;
        }
        repeatCount += 1;
      }

      if (repeatCount >= 3) {
        repeatedPhraseLength = phraseLength;
        repeatedPhraseCount = repeatCount;
        break;
      }
    }

    if (repeatedPhraseCount >= 3) {
      collapsed.push(...words.slice(index, index + repeatedPhraseLength));
      index += repeatedPhraseLength * repeatedPhraseCount;
    } else {
      collapsed.push(words[index]);
      index += 1;
    }
  }

  return collapsed.join(" ");
}

export default function Home() {
  const [note, setNote] = useState("");
  const [isFramed] = useState(() => webEdition && detectWindowFraming());
  const [noteHtml, setNoteHtml] = useState("");
  const [noteCopied, setNoteCopied] = useState(true);
  const [activePanel, setActivePanel] = useState<
    "quicktext" | "templates" | "vocabulary"
  >("templates");
  const [search, setSearch] = useState("");
  const [quicktexts, setQuicktexts] = useState(starterQuicktexts);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);
  const [templateStorageStatus, setTemplateStorageStatus] =
    useState(webEdition ? "Checking shared library" : "Loading protected copy");
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [writingToolsReady, setWritingToolsReady] = useState(false);
  const [writingToolsStorageStatus, setWritingToolsStorageStatus] =
    useState(webEdition ? "Checking shared library" : "Loading shared copy");
  const [sharedStorageStatus, setSharedStorageStatus] =
    useState<SharedStorageStatus | null>(null);
  const [syncRefreshing, setSyncRefreshing] = useState(false);
  const [syncConflictNotice, setSyncConflictNotice] = useState("");
  const [showSyncDashboard, setShowSyncDashboard] = useState(false);
  const [webSharedLibraryStatus, setWebSharedLibraryStatus] = useState(
    "Checking shared library",
  );
  const [webLibraryOwnerKey, setWebLibraryOwnerKey] = useState("");
  const [webLibraryDirty, setWebLibraryDirty] = useState(false);
  const [webLibrarySaving, setWebLibrarySaving] = useState(false);
  const [webLibrarySnapshots, setWebLibrarySnapshots] = useState<
    WebLibrarySnapshot[]
  >([]);
  const [showWebLibraryManager, setShowWebLibraryManager] = useState(false);
  const [showSystemCheck, setShowSystemCheck] = useState(false);
  const [systemCheckRefreshing, setSystemCheckRefreshing] = useState(false);
  const [pdfMeasurements, setPdfMeasurements] =
    useState<PdfMeasurements | null>(null);
  const [pdfStatus, setPdfStatus] = useState(
    "Choose a PDF to extract intake and sleep fields",
  );
  const [papPdfStatus, setPapPdfStatus] = useState(
    "Choose a PAP compliance PDF to prepare .cpap",
  );
  const [hstStatus, setHstStatus] = useState(
    "Paste HST results to prepare .hst",
  );
  const [showHstPaste, setShowHstPaste] = useState(false);
  const [hstPasteText, setHstPasteText] = useState("");
  const [deletePdfAfterScan, setDeletePdfAfterScan] = useState(!webEdition);
  const [isScanningPdf, setIsScanningPdf] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [dictationEngine, setDictationEngine] =
    useState<DictationEngine>("whisper");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("default");
  const [dockCollapsed, setDockCollapsed] = useState(true);
  const [dockPosition, setDockPosition] = useState<DockPosition | null>(null);
  const hasCustomDockPosition = dockPosition !== null;
  const [dockDragging, setDockDragging] = useState(false);
  const [microphoneTestState, setMicrophoneTestState] =
    useState<MicrophoneTestState>("idle");
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [microphoneTestMessage, setMicrophoneTestMessage] = useState(
    "Test your microphone before dictating",
  );
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [toast, setToast] = useState("");
  const [showQuicktextForm, setShowQuicktextForm] = useState(false);
  const [editingQuicktext, setEditingQuicktext] =
    useState<Quicktext | null>(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [showVocabularyForm, setShowVocabularyForm] = useState(false);
  const [editingVocabulary, setEditingVocabulary] =
    useState<VocabularyItem | null>(null);
  const [lastRecognizedPhrase, setLastRecognizedPhrase] = useState("");
  const [learningHeard, setLearningHeard] = useState("");
  const [interimText, setInterimText] = useState("");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [whisperSupported, setWhisperSupported] = useState(true);
  const [whisperReady, setWhisperReady] = useState(false);
  const [whisperProgress, setWhisperProgress] = useState(0);
  const [whisperInstallStatus, setWhisperInstallStatus] =
    useState<WhisperInstallStatus>({
      status: "checking",
      installed: false,
      message: "Checking Whisper on this computer.",
    });
  const [whisperUpdatePromptDismissed, setWhisperUpdatePromptDismissed] =
    useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    underline: false,
  });
  const recognitionRef = useRef<Recognition | null>(null);
  const templatesUpdatedAtRef = useRef(0);
  const writingToolsUpdatedAtRef = useRef(0);
  const webSharedLibraryUpdatedAtRef = useRef(0);
  const webSharedLibrarySavingRef = useRef(false);
  const webSharedLibrarySaveQueueRef = useRef<Promise<boolean | void>>(
    Promise.resolve(),
  );
  const webSharedLibraryDirtyRef = useRef(false);
  const webSharedLibraryBaseRef = useRef<WebSharedLibraryPayload | null>(null);
  const webSharedLibraryLocalRef = useRef<WebSharedLibraryPayload | null>(null);
  const webSharedLibraryMutationEpochRef = useRef(0);
  const webLibraryOwnerKeyRef = useRef("");
  const webLibraryDeviceIdRef = useRef("");
  const webLibraryActorIdRef = useRef("");
  const webLibraryActorCounterRef = useRef(0);
  const webLibraryDeviceRecordRef = useRef<WebLibraryDeviceRecord | null>(null);
  const webLibraryHeadsRef = useRef(new Map<string, WebLibraryOperation[]>());
  const webLibraryConflictsRef = useRef<WebLibraryConflict[]>([]);
  const webLibraryRefreshEpochRef = useRef(0);
  const templateBaseRef = useRef<TemplateVaultPayload | null>(null);
  const writingToolsBaseRef = useRef<WritingToolsVaultPayload | null>(null);
  const refreshSharedLibraryRef = useRef<
    ((showFeedback?: boolean) => Promise<void>) | null
  >(null);
  const saveWebSharedLibraryRef = useRef<
    | ((
        nextTemplates: Template[],
        nextQuicktexts: Quicktext[],
        nextVocabulary: VocabularyItem[],
        updatedAt: number,
      ) => void)
    | null
  >(null);
  const whisperLoadPromiseRef = useRef<Promise<void> | null>(null);
  const whisperResultHandlerRef = useRef<
    (text: string, session: number) => void
  >(() => undefined);
  const whisperStreamRef = useRef<MediaStream | null>(null);
  const whisperAudioContextRef = useRef<AudioContext | null>(null);
  const whisperSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const whisperProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const whisperMuteRef = useRef<GainNode | null>(null);
  const whisperChunksRef = useRef<Float32Array[]>([]);
  const whisperSampleCountRef = useRef(0);
  const whisperSampleRateRef = useRef(16000);
  const whisperLastVoiceAtRef = useRef(0);
  const whisperHasSpeechRef = useRef(false);
  const whisperJobIdRef = useRef(0);
  const whisperPendingJobsRef = useRef(0);
  const whisperSessionRef = useRef(0);
  const whisperSegmentRef = useRef(0);
  const whisperPreviewInFlightRef = useRef(false);
  const whisperLastPreviewSampleCountRef = useRef(0);
  const whisperFinalSequenceRef = useRef(0);
  const whisperNextCommitRef = useRef(1);
  const whisperFinalResultsRef = useRef(
    new Map<number, { text: string; session: number }>(),
  );
  const isRecordingRef = useRef(false);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const papPdfInputRef = useRef<HTMLInputElement | null>(null);
  const lastSelectionRef = useRef<Range | null>(null);
  const templateEditorRef = useRef<HTMLDivElement | null>(null);
  const webLibraryImportRef = useRef<HTMLInputElement | null>(null);
  const templateSelectionRef = useRef<Range | null>(null);
  const interimTranscriptRef = useRef("");
  const shouldRestartRef = useRef(false);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const dockDragRef = useRef<{
    offsetX: number;
    offsetY: number;
    latest: DockPosition;
  } | null>(null);
  const microphoneTestStreamRef = useRef<MediaStream | null>(null);
  const microphoneTestContextRef = useRef<AudioContext | null>(null);
  const microphoneTestSourceRef =
    useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneTestAnimationRef = useRef<number | null>(null);
  const microphoneTestTimerRef = useRef<number | null>(null);
  const microphoneTestPeakRef = useRef(0);
  const microphoneTestSessionRef = useRef(0);

  const rememberWebLibrarySnapshot = useCallback(
    (payload: WebSharedLibraryPayload, reason: string) => {
      if (!webEdition) return;
      const existing = parseWebLibrarySnapshots(
        window.localStorage.getItem(storageKeys.webLibrarySnapshots),
      );
      const serializedPayload = JSON.stringify(payload);
      const snapshots = [
        { savedAt: currentTimestamp(), reason, payload },
        ...existing.filter(
          (snapshot) => JSON.stringify(snapshot.payload) !== serializedPayload,
        ),
      ].slice(0, 10);
      window.localStorage.setItem(
        storageKeys.webLibrarySnapshots,
        JSON.stringify(snapshots),
      );
      setWebLibrarySnapshots(snapshots);
    },
    [],
  );

  const persistWebLibraryLocally = useCallback(
    (
      payload: WebSharedLibraryPayload,
      options: {
        dirty: boolean;
        base?: WebSharedLibraryPayload | null;
        snapshotReason?: string;
      },
    ) => {
      const sanitizedPayload =
        parseWebSharedLibraryPayload(JSON.stringify(payload)) || payload;
      const serializedTemplates = JSON.stringify(sanitizedPayload.templates);
      webSharedLibraryLocalRef.current = sanitizedPayload;
      webSharedLibraryDirtyRef.current = options.dirty;
      setWebLibraryDirty(options.dirty);
      webSharedLibraryUpdatedAtRef.current = sanitizedPayload.updatedAt;
      templatesUpdatedAtRef.current = sanitizedPayload.updatedAt;
      writingToolsUpdatedAtRef.current = sanitizedPayload.updatedAt;
      setTemplates(sanitizedPayload.templates);
      setQuicktexts(sanitizedPayload.quicktexts);
      setVocabulary(sanitizedPayload.vocabulary);
      setTemplatesReady(true);
      setWritingToolsReady(true);
      window.localStorage.setItem(storageKeys.templates, serializedTemplates);
      window.localStorage.setItem(
        storageKeys.templatesBackup,
        serializedTemplates,
      );
      window.localStorage.setItem(
        storageKeys.templatesUpdatedAt,
        String(sanitizedPayload.updatedAt),
      );
      window.localStorage.setItem(
        storageKeys.quicktexts,
        JSON.stringify(sanitizedPayload.quicktexts),
      );
      window.localStorage.setItem(
        storageKeys.vocabulary,
        JSON.stringify(sanitizedPayload.vocabulary),
      );
      window.localStorage.setItem(
        storageKeys.writingToolsUpdatedAt,
        String(sanitizedPayload.updatedAt),
      );
      window.localStorage.setItem(
        storageKeys.webLibraryDirty,
        options.dirty ? "true" : "false",
      );
      if (options.base !== undefined) {
        webSharedLibraryBaseRef.current = options.base;
        if (options.base) {
          window.localStorage.setItem(
            storageKeys.webLibraryBase,
            JSON.stringify(options.base),
          );
        } else {
          window.localStorage.removeItem(storageKeys.webLibraryBase);
        }
      }
      if (options.snapshotReason) {
        rememberWebLibrarySnapshot(
          sanitizedPayload,
          options.snapshotReason,
        );
      }
      return sanitizedPayload;
    },
    [rememberWebLibrarySnapshot],
  );

  const readWebLibraryOutbox = useCallback(() => {
    const deviceId = webLibraryDeviceIdRef.current;
    if (!deviceId) return [] as WebLibraryPendingOperation[];
    const entries: WebLibraryPendingOperation[] = [];
    const prefix = `${webLibraryOutboxPrefix}${deviceId}:`;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as
          | WebLibraryPendingOperation[]
          | null;
        if (!Array.isArray(parsed)) continue;
        for (const candidate of parsed) {
          if (
            !candidate ||
            typeof candidate.mutationId !== "string" ||
            typeof candidate.createdAt !== "number"
          ) {
            continue;
          }
          try {
            const operation = createWebLibraryOperation({
              ...candidate,
              actorId: candidate.dot.actorId,
              counter: candidate.dot.counter,
            }) as WebLibraryOperation;
            if (!operation.dot.actorId.startsWith(`${deviceId}.`)) continue;
            entries.push({
              ...operation,
              mutationId: candidate.mutationId,
              createdAt: candidate.createdAt,
            });
          } catch {
            // Ignore malformed same-origin storage instead of publishing it.
          }
        }
      } catch {
        // Ignore a damaged outbox; the browser payload and snapshots remain.
      }
    }
    return entries.sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.mutationId.localeCompare(right.mutationId),
    );
  }, []);

  const queueWebLibraryMutations = useCallback(
    (
      previous: WebSharedLibraryPayload | null,
      next: WebSharedLibraryPayload,
    ) => {
      const deviceId = webLibraryDeviceIdRef.current;
      const actorId = webLibraryActorIdRef.current;
      if (!deviceId || !actorId) {
        throw new Error("The browser sync identity is not ready");
      }
      const existing = readWebLibraryOutbox();
      const mutations = diffWebLibraryPayload(previous, next) as Array<{
        collection: WebLibraryCollection;
        itemId: string;
        tombstone: boolean;
        value?: Template | Quicktext | VocabularyItem;
      }>;
      const queued: WebLibraryPendingOperation[] = [];
      for (const mutation of mutations) {
        const groupKey = `${mutation.collection}\u0000${mutation.itemId}`;
        const priorPending = [...existing, ...queued].filter(
          (operation) =>
            operation.collection === mutation.collection &&
            operation.itemId === mutation.itemId,
        );
        const context = webLibraryContextFromOperations([
          ...(webLibraryHeadsRef.current.get(groupKey) || []),
          ...priorPending,
        ]) as Record<string, number>;
        webLibraryActorCounterRef.current += 1;
        const operation = createWebLibraryOperation({
          ...mutation,
          actorId,
          counter: webLibraryActorCounterRef.current,
          context,
        }) as WebLibraryOperation;
        queued.push({
          ...operation,
          mutationId: `${actorId}:${operation.dot.counter}:${randomHex(4)}`,
          createdAt: currentTimestamp(),
        });
      }
      if (queued.length > 0) {
        const immutableBatchKey = `${webLibraryOutboxPrefix}${deviceId}:${actorId}:${currentTimestamp()}:${randomHex(8)}`;
        window.localStorage.setItem(
          immutableBatchKey,
          JSON.stringify(queued),
        );
      }
      return queued;
    },
    [readWebLibraryOutbox],
  );

  const clearWebLibraryOutboxEntries = useCallback(
    (processedIds: Set<string>) => {
      const deviceId = webLibraryDeviceIdRef.current;
      const prefix = `${webLibraryOutboxPrefix}${deviceId}:`;
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) {
        try {
          const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as
            | WebLibraryPendingOperation[]
            | null;
          if (!Array.isArray(parsed)) continue;
          const remaining = parsed.filter(
            (entry) => !processedIds.has(entry.mutationId),
          );
          if (remaining.length === parsed.length) {
            continue;
          }
          if (remaining.length > 0) {
            window.localStorage.setItem(key, JSON.stringify(remaining));
          } else {
            window.localStorage.removeItem(key);
          }
        } catch {
          // Leave malformed data in place for manual recovery/export.
        }
      }
    },
    [],
  );

  const fetchWebLibraryDeviceRecords = useCallback(async () => {
    const listResponse = await fetch(
      `${webSharedLibraryListUrl()}?refresh=${currentTimestamp()}`,
      { cache: "no-store" },
    );
    if (!listResponse.ok) {
      throw new Error("The shared-library device list is unavailable");
    }
    const listed = (await listResponse.json()) as {
      entries?: Array<{ path?: unknown; public_read?: unknown }>;
    };
    const paths = (listed.entries || [])
      .filter(
        (entry) =>
          entry.public_read === 1 || entry.public_read === true,
      )
      .map((entry) => String(entry.path || ""))
      .filter((path) => /^library-device-v2-[a-f0-9]{32}$/.test(path));
    if (paths.length > 98) {
      throw new Error("The shared library has too many browser records");
    }
    const records = await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(
          `https://mantledb.sh/v2/${webSharedLibraryNamespace}/${path}?refresh=${currentTimestamp()}`,
          { cache: "no-store" },
        );
        if (!response.ok) return null;
        const record = parseWebLibraryDeviceRecordForApp(await response.text());
        return record && path === webSharedLibraryDevicePath(record.deviceId)
          ? record
          : null;
      }),
    );
    return records.filter(
      (record): record is WebLibraryDeviceRecord => Boolean(record),
    );
  }, []);

  const fetchWebSharedCanonical = useCallback(async () => {
    const response = await fetch(
      `${webSharedLibraryUrl()}?refresh=${currentTimestamp()}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const payload = parseWebSharedLibraryPayload(await response.text());
    if (!payload) return null;
    return {
      payload,
      fingerprint: await fingerprintWebLibrary(payload),
    };
  }, []);

  const withWebLibraryWriteLock = useCallback(
    async <T,>(callback: () => Promise<T>) => {
      const lockManager = (
        navigator as Navigator & {
          locks?: {
            request: <R>(name: string, callback: () => Promise<R>) => Promise<R>;
          };
        }
      ).locks;
      if (!lockManager) {
        const error = new Error(
          "This browser cannot safely coordinate library edits across tabs",
        ) as Error & { code?: string };
        error.code = "web-locks-unavailable";
        throw error;
      }
      return lockManager.request(
        `scribeflow-library-v2-${webLibraryDeviceIdRef.current}`,
        callback,
      );
    },
    [],
  );

  useEffect(() => {
    saveWebSharedLibraryRef.current = saveWebSharedLibrary;
  });

  useEffect(() => {
    if (!webEdition) return;
    const storedDeviceId = window.localStorage
      .getItem(storageKeys.webLibraryDeviceId)
      ?.trim();
    const deviceId = /^[a-f0-9]{32}$/.test(storedDeviceId || "")
      ? (storedDeviceId as string)
      : randomHex(16);
    window.localStorage.setItem(storageKeys.webLibraryDeviceId, deviceId);
    webLibraryDeviceIdRef.current = deviceId;
    webLibraryActorIdRef.current = `${deviceId}.${randomHex(8)}`;
    webLibraryActorCounterRef.current = 0;
    const storedDeviceRecord = parseWebLibraryDeviceRecordForApp(
      window.localStorage.getItem(storageKeys.webLibraryDeviceRecord),
    );
    if (storedDeviceRecord?.deviceId === deviceId) {
      webLibraryDeviceRecordRef.current = storedDeviceRecord;
      const cachedMaterialized = materializeWebLibraryDeviceRecords([
        storedDeviceRecord,
      ]) as {
        heads: Map<string, WebLibraryOperation[]>;
        conflicts: WebLibraryConflict[];
      };
      webLibraryHeadsRef.current = cachedMaterialized.heads;
      webLibraryConflictsRef.current = cachedMaterialized.conflicts;
    } else {
      window.localStorage.removeItem(storageKeys.webLibraryDeviceRecord);
    }
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const fragmentKey =
      fragment.get("mantle-key") ||
      fragment.get("mantleKey") ||
      fragment.get("owner-key") ||
      fragment.get("ownerKey") ||
      fragment.get("key");
    const storedKey = window.localStorage.getItem(
      storageKeys.webLibraryOwnerKey,
    );
    const ownerKey = fragmentKey?.trim() || storedKey?.trim() || "";
    if (ownerKey) {
      window.localStorage.setItem(storageKeys.webLibraryOwnerKey, ownerKey);
      webLibraryOwnerKeyRef.current = ownerKey;
    }
    if (fragmentKey) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    const dirty =
      window.localStorage.getItem(storageKeys.webLibraryDirty) === "true";
    webSharedLibraryDirtyRef.current = dirty;
    webSharedLibraryBaseRef.current = parseWebSharedLibraryPayload(
      window.localStorage.getItem(storageKeys.webLibraryBase),
    );
    const snapshots = parseWebLibrarySnapshots(
      window.localStorage.getItem(storageKeys.webLibrarySnapshots),
    );
    const timer = window.setTimeout(() => {
      if (ownerKey) setWebLibraryOwnerKey(ownerKey);
      setWebLibraryDirty(dirty);
      setWebLibrarySnapshots(snapshots);
      if (fragmentKey) setToast("Owner access saved on this browser");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!showTemplateForm) return;
    const editor = templateEditorRef.current;
    if (!editor) return;

    editor.innerHTML = sanitizeTemplateHtml(
      editingTemplate?.contentHtml ||
        plainTextToHtml(editingTemplate?.content ?? ""),
    );
    templateSelectionRef.current = null;
  }, [editingTemplate, showTemplateForm]);

  const syncEditorState = useCallback(() => {
    const editor = noteRef.current;
    if (!editor) return;
    setNote(editor.innerText.replace(/\u00a0/g, " "));
    setNoteHtml(sanitizeTemplateHtml(editor.innerHTML));
    setNoteCopied(false);
  }, []);

  const rememberSelection = useCallback(() => {
    const editor = noteRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      lastSelectionRef.current = range.cloneRange();
    }
  }, []);

  const getCaretToken = useCallback(() => {
    const editor = noteRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return "";
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) || !range.collapsed) {
      return "";
    }
    if (selection.focusNode?.nodeType !== Node.TEXT_NODE) return "";
    const beforeCaret =
      selection.focusNode.textContent?.slice(0, selection.focusOffset) ?? "";
    return beforeCaret.match(/\.[a-zA-Z]*$/)?.[0] ?? "";
  }, []);

  const shouldCapitalizeDictationStart = useCallback(() => {
    const editor = noteRef.current;
    if (!editor) return true;
    const selection = window.getSelection();
    const selectedRange =
      selection &&
      selection.rangeCount > 0 &&
      editor.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0)
        : lastSelectionRef.current &&
            editor.contains(lastSelectionRef.current.commonAncestorContainer)
          ? lastSelectionRef.current
          : null;

    let precedingText = editor.innerText.replace(/\u00a0/g, " ");
    if (selectedRange) {
      try {
        const precedingRange = document.createRange();
        precedingRange.selectNodeContents(editor);
        precedingRange.setEnd(
          selectedRange.startContainer,
          selectedRange.startOffset,
        );
        precedingText = precedingRange.toString().replace(/\u00a0/g, " ");
      } catch {
        // Fall back to the full note when a previously saved range is stale.
      }
    }

    return (
      /^\s*$/.test(precedingText) ||
      /[.!?]\s*$/.test(precedingText) ||
      /\n+\s*$/.test(precedingText)
    );
  }, []);

  const updateEditorSelectionState = useCallback(() => {
    rememberSelection();
    const editor = noteRef.current;
    const selection = window.getSelection();
    const selectedRange =
      editor && selection && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;

    if (
      editor &&
      selectedRange &&
      !selectedRange.collapsed &&
      editor.contains(selectedRange.commonAncestorContainer)
    ) {
      setCurrentToken((value) => (value ? "" : value));
      return;
    }

    const nextToken = getCaretToken();
    setCurrentToken((value) => (value === nextToken ? value : nextToken));
    try {
      const nextFormats = {
        bold: document.queryCommandState("bold"),
        underline: document.queryCommandState("underline"),
      };
      setActiveFormats((value) => {
        if (
          value.bold === nextFormats.bold &&
          value.underline === nextFormats.underline
        ) {
          return value;
        }
        return nextFormats;
      });
    } catch {
      setActiveFormats((value) =>
        value.bold || value.underline
          ? { bold: false, underline: false }
          : value,
      );
    }
  }, [getCaretToken, rememberSelection]);

  const insertEditorText = useCallback(
    (content: string, replaceToken = false) => {
      const editor = noteRef.current;
      if (!editor) return;

      const selection = window.getSelection();
      if (!selection) return;

      let range: Range;
      if (
        selection.rangeCount > 0 &&
        editor.contains(selection.getRangeAt(0).commonAncestorContainer)
      ) {
        range = selection.getRangeAt(0);
      } else if (
        lastSelectionRef.current &&
        editor.contains(lastSelectionRef.current.commonAncestorContainer)
      ) {
        range = lastSelectionRef.current.cloneRange();
      } else {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }

      selection.removeAllRanges();
      selection.addRange(range);
      editor.focus();

      const token = replaceToken ? getCaretToken() : "";
      if (
        token &&
        selection.focusNode?.nodeType === Node.TEXT_NODE &&
        selection.focusOffset >= token.length
      ) {
        range.setStart(selection.focusNode, selection.focusOffset - token.length);
      }

      range.deleteContents();
      const fragment = document.createDocumentFragment();
      const lines = content.split("\n");
      let finalNode: Node | null = null;
      lines.forEach((line, index) => {
        if (index > 0) {
          finalNode = document.createElement("br");
          fragment.appendChild(finalNode);
        }
        if (line) {
          finalNode = document.createTextNode(line);
          fragment.appendChild(finalNode);
        }
      });

      if (!finalNode) {
        finalNode = document.createTextNode("");
        fragment.appendChild(finalNode);
      }

      range.insertNode(fragment);
      range.setStartAfter(finalNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      lastSelectionRef.current = range.cloneRange();
      syncEditorState();
      setCurrentToken("");
    },
    [getCaretToken, syncEditorState],
  );

  const setEditorText = useCallback((content: string, contentHtml?: string) => {
    const html = sanitizeTemplateHtml(contentHtml || plainTextToHtml(content));
    setNote(content);
    setNoteHtml(html);
    setNoteCopied(!content.trim());
    if (noteRef.current) noteRef.current.innerHTML = html;
    lastSelectionRef.current = null;
    setCurrentToken("");
  }, []);

  const populateMeasurementTokensInNote = useCallback(
    (measurements: PdfMeasurements) => {
      const editor = noteRef.current;
      if (!editor) return false;
      const nextHtml = sanitizeTemplateHtml(
        resolveMeasurementTokens(editor.innerHTML, measurements, true),
      );
      if (nextHtml === editor.innerHTML) return false;
      editor.innerHTML = nextHtml;
      lastSelectionRef.current = null;
      syncEditorState();
      return true;
    },
    [syncEditorState],
  );

  function closeHstPaste() {
    setHstPasteText("");
    setShowHstPaste(false);
  }

  function importHstResults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const intakeName = pdfMeasurements?.name?.trim();
    if (!intakeName) {
      setHstStatus("Import the current intake PDF before adding HST results");
      setToast("HST not imported — current intake name is required");
      return;
    }

    const hstName = extractHstPatientName(hstPasteText);
    if (!hstName) {
      setHstStatus("No patient name was found in the pasted HST results");
      setToast("HST not imported — patient name could not be verified");
      return;
    }

    if (!patientNamesMatch(intakeName, hstName)) {
      setHstStatus("HST patient name does not match the current intake form");
      setToast("Patient name mismatch — HST was not imported");
      return;
    }

    const summary = extractHstSummary(hstPasteText);
    if (!summary) {
      setHstStatus("No supported HST metrics were found");
      setToast("No supported HST results found");
      return;
    }

    const measurements: PdfMeasurements = { hst: summary };
    setPdfMeasurements((current) => ({
      ...(current || {}),
      ...measurements,
    }));
    const populated = populateMeasurementTokensInNote(measurements);
    setHstStatus(
      populated
        ? "HST summary filled into .hst in the note"
        : "HST summary ready for .hst",
    );
    setToast("HST summary is ready");
    closeHstPaste();
  }

  async function processPdfFile(
    file: File,
    input: HTMLInputElement | null,
    fileHandle: LocalPdfFileHandle | null,
    deleteOriginalAfterScan: boolean,
    importKind: "intake" | "cpap" = "intake",
  ) {
    const isPapImport = importKind === "cpap";
    const updateImportStatus = isPapImport ? setPapPdfStatus : setPdfStatus;
    const clearInput = () => {
      if (input) input.value = "";
    };

    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      clearInput();
      setToast("Choose a PDF file");
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      clearInput();
      setToast("PDF must be smaller than 25 MB");
      return;
    }

    setIsScanningPdf(true);
    updateImportStatus(
      isPapImport
        ? "Reading PAP compliance PDF locally..."
        : "Reading PDF locally...",
    );

    let pdfBytes: Uint8Array<ArrayBuffer> | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDocument: PDFDocumentProxy | null = null;
    let scanSucceeded = false;
    let successfulStatus = "";
    let pdfSha256 = "";

    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
      if (deleteOriginalAfterScan) {
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", pdfBytes),
        );
        pdfSha256 = Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        digest.fill(0);
      }
      clearInput();

      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = pdfjs.getDocument(
        {
          data: pdfBytes,
          isEvalSupported: false,
          enableScripting: false,
        } as Parameters<typeof pdfjs.getDocument>[0],
      );
      pdfDocument = await loadingTask.promise;

      const pageText: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const textContent = await page.getTextContent();
        pageText.push(
          textContent.items
            .map((item) =>
              "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
            )
            .join(""),
        );
        page.cleanup();
      }

      const extractedText = pageText.join(" ");
      const measurements: PdfMeasurements = isPapImport
        ? { cpap: extractCpapSummary(extractedText) }
        : extractPdfMeasurements(extractedText);
      pageText.fill("");
      const foundFields = Object.entries(measurements).filter(
        ([, value]) => Boolean(value),
      );

      if (foundFields.length === 0) {
        updateImportStatus(
          isPapImport
            ? "No PAP compliance data was found. Image-only reports will need OCR."
            : "No supported fields were found. Image-only PDFs will need OCR.",
        );
        setToast(
          isPapImport
            ? "No PAP compliance data found in this PDF"
            : "No supported fields found in this PDF",
        );
        return;
      }

      setPdfMeasurements((current) => ({
        ...(current || {}),
        ...measurements,
      }));
      const measurementLines = [
        measurements.name ? `Name: ${measurements.name}` : null,
        measurements.age ? `Age: ${measurements.age}` : null,
        measurements.gender ? `Gender: ${measurements.gender}` : null,
        measurements.height ? `Height: ${measurements.height}` : null,
        measurements.weight ? `Weight: ${measurements.weight}` : null,
        measurements.bmi ? `BMI: ${measurements.bmi}` : null,
      ].filter((line): line is string => Boolean(line));
      const populatedTemplateFields =
        populateMeasurementTokensInNote(measurements);
      if (
        !isPapImport &&
        !populatedTemplateFields &&
        measurementLines.length > 0
      ) {
        const hasExistingNote = Boolean(noteRef.current?.innerText.trim());
        insertEditorText(
          `${hasExistingNote ? "\n\n" : ""}MEASUREMENTS FROM PDF\n${measurementLines.join("\n")}`,
        );
      }
      successfulStatus = isPapImport
        ? populatedTemplateFields
          ? "PAP compliance summary filled into .cpap in the note"
          : "PAP compliance summary ready for .cpap"
        : `${foundFields.length} PDF field${
            foundFields.length === 1 ? "" : "s"
          } found and ${
            populatedTemplateFields
              ? "filled into the note"
              : measurementLines.length > 0
                ? "measurements added to the note"
                : "ready for dot phrases"
          }`;
      scanSucceeded = true;
      updateImportStatus(successfulStatus);
      setToast(
        isPapImport ? "PAP compliance summary is ready" : "PDF fields are ready",
      );
    } catch {
      updateImportStatus(
        isPapImport
          ? "This PAP report could not be read. The file was not retained."
          : "This PDF could not be read. The file was not retained.",
      );
      setToast("Unable to read this PDF");
    } finally {
      const documentToClean = pdfDocument;
      const taskToDestroy = loadingTask;
      const bytesToClear = pdfBytes;
      clearInput();
      pdfBytes = null;
      pdfDocument = null;
      loadingTask = null;
      try {
        bytesToClear?.fill(0);
      } catch {
        // PDF.js may transfer and detach this buffer while parsing. A detached
        // buffer is already inaccessible, so there is nothing left to clear.
      }
      await Promise.allSettled([
        Promise.resolve().then(() => documentToClean?.cleanup()),
        Promise.resolve().then(() => taskToDestroy?.destroy()),
      ]);
      const removeOriginal = fileHandle?.remove?.bind(fileHandle);

      if (scanSucceeded && deleteOriginalAfterScan) {
        let originalDeleted = false;
        if (removeOriginal) {
          try {
            await removeOriginal();
            originalDeleted = true;
          } catch {
            // The local Downloads verifier below is the fallback when the
            // browser cannot remove the selected handle itself.
          }
        }

        if (!originalDeleted && pdfSha256) {
          try {
            const response = await fetch(
              "http://127.0.0.1:3001/files/delete-uploaded-pdf",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: file.name,
                  size: file.size,
                  sha256: pdfSha256,
                }),
              },
            );
            originalDeleted = response.ok;
          } catch {
            originalDeleted = false;
          }
        }

        if (originalDeleted) {
          updateImportStatus(
            `${successfulStatus}. Original PDF permanently deleted.`,
          );
          setToast(
            isPapImport
              ? "PAP summary is ready; original PDF deleted"
              : "PDF fields are ready; original PDF deleted",
          );
        } else {
          updateImportStatus(
            `${successfulStatus}. Original PDF could not be deleted.`,
          );
          setToast(
            isPapImport
              ? "PAP summary is ready, but the original PDF could not be deleted"
              : "Fields imported, but the original PDF could not be deleted",
          );
        }
      }
      pdfSha256 = "";
      setIsScanningPdf(false);
    }
  }

  async function choosePdf(importKind: "intake" | "cpap" = "intake") {
    const deleteAfterScan = deletePdfAfterScan;
    const picker = (window as PdfPickerWindow).showOpenFilePicker;
    if (!picker) {
      if (importKind === "cpap") {
        papPdfInputRef.current?.click();
      } else {
        pdfInputRef.current?.click();
      }
      return;
    }

    try {
      const [fileHandle] = await picker({
        multiple: false,
        types: [
          {
            description: "PDF documents",
            accept: { "application/pdf": [".pdf"] },
          },
        ],
      });
      if (!fileHandle) return;

      let removableFileHandle: LocalPdfFileHandle | null = null;
      if (deleteAfterScan) {
        if (typeof fileHandle.remove === "function") {
          if (typeof fileHandle.requestPermission === "function") {
            const permission = await fileHandle.requestPermission({
              mode: "readwrite",
            });
            if (permission === "granted") {
              removableFileHandle = fileHandle;
            }
          } else {
            removableFileHandle = fileHandle;
          }
        }
      }

      const file = await fileHandle.getFile();
      await processPdfFile(
        file,
        null,
        removableFileHandle,
        deleteAfterScan,
        importKind,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setToast(
        importKind === "cpap"
          ? "The PAP PDF picker could not be opened"
          : "The PDF picker could not be opened",
      );
    }
  }

  async function handlePdfUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    await processPdfFile(file, input, null, deletePdfAfterScan);
  }

  async function handlePapPdfUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    await processPdfFile(file, input, null, deletePdfAfterScan, "cpap");
  }

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(
        (device) => device.kind === "audioinput",
      );
      setMicrophones(
        audioInputs.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        })),
      );
      setSelectedMicrophoneId((current) => {
        if (
          current === "default" ||
          audioInputs.some((device) => device.deviceId === current)
        ) {
          return current;
        }
        window.localStorage.setItem(storageKeys.microphoneId, "default");
        return "default";
      });
    } catch {
      setMicrophones([]);
    }
  }, []);

  const releaseMicrophoneTest = useCallback(() => {
    if (microphoneTestAnimationRef.current !== null) {
      window.cancelAnimationFrame(microphoneTestAnimationRef.current);
      microphoneTestAnimationRef.current = null;
    }
    if (microphoneTestTimerRef.current !== null) {
      window.clearTimeout(microphoneTestTimerRef.current);
      microphoneTestTimerRef.current = null;
    }
    microphoneTestSourceRef.current?.disconnect();
    microphoneTestSourceRef.current = null;
    microphoneTestStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());
    microphoneTestStreamRef.current = null;
    void microphoneTestContextRef.current?.close();
    microphoneTestContextRef.current = null;
  }, []);

  const stopMicrophoneTest = useCallback(
    (showResult = true) => {
      const heardSpeech = microphoneTestPeakRef.current >= 8;
      microphoneTestSessionRef.current += 1;
      releaseMicrophoneTest();
      setMicrophoneLevel(0);
      if (!showResult) {
        setMicrophoneTestState("idle");
        setMicrophoneTestMessage("Test your microphone before dictating");
        return;
      }
      setMicrophoneTestState(heardSpeech ? "heard" : "quiet");
      setMicrophoneTestMessage(
        heardSpeech
          ? "Microphone is working"
          : "No clear sound detected — check the selected microphone",
      );
    },
    [releaseMicrophoneTest],
  );

  const startMicrophoneTest = useCallback(async () => {
    if (isRecording) {
      setToast("Stop dictation before testing the microphone");
      return;
    }
    releaseMicrophoneTest();
    const testSession = ++microphoneTestSessionRef.current;
    microphoneTestPeakRef.current = 0;
    setMicrophoneLevel(0);
    setMicrophoneTestState("testing");
    setMicrophoneTestMessage("Speak normally for a few seconds");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId:
            selectedMicrophoneId === "default"
              ? undefined
              : { exact: selectedMicrophoneId },
        },
        video: false,
      });
      if (testSession !== microphoneTestSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await refreshMicrophones();
      const audioContext = new AudioContext();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      microphoneTestStreamRef.current = stream;
      microphoneTestContextRef.current = audioContext;
      microphoneTestSourceRef.current = source;
      const levels = new Uint8Array(analyser.fftSize);
      const updateLevel = () => {
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        levels.forEach((sample) => {
          const centered = (sample - 128) / 128;
          energy += centered * centered;
        });
        const rms = Math.sqrt(energy / levels.length);
        const level = Math.min(100, Math.round(rms * 360));
        microphoneTestPeakRef.current = Math.max(
          microphoneTestPeakRef.current,
          level,
        );
        setMicrophoneLevel(level);
        microphoneTestAnimationRef.current =
          window.requestAnimationFrame(updateLevel);
      };
      updateLevel();
      microphoneTestTimerRef.current = window.setTimeout(
        () => stopMicrophoneTest(true),
        8000,
      );
    } catch (error) {
      if (testSession !== microphoneTestSessionRef.current) return;
      releaseMicrophoneTest();
      setMicrophoneLevel(0);
      setMicrophoneTestState("failed");
      setMicrophoneTestMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Allow microphone access, then test again"
          : "Microphone test could not start",
      );
    }
  }, [
    isRecording,
    refreshMicrophones,
    releaseMicrophoneTest,
    selectedMicrophoneId,
    stopMicrophoneTest,
  ]);

  useEffect(
    () => () => {
      microphoneTestSessionRef.current += 1;
      releaseMicrophoneTest();
    },
    [releaseMicrophoneTest],
  );

  const persistTemplatesToDisk = useCallback(
    async (payload: TemplateVaultPayload) => {
      if (webEdition) {
        return {
          payload,
          conflictCount: 0,
          conflictFile: null,
          message: "Templates saved in this browser.",
        } satisfies VaultWriteResponse<TemplateVaultPayload>;
      }
      const response = await fetch(
        "http://127.0.0.1:3001/config/templates",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payload,
            base: templateBaseRef.current,
          }),
        },
      );
      if (!response.ok) {
        throw new Error("The durable template backup could not be updated");
      }
      return (await response.json()) as VaultWriteResponse<TemplateVaultPayload>;
    },
    [],
  );

  const persistWritingToolsToDisk = useCallback(
    async (payload: WritingToolsVaultPayload) => {
      if (webEdition) {
        return {
          payload,
          conflictCount: 0,
          conflictFile: null,
          message: "Writing tools saved in this browser.",
        } satisfies VaultWriteResponse<WritingToolsVaultPayload>;
      }
      const response = await fetch(
        "http://127.0.0.1:3001/config/writing-tools",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payload,
            base: writingToolsBaseRef.current,
          }),
        },
      );
      if (!response.ok) {
        throw new Error("The shared writing-tools copy could not be updated");
      }
      return (await response.json()) as VaultWriteResponse<WritingToolsVaultPayload>;
    },
    [],
  );

  useEffect(() => {
    legacyPatientDataStorageKeys.forEach((key) =>
      window.localStorage.removeItem(key),
    );
    const storedQuicktexts = window.localStorage.getItem(storageKeys.quicktexts);
    const storedTemplates = window.localStorage.getItem(storageKeys.templates);
    const storedTemplateBackup = window.localStorage.getItem(
      storageKeys.templatesBackup,
    );
    const storedTemplatesUpdatedAt = Number(
      window.localStorage.getItem(storageKeys.templatesUpdatedAt) || 0,
    );
    const storedVocabulary = window.localStorage.getItem(storageKeys.vocabulary);
    const storedWritingToolsUpdatedAt = Number(
      window.localStorage.getItem(storageKeys.writingToolsUpdatedAt) || 0,
    );
    const storedDictationEngine = window.localStorage.getItem(
      storageKeys.dictationEngine,
    );
    const storedMicrophoneId = window.localStorage.getItem(
      storageKeys.microphoneId,
    );
    const storedDockCollapsed = window.localStorage.getItem(
      storageKeys.dictationDockCollapsed,
    );
    const storedDockPosition = parseDockPosition(
      window.localStorage.getItem(storageKeys.dictationDockPosition),
    );
    const browserTemplates =
      parseStoredTemplates(storedTemplates) ||
      parseStoredTemplates(storedTemplateBackup);
    void (async () => {
      let diskPayload: TemplateVaultPayload | null = null;
      if (!webEdition) {
        try {
          const response = await fetch(
            "http://127.0.0.1:3001/config/templates",
            { cache: "no-store" },
          );
          if (response.ok) {
            diskPayload = parseTemplateVaultPayload(await response.text());
          }
        } catch {
          diskPayload = null;
        }
      }
      templateBaseRef.current = diskPayload;

      const browserPayload: TemplateVaultPayload | null = browserTemplates
        ? {
            version: 1,
            updatedAt:
              storedTemplatesUpdatedAt > 0
                ? storedTemplatesUpdatedAt
                : webEdition
                  ? 0
                  : currentTimestamp(),
            templates: browserTemplates,
          }
        : null;
      const selectedPayload =
        diskPayload && browserPayload
          ? diskPayload.updatedAt >= browserPayload.updatedAt
            ? diskPayload
            : browserPayload
          : diskPayload ||
            browserPayload || {
              version: 1 as const,
              updatedAt: webEdition ? 0 : currentTimestamp(),
              templates: starterTemplates,
            };

      setTemplates(selectedPayload.templates);
      setTemplatesReady(true);
      templatesUpdatedAtRef.current = selectedPayload.updatedAt;
      const serializedTemplates = JSON.stringify(selectedPayload.templates);
      window.localStorage.setItem(storageKeys.templates, serializedTemplates);
      window.localStorage.setItem(
        storageKeys.templatesBackup,
        serializedTemplates,
      );
      window.localStorage.setItem(
        storageKeys.templatesUpdatedAt,
        String(selectedPayload.updatedAt),
      );

      const diskMatches =
        diskPayload &&
        diskPayload.updatedAt === selectedPayload.updatedAt &&
        JSON.stringify(diskPayload.templates) === serializedTemplates;
      if (webEdition) {
        templateBaseRef.current = selectedPayload;
        setTemplateStorageStatus("Checking shared library");
      } else if (diskMatches) {
        templateBaseRef.current = selectedPayload;
        setTemplateStorageStatus("Saved in OneDrive folder");
      } else {
        try {
          const result = await persistTemplatesToDisk(selectedPayload);
          templateBaseRef.current = result.payload;
          templatesUpdatedAtRef.current = result.payload.updatedAt;
          const reconciledTemplates = JSON.stringify(result.payload.templates);
          setTemplates(result.payload.templates);
          window.localStorage.setItem(
            storageKeys.templates,
            reconciledTemplates,
          );
          window.localStorage.setItem(
            storageKeys.templatesBackup,
            reconciledTemplates,
          );
          window.localStorage.setItem(
            storageKeys.templatesUpdatedAt,
            String(result.payload.updatedAt),
          );
          setTemplateStorageStatus(
            result.conflictCount > 0
              ? "Merged safely; conflicts preserved"
              : "Saved in OneDrive folder",
          );
          if (result.conflictCount > 0) {
            setSyncConflictNotice(result.message);
          }
        } catch {
          setTemplateStorageStatus("Browser backup only");
        }
      }
    })();
    const browserQuicktexts = parseStoredQuicktexts(storedQuicktexts);
    const browserVocabulary = parseStoredVocabulary(storedVocabulary);
    void (async () => {
      let diskPayload: WritingToolsVaultPayload | null = null;
      if (!webEdition) {
        try {
          const response = await fetch(
            "http://127.0.0.1:3001/config/writing-tools",
            { cache: "no-store" },
          );
          if (response.ok) {
            diskPayload = parseWritingToolsVaultPayload(await response.text());
          }
        } catch {
          diskPayload = null;
        }
      }
      writingToolsBaseRef.current = diskPayload;

      const hasBrowserWritingTools =
        browserQuicktexts !== null || browserVocabulary !== null;
      const browserPayload: WritingToolsVaultPayload | null =
        hasBrowserWritingTools
          ? {
              version: 1,
              updatedAt:
                storedWritingToolsUpdatedAt > 0
                  ? storedWritingToolsUpdatedAt
                  : 0,
              quicktexts: browserQuicktexts ?? starterQuicktexts,
              vocabulary: browserVocabulary ?? [],
            }
          : null;

      let selectedPayload: WritingToolsVaultPayload;
      if (diskPayload && browserPayload) {
        selectedPayload =
          browserPayload.updatedAt === 0
            ? mergeWritingToolsForMigration(diskPayload, browserPayload)
            : diskPayload.updatedAt >= browserPayload.updatedAt
              ? diskPayload
              : browserPayload;
      } else {
        selectedPayload =
          diskPayload ||
          (browserPayload
            ? {
                ...browserPayload,
                updatedAt:
                  browserPayload.updatedAt > 0
                    ? browserPayload.updatedAt
                    : currentTimestamp(),
              }
            : {
                version: 1,
                updatedAt: webEdition ? 0 : currentTimestamp(),
                quicktexts: starterQuicktexts,
                vocabulary: [],
              });
      }

      setQuicktexts(selectedPayload.quicktexts);
      setVocabulary(selectedPayload.vocabulary);
      setWritingToolsReady(true);
      writingToolsUpdatedAtRef.current = selectedPayload.updatedAt;
      const serializedQuicktexts = JSON.stringify(selectedPayload.quicktexts);
      const serializedVocabulary = JSON.stringify(selectedPayload.vocabulary);
      window.localStorage.setItem(storageKeys.quicktexts, serializedQuicktexts);
      window.localStorage.setItem(storageKeys.vocabulary, serializedVocabulary);
      window.localStorage.setItem(
        storageKeys.writingToolsUpdatedAt,
        String(selectedPayload.updatedAt),
      );

      const diskMatches =
        diskPayload &&
        diskPayload.updatedAt === selectedPayload.updatedAt &&
        JSON.stringify(diskPayload.quicktexts) === serializedQuicktexts &&
        JSON.stringify(diskPayload.vocabulary) === serializedVocabulary;
      if (webEdition) {
        writingToolsBaseRef.current = selectedPayload;
        setWritingToolsStorageStatus("Checking shared library");
      } else if (diskMatches) {
        writingToolsBaseRef.current = selectedPayload;
        setWritingToolsStorageStatus("Saved in OneDrive folder");
      } else {
        try {
          const result = await persistWritingToolsToDisk(selectedPayload);
          writingToolsBaseRef.current = result.payload;
          writingToolsUpdatedAtRef.current = result.payload.updatedAt;
          setQuicktexts(result.payload.quicktexts);
          setVocabulary(result.payload.vocabulary);
          window.localStorage.setItem(
            storageKeys.quicktexts,
            JSON.stringify(result.payload.quicktexts),
          );
          window.localStorage.setItem(
            storageKeys.vocabulary,
            JSON.stringify(result.payload.vocabulary),
          );
          window.localStorage.setItem(
            storageKeys.writingToolsUpdatedAt,
            String(result.payload.updatedAt),
          );
          setWritingToolsStorageStatus(
            result.conflictCount > 0
              ? "Merged safely; conflicts preserved"
              : "Saved in OneDrive folder",
          );
          if (result.conflictCount > 0) {
            setSyncConflictNotice(result.message);
          }
        } catch {
          setWritingToolsStorageStatus("Browser backup only");
        }
      }
    })();
    const nativeStateTimer = webEdition
      ? null
      : window.setTimeout(() => {
          setSpeechSupported(
            Boolean(
              window.SpeechRecognition || window.webkitSpeechRecognition,
            ),
          );
          setWhisperSupported(
            Boolean(navigator.mediaDevices && "AudioContext" in window),
          );
          if (
            storedDictationEngine === "whisper" ||
            storedDictationEngine === "chrome"
          ) {
            setDictationEngine(storedDictationEngine);
          }
          if (storedMicrophoneId) {
            setSelectedMicrophoneId(storedMicrophoneId);
          }
          if (storedDockCollapsed === "false") {
            setDockCollapsed(false);
          }
          setDockPosition(storedDockPosition);
          void refreshMicrophones();
        }, 0);
    return () => {
      if (nativeStateTimer !== null) window.clearTimeout(nativeStateTimer);
    };
  }, [persistTemplatesToDisk, persistWritingToolsToDisk, refreshMicrophones]);

  useEffect(() => {
    if (!templatesReady || !writingToolsReady) return;
    if (webEdition) {
      let cancelled = false;
      let lastAutomaticRefreshAt = 0;
      if (!webSharedLibraryLocalRef.current) {
        webSharedLibraryLocalRef.current = {
          version: 1,
          updatedAt: Math.max(
            Number(
              window.localStorage.getItem(storageKeys.templatesUpdatedAt) || 0,
            ),
            Number(
              window.localStorage.getItem(storageKeys.writingToolsUpdatedAt) ||
                0,
            ),
          ),
          templates:
            parseStoredTemplates(
              window.localStorage.getItem(storageKeys.templates),
            ) || starterTemplates,
          quicktexts:
            parseStoredQuicktexts(
              window.localStorage.getItem(storageKeys.quicktexts),
            ) || starterQuicktexts,
          vocabulary:
            parseStoredVocabulary(
              window.localStorage.getItem(storageKeys.vocabulary),
            ) || [],
        };
      }
      const refreshWebSharedLibrary = async (showFeedback = false) => {
        if (webSharedLibrarySavingRef.current) return;
        const mutationEpoch = webSharedLibraryMutationEpochRef.current;
        if (
          !showFeedback &&
          currentTimestamp() - lastAutomaticRefreshAt < 60_000
        ) {
          return;
        }
        const refreshEpoch = ++webLibraryRefreshEpochRef.current;
        lastAutomaticRefreshAt = currentTimestamp();
        if (showFeedback) setSyncRefreshing(true);
        try {
          let deviceRecords: WebLibraryDeviceRecord[] | null = null;
          try {
            deviceRecords = await fetchWebLibraryDeviceRecords();
          } catch {
            deviceRecords = null;
          }
          let canonicalState: {
            payload: WebSharedLibraryPayload;
            fingerprint: string;
          } | null = null;
          try {
            canonicalState = await fetchWebSharedCanonical();
          } catch {
            canonicalState = null;
          }
          if (
            deviceRecords &&
            deviceRecords.length > 0 &&
            canonicalState &&
            !deviceRecords.some((record) =>
              record.canonicalFingerprints.includes(
                canonicalState.fingerprint,
              ),
            )
          ) {
            try {
              const markerRefresh = await fetchWebLibraryDeviceRecords();
              if (
                markerRefresh.some((record) =>
                  record.canonicalFingerprints.includes(
                    canonicalState.fingerprint,
                  ),
                )
              ) {
                deviceRecords = markerRefresh;
              }
            } catch {
              // Continue with the first consistent snapshot and import safely.
            }
          }

          if (deviceRecords && deviceRecords.length > 0) {
            const pending = readWebLibraryOutbox();
            if (
              webSharedLibraryDirtyRef.current &&
              pending.length === 0
            ) {
              const authoritative = materializeWebLibraryDeviceRecords(
                deviceRecords,
                currentTimestamp(),
              ) as { payload: WebSharedLibraryPayload };
              const localPayload = webSharedLibraryLocalRef.current;
              const intentBase = webSharedLibraryBaseRef.current || {
                version: 1 as const,
                updatedAt: 0,
                templates: [],
                quicktexts: [],
                vocabulary: [],
              };
              const localIntent = localPayload
                ? diffWebLibraryPayload(intentBase, localPayload)
                : [];
              if (
                !localPayload ||
                !payloadContainsWebLibraryMutations(
                  authoritative.payload,
                  localIntent,
                )
              ) {
                setTemplateStorageStatus("Browser changes waiting to sync");
                setWritingToolsStorageStatus("Browser changes waiting to sync");
                setWebSharedLibraryStatus(
                  "Browser changes preserved · retry sync",
                );
                if (showFeedback) {
                  setToast("Local changes are preserved and waiting to sync");
                }
                return;
              }
            }
            const deviceId = webLibraryDeviceIdRef.current;
            const remoteOwnRecord = deviceRecords.find(
              (record) => record.deviceId === deviceId,
            );
            let localRecord = remoteOwnRecord ||
              createEmptyWebLibraryDeviceRecord(
                deviceId,
                currentTimestamp(),
              ) as WebLibraryDeviceRecord;
            if (pending.length > 0 && webLibraryDeviceRecordRef.current) {
              localRecord = mergeWebLibraryDeviceRecords(
                [localRecord, webLibraryDeviceRecordRef.current],
                deviceId,
              ) as WebLibraryDeviceRecord;
            }
            if (pending.length > 0) {
              localRecord = applyWebLibraryOperations(
                localRecord,
                pending,
                currentTimestamp(),
              ) as WebLibraryDeviceRecord;
            }
            const recordsWithPending = [
              ...deviceRecords.filter((record) => record.deviceId !== deviceId),
              localRecord,
            ];
            const materialized = materializeWebLibraryDeviceRecords(
              recordsWithPending,
              currentTimestamp(),
            ) as {
              payload: WebSharedLibraryPayload;
              heads: Map<string, WebLibraryOperation[]>;
              conflicts: WebLibraryConflict[];
            };
            const remotePayload = parseWebSharedLibraryPayload(
              JSON.stringify(materialized.payload),
            );
            if (!remotePayload) {
              throw new Error("The online device library is invalid");
            }
            const canonicalWasAlreadyHandled = canonicalState
              ? deviceRecords.some((record) =>
                  record.canonicalFingerprints.includes(
                    canonicalState.fingerprint,
                  ),
                )
              : true;
            const needsLegacyImport = !canonicalWasAlreadyHandled;
            let displayedPayload = remotePayload;
            let legacyConflictCount = 0;
            if (canonicalState && needsLegacyImport) {
              const legacyMerge = mergeWebSharedLibrary({
                base: null,
                remote: remotePayload,
                local: canonicalState.payload,
                now: webLibraryConflictSeed(canonicalState.fingerprint),
              });
              const parsedLegacyMerge = parseWebSharedLibraryPayload(
                JSON.stringify(legacyMerge.payload),
              );
              if (!parsedLegacyMerge) {
                throw new Error("The older-tab library update is invalid");
              }
              displayedPayload = parsedLegacyMerge;
              legacyConflictCount = legacyMerge.conflicts.length;
            }
            if (
              cancelled ||
              webSharedLibrarySavingRef.current ||
              refreshEpoch !== webLibraryRefreshEpochRef.current ||
              mutationEpoch !== webSharedLibraryMutationEpochRef.current
            ) {
              return;
            }

            webLibraryDeviceRecordRef.current = localRecord;
            webLibraryHeadsRef.current = materialized.heads;
            webLibraryConflictsRef.current = materialized.conflicts;
            window.localStorage.setItem(
              storageKeys.webLibraryDeviceRecord,
              stableWebLibraryJson(localRecord),
            );
            const hasPending = pending.length > 0;
            const previousPayload = webSharedLibraryLocalRef.current;
            const contentsChanged =
              !previousPayload ||
              stableWebLibraryJson({
                  templates: previousPayload.templates,
                quicktexts: previousPayload.quicktexts,
                vocabulary: previousPayload.vocabulary,
              }) !==
                stableWebLibraryJson({
                  templates: displayedPayload.templates,
                  quicktexts: displayedPayload.quicktexts,
                  vocabulary: displayedPayload.vocabulary,
                });
            persistWebLibraryLocally(displayedPayload, {
              dirty: hasPending || needsLegacyImport,
              ...(hasPending ? {} : { base: remotePayload }),
              snapshotReason:
                contentsChanged && !hasPending && !needsLegacyImport
                  ? "Updated from online library"
                  : undefined,
            });
            const conflictCount =
              materialized.conflicts.length + legacyConflictCount;
            setSyncConflictNotice(
              conflictCount > 0
                ? `${conflictCount} competing edit${
                    conflictCount === 1 ? " was" : "s were"
                  } preserved as conflict copies.`
                : "",
            );
            setTemplateStorageStatus(
              needsLegacyImport
                ? webLibraryOwnerKeyRef.current
                  ? "Importing an update from an older tab"
                  : "Older-tab update waiting for owner access"
                : hasPending
                ? "Browser changes waiting to sync"
                : webLibraryOwnerKeyRef.current
                  ? "Saved everywhere"
                  : "View only",
            );
            setWritingToolsStorageStatus(
              needsLegacyImport
                ? webLibraryOwnerKeyRef.current
                  ? "Importing an update from an older tab"
                  : "Older-tab update waiting for owner access"
                : hasPending
                ? "Browser changes waiting to sync"
                : webLibraryOwnerKeyRef.current
                  ? "Saved everywhere"
                  : "View only",
            );
            setWebSharedLibraryStatus(
              needsLegacyImport
                ? webLibraryOwnerKeyRef.current
                  ? "Preserving an update from an older ScribeFlow tab…"
                  : "Older-tab update preserved · owner access needed"
                : hasPending
                ? "Browser changes preserved · retry sync"
                : conflictCount > 0
                  ? "Competing edits preserved as conflict copies"
                  : webLibraryOwnerKeyRef.current
                    ? "Your library is current"
                    : "View only · owner key required to edit",
            );
            if (showFeedback) {
              setToast(
                needsLegacyImport
                  ? "An older-tab update was preserved"
                  : hasPending
                  ? "Local changes are preserved and waiting to sync"
                  : conflictCount > 0
                    ? "Competing edits were preserved"
                    : "Your library is current",
              );
            }
            if (needsLegacyImport && webLibraryOwnerKeyRef.current) {
              saveWebSharedLibraryRef.current?.(
                displayedPayload.templates,
                displayedPayload.quicktexts,
                displayedPayload.vocabulary,
                Math.max(currentTimestamp(), displayedPayload.updatedAt + 1),
              );
            }
            return;
          }

          const remotePayload: WebSharedLibraryPayload | null =
            canonicalState?.payload || null;
          let fallbackPayload: WebSharedLibraryPayload | null = null;
          if (!remotePayload) {
            try {
              const response = await fetch(
                `${webSharedLibraryFallbackUrl()}?refresh=${currentTimestamp()}`,
                { cache: "no-store" },
              );
              if (response.ok) {
                fallbackPayload = parseWebSharedLibraryPayload(
                  await response.text(),
                );
              }
            } catch {
              fallbackPayload = null;
            }
          }
          if (
            cancelled ||
            webSharedLibrarySavingRef.current ||
            refreshEpoch !== webLibraryRefreshEpochRef.current ||
            mutationEpoch !== webSharedLibraryMutationEpochRef.current
          ) {
            return;
          }

          const localPayload = webSharedLibraryLocalRef.current;
          if (!localPayload) throw new Error("Local library is invalid");
          if (remotePayload) {
            let migrationPayload = remotePayload;
            let migrationConflicts = 0;
            if (webSharedLibraryDirtyRef.current) {
              const merged = mergeWebSharedLibrary({
                base: webSharedLibraryBaseRef.current,
                remote: remotePayload,
                local: localPayload,
              });
              migrationPayload = merged.payload as WebSharedLibraryPayload;
              migrationConflicts = merged.conflicts.length;
            }
            const needsMigration = Boolean(webLibraryOwnerKeyRef.current);
            persistWebLibraryLocally(migrationPayload, {
              dirty: needsMigration || webSharedLibraryDirtyRef.current,
              base: remotePayload,
              snapshotReason: "Prepared collision-safe online library",
            });
            setSyncConflictNotice(
              migrationConflicts > 0
                ? `${migrationConflicts} competing edit${
                    migrationConflicts === 1 ? " was" : "s were"
                  } preserved as conflict copies.`
                : "",
            );
            setTemplateStorageStatus(
              needsMigration ? "Preparing safer cross-PC sync" : "View only",
            );
            setWritingToolsStorageStatus(
              needsMigration ? "Preparing safer cross-PC sync" : "View only",
            );
            setWebSharedLibraryStatus(
              needsMigration
                ? "Upgrading shared library safely…"
                : "View only · owner key required to edit",
            );
            if (showFeedback) {
              setToast(needsMigration ? "Preparing safer sync" : "Library loaded");
            }
            if (needsMigration && deviceRecords) {
              saveWebSharedLibraryRef.current?.(
                migrationPayload.templates,
                migrationPayload.quicktexts,
                migrationPayload.vocabulary,
                Math.max(currentTimestamp(), migrationPayload.updatedAt + 1),
              );
            }
          } else if (
            fallbackPayload &&
            !webSharedLibraryDirtyRef.current &&
            fallbackPayload.updatedAt > localPayload.updatedAt
          ) {
            persistWebLibraryLocally(fallbackPayload, {
              dirty: false,
              snapshotReason: "Loaded bundled backup",
            });
            setTemplateStorageStatus("Loaded from backup");
            setWritingToolsStorageStatus("Loaded from backup");
            setWebSharedLibraryStatus(
              "Bundled backup loaded · online library unavailable",
            );
            if (showFeedback) setToast("Bundled library backup loaded");
          } else {
            setWebSharedLibraryStatus(
              webSharedLibraryDirtyRef.current
                ? "Offline · browser changes safely preserved"
                : "Offline · using the latest browser copy",
            );
            if (showFeedback) {
              setToast("Online library unavailable; browser copy kept");
            }
          }
        } catch {
          if (!cancelled) {
            setWebSharedLibraryStatus("Library check failed · browser copy kept");
            if (showFeedback) {
              setToast("Library check failed; browser copy kept");
            }
          }
        } finally {
          if (showFeedback) setSyncRefreshing(false);
        }
      };
      refreshSharedLibraryRef.current = refreshWebSharedLibrary;
      const refreshWhenVisible = () => {
        if (document.visibilityState === "visible") {
          void refreshWebSharedLibrary();
        }
      };
      const refreshAfterSiblingTabWrite = (event: StorageEvent) => {
        if (
          event.key === storageKeys.webLibraryDeviceRecord ||
          event.key?.startsWith(webLibraryOutboxPrefix)
        ) {
          lastAutomaticRefreshAt = 0;
          void refreshWebSharedLibrary();
        }
      };
      const timer = window.setInterval(() => {
        void refreshWebSharedLibrary();
      }, 300_000);
      void refreshWebSharedLibrary();
      window.addEventListener("focus", refreshWhenVisible);
      window.addEventListener("storage", refreshAfterSiblingTabWrite);
      document.addEventListener("visibilitychange", refreshWhenVisible);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
        window.removeEventListener("focus", refreshWhenVisible);
        window.removeEventListener("storage", refreshAfterSiblingTabWrite);
        document.removeEventListener("visibilitychange", refreshWhenVisible);
        refreshSharedLibraryRef.current = null;
      };
    }

    let cancelled = false;
    const refreshSharedLibrary = async (showFeedback = false) => {
      if (showFeedback) setSyncRefreshing(true);
      try {
        const [templateResponse, writingToolsResponse, statusResponse] =
          await Promise.all([
          fetch("http://127.0.0.1:3001/config/templates", {
            cache: "no-store",
          }),
          fetch("http://127.0.0.1:3001/config/writing-tools", {
            cache: "no-store",
          }),
          fetch("http://127.0.0.1:3001/config/status", {
            cache: "no-store",
          }),
        ]);
        if (cancelled) return;

        if (templateResponse.ok) {
          const payload = parseTemplateVaultPayload(
            await templateResponse.text(),
          );
          if (payload && payload.updatedAt >= templatesUpdatedAtRef.current) {
            templateBaseRef.current = payload;
          }
          if (payload && payload.updatedAt > templatesUpdatedAtRef.current) {
            const serialized = JSON.stringify(payload.templates);
            templatesUpdatedAtRef.current = payload.updatedAt;
            setTemplates(payload.templates);
            window.localStorage.setItem(storageKeys.templates, serialized);
            window.localStorage.setItem(
              storageKeys.templatesBackup,
              serialized,
            );
            window.localStorage.setItem(
              storageKeys.templatesUpdatedAt,
              String(payload.updatedAt),
            );
            setTemplateStorageStatus("Updated from OneDrive folder");
          }
        }

        if (writingToolsResponse.ok) {
          const payload = parseWritingToolsVaultPayload(
            await writingToolsResponse.text(),
          );
          if (
            payload &&
            payload.updatedAt >= writingToolsUpdatedAtRef.current
          ) {
            writingToolsBaseRef.current = payload;
          }
          if (
            payload &&
            payload.updatedAt > writingToolsUpdatedAtRef.current
          ) {
            writingToolsUpdatedAtRef.current = payload.updatedAt;
            setQuicktexts(payload.quicktexts);
            setVocabulary(payload.vocabulary);
            window.localStorage.setItem(
              storageKeys.quicktexts,
              JSON.stringify(payload.quicktexts),
            );
            window.localStorage.setItem(
              storageKeys.vocabulary,
              JSON.stringify(payload.vocabulary),
            );
            window.localStorage.setItem(
              storageKeys.writingToolsUpdatedAt,
              String(payload.updatedAt),
            );
            setWritingToolsStorageStatus("Updated from OneDrive folder");
          }
        }
        if (statusResponse.ok) {
          setSharedStorageStatus(
            (await statusResponse.json()) as SharedStorageStatus,
          );
        }
        if (showFeedback) setToast("Shared libraries checked");
      } catch {
        if (showFeedback) {
          setToast("Shared libraries could not be checked; browser backups remain");
        }
      } finally {
        if (showFeedback) setSyncRefreshing(false);
      }
    };
    refreshSharedLibraryRef.current = refreshSharedLibrary;

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshSharedLibrary();
      }
    };
    const timer = window.setInterval(() => {
      void refreshSharedLibrary();
    }, 5000);
    void refreshSharedLibrary();
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      refreshSharedLibraryRef.current = null;
    };
  }, [
    fetchWebSharedCanonical,
    fetchWebLibraryDeviceRecords,
    persistWebLibraryLocally,
    readWebLibraryOutbox,
    templatesReady,
    writingToolsReady,
  ]);

  useEffect(() => {
    if (webEdition) return;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    mediaDevices.addEventListener("devicechange", refreshMicrophones);
    return () =>
      mediaDevices.removeEventListener("devicechange", refreshMicrophones);
  }, [refreshMicrophones]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const formatRecognizedSpeech = useCallback(
    (text: string, capitalizeStart = true) =>
      applySpokenPunctuation(
        applyVocabularyCorrections(text, vocabulary),
        capitalizeStart,
      ),
    [vocabulary],
  );

  useEffect(() => {
    whisperResultHandlerRef.current = (rawText, session) => {
      if (session !== whisperSessionRef.current) return;
      const text = cleanWhisperTranscript(rawText);
      if (!text) return;
      setLastRecognizedPhrase(text.slice(-240));
      const formatted = formatRecognizedSpeech(
        text,
        shouldCapitalizeDictationStart(),
      );
      insertEditorText(`${formatted} `);
      setInterimText(formatted);
      window.setTimeout(() => setInterimText(""), 900);
    };
  }, [
    formatRecognizedSpeech,
    insertEditorText,
    shouldCapitalizeDictationStart,
  ]);

  const ensureWhisperWorker = useCallback(() => {
    if (whisperReady) {
      return Promise.resolve();
    }
    if (whisperLoadPromiseRef.current) {
      return whisperLoadPromiseRef.current;
    }

    whisperLoadPromiseRef.current = fetch(
      "http://127.0.0.1:3001/whisper/native-health",
      {
        cache: "no-store",
      },
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error("The native Whisper service is not ready");
        }
        setWhisperReady(true);
        setWhisperProgress(100);
      })
      .catch((error) => {
        setWhisperReady(false);
        whisperLoadPromiseRef.current = null;
        throw error;
      });

    return whisperLoadPromiseRef.current;
  }, [whisperReady]);

  const refreshWhisperInstallStatus = useCallback(async () => {
    if (webEdition) return;
    try {
      const response = await fetch(
        "http://127.0.0.1:3001/whisper/install-status",
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Whisper status is unavailable");
      const payload = (await response.json()) as WhisperInstallStatus;
      setWhisperInstallStatus(payload);
    } catch {
      setWhisperInstallStatus({
        status: "failed",
        installed: false,
        message:
          "ScribeFlow could not check Whisper. Close and reopen ScribeFlow, then try again.",
      });
    }
  }, []);

  const installWhisper = useCallback(async () => {
    if (webEdition) return;
    setWhisperUpdatePromptDismissed(false);
    setWhisperInstallStatus({
      status: "installing",
      installed: false,
      message:
        "Starting the verified Whisper download. Keep ScribeFlow open.",
    });
    try {
      const response = await fetch("http://127.0.0.1:3001/whisper/install", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Whisper installation could not start");
      const payload = (await response.json()) as WhisperInstallStatus;
      setWhisperInstallStatus(payload);
    } catch (error) {
      setWhisperInstallStatus({
        status: "failed",
        installed: false,
        message:
          error instanceof Error
            ? error.message
            : "Whisper installation could not start",
      });
    }
  }, []);

  useEffect(() => {
    if (webEdition) return;
    const timer = window.setTimeout(
      () => void refreshWhisperInstallStatus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [refreshWhisperInstallStatus]);

  useEffect(() => {
    if (webEdition) return;
    if (
      whisperInstallStatus.status !== "installing" &&
      whisperInstallStatus.status !== "starting"
    ) {
      return;
    }
    const timer = window.setInterval(
      () => void refreshWhisperInstallStatus(),
      2000,
    );
    return () => window.clearInterval(timer);
  }, [refreshWhisperInstallStatus, whisperInstallStatus.status]);

  useEffect(() => {
    if (webEdition) return;
    if (
      dictationEngine !== "whisper" ||
      !whisperSupported ||
      !whisperInstallStatus.installed ||
      whisperReady
    ) {
      return;
    }

    const connect = () => {
      setStatus("Starting local Whisper");
      void ensureWhisperWorker()
        .then(() => setStatus("Ready · Whisper local"))
        .catch(() => setStatus("Starting local Whisper"));
    };
    const connectTimer = window.setTimeout(connect, 0);
    const timer = window.setInterval(connect, 3000);
    return () => {
      window.clearTimeout(connectTimer);
      window.clearInterval(timer);
    };
  }, [
    dictationEngine,
    ensureWhisperWorker,
    whisperReady,
    whisperInstallStatus.installed,
    whisperSupported,
  ]);

  useEffect(() => {
    if (webEdition) return;
    if (dictationEngine !== "whisper" || whisperReady) return;
    const nextStatus =
      whisperInstallStatus.status === "installing"
        ? "Installing Whisper locally"
        : whisperInstallStatus.status === "missing" ||
            whisperInstallStatus.status === "failed"
          ? "Whisper installation recommended"
          : null;
    if (!nextStatus) return;
    const timer = window.setTimeout(() => setStatus(nextStatus), 0);
    return () => window.clearTimeout(timer);
  }, [dictationEngine, whisperInstallStatus.status, whisperReady]);

  useEffect(() => {
    if (whisperInstallStatus.status === "update_available") return;
    const timer = window.setTimeout(
      () => setWhisperUpdatePromptDismissed(false),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [whisperInstallStatus.status]);

  useEffect(
    () => () => {
      whisperProcessorRef.current?.disconnect();
      whisperSourceRef.current?.disconnect();
      whisperMuteRef.current?.disconnect();
      whisperStreamRef.current?.getTracks().forEach((track) => track.stop());
      void whisperAudioContextRef.current?.close();
      whisperChunksRef.current.forEach((chunk) => chunk.fill(0));
      whisperChunksRef.current = [];
    },
    [],
  );

  const transcribeWhisperAudio = useCallback(
    (audio: Float32Array) => {
      const wavBuffer = encodePcm16Wav(audio, 16000);
      audio.fill(0);
      const wavBytes = new Uint8Array(wavBuffer);
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([wavBuffer], { type: "audio/wav" }),
        "dictation.wav",
      );
      formData.append("response_format", "json");
      formData.append("language", "en");
      formData.append("translate", "false");
      formData.append("beam_size", "5");
      formData.append("best_of", "5");
      formData.append("temperature", "0");
      formData.append("temperature_inc", "0.2");
      formData.append("no_speech_thold", "0.6");
      formData.append("no_timestamps", "true");
      formData.append("suppress_nst", "true");
      const specialtyTerms = vocabulary
        .map((item) => item.replacement.trim())
        .filter(Boolean)
        .slice(0, 80);
      formData.append(
        "prompt",
        [
          "Medical clinical dictation. Preserve medication names, diagnoses, procedures, anatomy, abbreviations, dosages, and measurements.",
          "Do not add automatic commas. Use one comma only when the speaker explicitly dictates comma.",
          "Use preferred vocabulary only when it is actually spoken. Do not repeat words or phrases unless the speaker clearly repeats them.",
          "Never add sign-offs or transcription credits such as thank you, thanks for watching, subtitles by the Amara.org community, captions by GetTranscribed.com, transcription by CastingWords, transcription by ESO Translation, or transcription by ESO Translation by —.",
          specialtyTerms.length
            ? `Preferred specialty vocabulary: ${specialtyTerms.join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1800),
      );

      return fetch("http://127.0.0.1:3001/whisper/inference", {
        method: "POST",
        body: formData,
      })
        .then(async (response) => {
          const result = (await response.json()) as {
            text?: string;
            error?: string;
          };
          if (!response.ok) {
            throw new Error(
              result.error || "Native Whisper transcription failed",
            );
          }
          return String(result.text || "");
        })
        .finally(() => {
          wavBytes.fill(0);
        });
    },
    [vocabulary],
  );

  const previewWhisperAudio = useCallback(() => {
    const chunks = whisperChunksRef.current;
    const sampleCount = whisperSampleCountRef.current;
    if (
      !whisperReady ||
      !whisperHasSpeechRef.current ||
      whisperPreviewInFlightRef.current ||
      sampleCount < whisperSampleRateRef.current * 1.4
    ) {
      return;
    }

    const combined = new Float32Array(sampleCount);
    let offset = 0;
    chunks.forEach((chunk) => {
      combined.set(chunk, offset);
      offset += chunk.length;
    });
    const audio = resampleAudio(
      combined,
      whisperSampleRateRef.current,
      16000,
    );
    if (audio !== combined) combined.fill(0);

    const session = whisperSessionRef.current;
    const segment = whisperSegmentRef.current;
    ++whisperJobIdRef.current;
    whisperPreviewInFlightRef.current = true;
    whisperPendingJobsRef.current += 1;
    setStatus("Updating live preview · Whisper local");

    void transcribeWhisperAudio(audio)
      .then((rawText) => {
        if (
          session !== whisperSessionRef.current ||
          segment !== whisperSegmentRef.current ||
          !isRecordingRef.current
        ) {
          return;
        }
        const text = cleanWhisperTranscript(rawText);
        if (!text) return;
        setInterimText(
          formatRecognizedSpeech(
            text,
            shouldCapitalizeDictationStart(),
          ),
        );
      })
      .catch(() => {
        // A final segment still runs after a pause, so a missed preview is harmless.
      })
      .finally(() => {
        whisperPreviewInFlightRef.current = false;
        whisperPendingJobsRef.current = Math.max(
          0,
          whisperPendingJobsRef.current - 1,
        );
        if (isRecordingRef.current) {
          setStatus("Listening · live Whisper preview");
        } else if (whisperPendingJobsRef.current === 0) {
          setStatus("Ready · Whisper local");
        }
      });
  }, [
    formatRecognizedSpeech,
    shouldCapitalizeDictationStart,
    transcribeWhisperAudio,
    whisperReady,
  ]);

  const flushWhisperAudio = useCallback(() => {
    const chunks = whisperChunksRef.current;
    const sampleCount = whisperSampleCountRef.current;
    const hasSpeech = whisperHasSpeechRef.current;
    whisperChunksRef.current = [];
    whisperSampleCountRef.current = 0;
    whisperHasSpeechRef.current = false;
    whisperLastVoiceAtRef.current = 0;
    whisperLastPreviewSampleCountRef.current = 0;
    whisperSegmentRef.current += 1;

    if (
      !hasSpeech ||
      sampleCount < whisperSampleRateRef.current * 0.4 ||
      !whisperReady
    ) {
      chunks.forEach((chunk) => chunk.fill(0));
      return;
    }

    const combined = new Float32Array(sampleCount);
    let offset = 0;
    chunks.forEach((chunk) => {
      combined.set(chunk, offset);
      offset += chunk.length;
      chunk.fill(0);
    });

    const audio = resampleAudio(
      combined,
      whisperSampleRateRef.current,
      16000,
    );
    if (audio !== combined) combined.fill(0);

    ++whisperJobIdRef.current;
    const session = whisperSessionRef.current;
    const finalSequence = ++whisperFinalSequenceRef.current;
    whisperPendingJobsRef.current += 1;
    setStatus("Transcribing on this computer");

    const drainFinalResults = () => {
      while (
        whisperFinalResultsRef.current.has(whisperNextCommitRef.current)
      ) {
        const result = whisperFinalResultsRef.current.get(
          whisperNextCommitRef.current,
        );
        whisperFinalResultsRef.current.delete(whisperNextCommitRef.current);
        whisperNextCommitRef.current += 1;
        if (result) {
          whisperResultHandlerRef.current(result.text, result.session);
        }
      }
    };

    void transcribeWhisperAudio(audio)
      .then((text) => {
        whisperFinalResultsRef.current.set(finalSequence, { text, session });
        drainFinalResults();
      })
      .catch((error) => {
        whisperFinalResultsRef.current.set(finalSequence, {
          text: "",
          session,
        });
        drainFinalResults();
        setStatus("Local Whisper unavailable");
        setToast(
          error instanceof Error
            ? error.message
            : "Native Whisper could not transcribe audio",
        );
      })
      .finally(() => {
        whisperPendingJobsRef.current = Math.max(
          0,
          whisperPendingJobsRef.current - 1,
        );
        if (isRecordingRef.current) {
          setStatus("Listening · Whisper local");
        } else if (whisperPendingJobsRef.current === 0) {
          setStatus("Ready · Whisper local");
        }
      });
  }, [transcribeWhisperAudio, whisperReady]);

  const stopChromeRecording = useCallback(() => {
    shouldRestartRef.current = false;
    const pendingTranscript = interimTranscriptRef.current.trim();
    if (pendingTranscript) {
      setLastRecognizedPhrase(pendingTranscript.slice(-240));
      insertEditorText(
        `${formatRecognizedSpeech(
          pendingTranscript,
          shouldCapitalizeDictationStart(),
        )} `,
      );
    }
    interimTranscriptRef.current = "";
    recognitionRef.current?.stop();
    setIsRecording(false);
    setInterimText("");
    setStatus("Ready");
  }, [
    formatRecognizedSpeech,
    insertEditorText,
    shouldCapitalizeDictationStart,
  ]);

  const startChromeRecording = useCallback(async () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      setToast("Live dictation is not supported in this browser");
      return;
    }

    let microphoneAccessConfirmed = false;
    try {
      const permission = await navigator.permissions?.query({
        name: "microphone" as PermissionName,
      });
      if (permission?.state === "denied") {
        setIsRecording(false);
        setStatus("Microphone permission needed");
        setToast("Allow microphone access in the browser, then try again");
        return;
      }
      microphoneAccessConfirmed = permission?.state === "granted";
    } catch {
      // SpeechRecognition will request or report microphone access itself.
    }

    const localSpeechOptions: SpeechRecognitionOptions = {
      langs: ["en-US"],
      processLocally: true,
    };
    if (!SpeechRecognition.available || !SpeechRecognition.install) {
      setStatus("On-device dictation required");
      setToast("Use current Chrome with the offline English speech pack");
      return;
    }

    let useOnDeviceRecognition = false;
    try {
      setStatus("Checking offline dictation");
      const availability =
        await SpeechRecognition.available(localSpeechOptions);

      if (availability === "available") {
        useOnDeviceRecognition = true;
        window.localStorage.setItem(storageKeys.speechPackReady, "true");
      } else if (
        availability === "downloadable" ||
        availability === "downloading"
      ) {
        setStatus("Installing offline dictation");
        setToast("Installing the English pack for on-device dictation");
        useOnDeviceRecognition =
          await SpeechRecognition.install(localSpeechOptions);
        if (useOnDeviceRecognition) {
          window.localStorage.setItem(storageKeys.speechPackReady, "true");
        }
      }
    } catch {
      useOnDeviceRecognition = false;
    }

    if (!useOnDeviceRecognition) {
      setIsRecording(false);
      setStatus("Offline dictation unavailable");
      setToast("Dictation was blocked because on-device recognition is unavailable");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.processLocally = true;
    if (window.SpeechRecognitionPhrase && vocabulary.length > 0) {
      recognition.phrases = vocabulary.map(
        (item) => new window.SpeechRecognitionPhrase!(item.replacement, 5),
      );
    }
    shouldRestartRef.current = true;

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalTranscript += result[0].transcript;
        else interimTranscript += result[0].transcript;
      }
      const capitalizeTranscriptStart = shouldCapitalizeDictationStart();
      if (finalTranscript) {
        setLastRecognizedPhrase(
          finalTranscript.replace(/\s+/g, " ").trim().slice(-240),
        );
        insertEditorText(
          `${formatRecognizedSpeech(
            finalTranscript,
            capitalizeTranscriptStart,
          )} `,
        );
      }
      interimTranscriptRef.current = interimTranscript;
      const visibleTranscript = [finalTranscript, interimTranscript]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (visibleTranscript) {
        setInterimText(
          formatRecognizedSpeech(
            visibleTranscript,
            capitalizeTranscriptStart,
          ),
        );
      }
      if (finalTranscript || interimTranscript) {
        setStatus("Hearing speech");
      }
    };

    recognition.onerror = (event) => {
      const recognitionError = event.error || "unknown";
      shouldRestartRef.current = false;
      setIsRecording(false);
      interimTranscriptRef.current = "";
      setInterimText("");

      if (
        microphoneAccessConfirmed &&
        (recognitionError === "not-allowed" ||
          recognitionError === "service-not-allowed")
      ) {
        setStatus("Speech service blocked");
        setToast(
          "Microphone access is allowed, but speech recognition is blocked in this browser",
        );
      } else if (recognitionError === "network") {
        setStatus("Online speech unavailable");
        setToast(
          "Use Chrome 139 or newer to enable private offline dictation",
        );
      } else if (
        recognitionError === "language-not-supported" ||
        recognitionError === "language-unavailable"
      ) {
        window.localStorage.removeItem(storageKeys.speechPackReady);
        setStatus("Offline speech unavailable");
        setToast("The English speech pack is missing; start again to reinstall it");
      } else if (recognitionError === "audio-capture") {
        setStatus("Microphone unavailable");
        setToast("Another app may be using the microphone");
      } else if (recognitionError === "no-speech") {
        setStatus("Ready");
        setToast("No speech was detected — try again");
      } else {
        setStatus("Dictation unavailable");
        setToast(event.message || "Unable to start live dictation");
      }
    };

    recognition.onend = () => {
      if (shouldRestartRef.current) {
        const pendingTranscript = interimTranscriptRef.current.trim();
        if (pendingTranscript) {
          insertEditorText(
            `${formatRecognizedSpeech(
              pendingTranscript,
              shouldCapitalizeDictationStart(),
            )} `,
          );
          interimTranscriptRef.current = "";
        }
        try {
          recognition.start();
          setStatus("Listening on device");
        } catch {
          shouldRestartRef.current = false;
          setIsRecording(false);
          setInterimText("");
          setStatus("Ready");
        }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setElapsed(0);
      setIsRecording(true);
      setStatus("Listening on device");
    } catch {
      setToast("Unable to start dictation");
    }
  }, [
    formatRecognizedSpeech,
    insertEditorText,
    shouldCapitalizeDictationStart,
    vocabulary,
  ]);

  const stopWhisperRecording = useCallback(() => {
    isRecordingRef.current = false;
    const processor = whisperProcessorRef.current;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    whisperProcessorRef.current = null;
    whisperSourceRef.current?.disconnect();
    whisperSourceRef.current = null;
    whisperMuteRef.current?.disconnect();
    whisperMuteRef.current = null;
    whisperStreamRef.current?.getTracks().forEach((track) => track.stop());
    whisperStreamRef.current = null;
    void whisperAudioContextRef.current?.close();
    whisperAudioContextRef.current = null;
    flushWhisperAudio();
    setIsRecording(false);
    setInterimText("");
    setStatus(
      whisperPendingJobsRef.current > 0
        ? "Finishing local transcription"
        : "Ready · Whisper local",
    );
  }, [flushWhisperAudio]);

  const startWhisperRecording = useCallback(async () => {
    if (!whisperSupported) {
      setToast("Local Whisper needs current Chrome with WebGPU enabled");
      return;
    }

    try {
      setStatus(
        whisperReady
          ? "Starting local microphone"
          : `Loading local Whisper${whisperProgress ? ` · ${whisperProgress}%` : ""}`,
      );
      await ensureWhisperWorker();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId:
            selectedMicrophoneId === "default"
              ? undefined
              : { exact: selectedMicrophoneId },
        },
        video: false,
      });
      await refreshMicrophones();
      const audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioContext.destination);

      whisperStreamRef.current = stream;
      whisperAudioContextRef.current = audioContext;
      whisperSourceRef.current = source;
      whisperProcessorRef.current = processor;
      whisperMuteRef.current = mute;
      whisperSampleRateRef.current = audioContext.sampleRate;
      whisperChunksRef.current = [];
      whisperSampleCountRef.current = 0;
      whisperHasSpeechRef.current = false;
      whisperLastVoiceAtRef.current = 0;
      whisperLastPreviewSampleCountRef.current = 0;
      whisperSegmentRef.current += 1;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (let index = 0; index < input.length; index += 1) {
          energy += input[index] * input[index];
        }
        const rms = Math.sqrt(energy / input.length);
        const now = currentTimestamp();
        if (rms >= 0.012) {
          whisperHasSpeechRef.current = true;
          whisperLastVoiceAtRef.current = now;
        }
        if (!whisperHasSpeechRef.current) return;

        const chunk = new Float32Array(input);
        whisperChunksRef.current.push(chunk);
        whisperSampleCountRef.current += chunk.length;
        const secondsBuffered =
          whisperSampleCountRef.current / whisperSampleRateRef.current;
        const silenceMilliseconds =
          now - whisperLastVoiceAtRef.current;
        const shouldFlush =
          secondsBuffered >= 15 ||
          (secondsBuffered >= 0.7 && silenceMilliseconds >= 900);

        if (shouldFlush) {
          flushWhisperAudio();
        } else if (
          secondsBuffered >= 1.4 &&
          whisperSampleCountRef.current -
            whisperLastPreviewSampleCountRef.current >=
            whisperSampleRateRef.current * 2.5
        ) {
          whisperLastPreviewSampleCountRef.current =
            whisperSampleCountRef.current;
          previewWhisperAudio();
        }
      };

      setElapsed(0);
      isRecordingRef.current = true;
      setIsRecording(true);
      setStatus("Listening · Whisper local");
    } catch (error) {
      whisperStreamRef.current?.getTracks().forEach((track) => track.stop());
      whisperStreamRef.current = null;
      setIsRecording(false);
      setStatus("Local Whisper unavailable");
      setToast(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Allow microphone access in Chrome, then try again"
          : error instanceof DOMException &&
              error.name === "OverconstrainedError"
            ? "That microphone is unavailable; choose another input"
          : error instanceof Error
            ? error.message
            : "Unable to start local Whisper",
      );
    }
  }, [
    ensureWhisperWorker,
    flushWhisperAudio,
    previewWhisperAudio,
    whisperProgress,
    whisperReady,
    whisperSupported,
    refreshMicrophones,
    selectedMicrophoneId,
  ]);

  const stopRecording = useCallback(() => {
    if (dictationEngine === "whisper") stopWhisperRecording();
    else stopChromeRecording();
  }, [dictationEngine, stopChromeRecording, stopWhisperRecording]);

  const startRecording = useCallback(() => {
    if (microphoneTestState === "testing") {
      stopMicrophoneTest(false);
    }
    if (dictationEngine === "whisper") void startWhisperRecording();
    else void startChromeRecording();
  }, [
    dictationEngine,
    microphoneTestState,
    startChromeRecording,
    startWhisperRecording,
    stopMicrophoneTest,
  ]);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        !webEdition &&
        event.code === "Backquote" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.repeat
      ) {
        event.preventDefault();
        toggleRecording();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("library-search")?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [toggleRecording]);

  const filteredQuicktexts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return quicktexts;
    return quicktexts.filter((item) =>
      `${item.shortcut} ${item.title} ${item.category}`
        .toLowerCase()
        .includes(query),
    );
  }, [quicktexts, search]);

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter((item) =>
      `${item.name} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(query),
    );
  }, [search, templates]);

  const filteredVocabulary = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return vocabulary;
    return vocabulary.filter((item) =>
      `${item.heard} ${item.replacement}`.toLowerCase().includes(query),
    );
  }, [search, vocabulary]);

  const matchingSuggestions = useMemo(() => {
    if (!currentToken) return [];
    return quicktexts
      .filter((item) => item.shortcut.startsWith(currentToken.toLowerCase()))
      .slice(0, 3);
  }, [currentToken, quicktexts]);

  function expandQuicktext(
    item: Quicktext,
    replaceToken = Boolean(currentToken),
  ) {
    insertEditorText(item.content, replaceToken);
    setToast(`${item.shortcut} inserted`);
  }

  function handleNoteKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const token = getCaretToken();
    if (
      (event.key === " " || event.key === "Enter" || event.key === "Tab") &&
      token
    ) {
      const pdfFieldValue = resolveMeasurementTokens(token, pdfMeasurements);
      if (pdfFieldValue.toLowerCase() !== token.toLowerCase()) {
        event.preventDefault();
        insertEditorText(pdfFieldValue, true);
        return;
      }
      const match = quicktexts.find(
        (item) => item.shortcut.toLowerCase() === token.toLowerCase(),
      );
      if (match) {
        event.preventDefault();
        expandQuicktext(match, true);
      }
    }
    if (event.key === "Tab" && matchingSuggestions[0]) {
      event.preventDefault();
      expandQuicktext(matchingSuggestions[0], true);
    }
  }

  function applyFormatting(command: "bold" | "underline") {
    const editor = noteRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) return;

    if (lastSelectionRef.current) {
      selection.removeAllRanges();
      selection.addRange(lastSelectionRef.current);
    }

    editor.focus();
    document.execCommand(command, false);
    syncEditorState();
    updateEditorSelectionState();
  }

  function applyTemplate(template: Template) {
    const hasContent = note.trim().length > 0;
    const warning = noteCopied
      ? "Replace the current note with this template?"
      : "This note has not been copied. Replace it with this template?";
    if (hasContent && !window.confirm(warning)) {
      return;
    }
    setEditorText(
      resolveMeasurementTokens(template.content, pdfMeasurements),
      template.contentHtml
        ? resolveMeasurementTokens(
            template.contentHtml,
            pdfMeasurements,
            true,
          )
        : undefined,
    );
    setToast(`${template.name} applied`);
    window.requestAnimationFrame(() => noteRef.current?.focus());
  }

  function requireWebLibraryOwner() {
    if (
      webEdition &&
      !(navigator as Navigator & { locks?: { request?: unknown } }).locks
        ?.request
    ) {
      setWebSharedLibraryStatus(
        "Editing is paused because this browser cannot safely coordinate tabs",
      );
      setToast("Open ScribeFlow in current Chrome or Edge to edit safely");
      return false;
    }
    if (!webEdition || webLibraryOwnerKeyRef.current) return true;
    setShowWebLibraryManager(true);
    setToast("Owner access is required to edit reusable library fields");
    return false;
  }

  function saveWebSharedLibrary(
    nextTemplates: Template[],
    nextQuicktexts: Quicktext[],
    nextVocabulary: VocabularyItem[],
    updatedAt: number,
  ) {
    if (!webEdition) return;
    const sharedPayload: WebSharedLibraryPayload = {
      version: 1,
      updatedAt,
      templates: nextTemplates,
      quicktexts: nextQuicktexts,
      vocabulary: nextVocabulary,
    };
    const ownerKey = webLibraryOwnerKeyRef.current;
    if (!ownerKey) {
      setTemplateStorageStatus("View only · owner key required");
      setWritingToolsStorageStatus("View only · owner key required");
      setWebSharedLibraryStatus("Owner key required to sync changes");
      setShowWebLibraryManager(true);
      setToast("Add the owner key before editing the shared library");
      return;
    }
    const lockManager = (
      navigator as Navigator & { locks?: { request?: unknown } }
    ).locks;
    if (!lockManager?.request) {
      setTemplateStorageStatus("Safe multi-tab sync needs Chrome or Edge");
      setWritingToolsStorageStatus("Safe multi-tab sync needs Chrome or Edge");
      setWebSharedLibraryStatus(
        "Editing is paused because this browser cannot safely coordinate tabs",
      );
      setToast("Open ScribeFlow in current Chrome or Edge to edit safely");
      return;
    }
    const previousPayload = webSharedLibraryLocalRef.current;
    const knownHeadsAtEdit = new Map(
      Array.from(webLibraryHeadsRef.current.entries(), ([key, heads]) => [
        key,
        [...heads],
      ]),
    );
    try {
      queueWebLibraryMutations(previousPayload, sharedPayload);
    } catch {
      setToast("Browser copy kept; trying the online save directly");
    }
    webSharedLibraryMutationEpochRef.current += 1;
    const saveEpoch = webSharedLibraryMutationEpochRef.current;
    webLibraryRefreshEpochRef.current += 1;
    try {
      persistWebLibraryLocally(sharedPayload, {
        dirty: true,
        snapshotReason: "Saved in this browser",
      });
    } catch {
      webSharedLibraryLocalRef.current = sharedPayload;
      webSharedLibraryDirtyRef.current = true;
      setWebLibraryDirty(true);
      try {
        window.localStorage.setItem(storageKeys.webLibraryDirty, "true");
      } catch {
        // The in-memory copy remains available for the immediate save attempt.
      }
    }
    if (
      utf8ByteLength(JSON.stringify(sharedPayload)) > WEB_LIBRARY_MAX_BYTES
    ) {
      setTemplateStorageStatus("Library too large to sync");
      setWritingToolsStorageStatus("Library too large to sync");
      setWebSharedLibraryStatus(
        "Library too large to sync · browser changes preserved",
      );
      setToast(
        "Library too large to sync; reduce reusable content and retry",
      );
      return;
    }
    setTemplateStorageStatus("Saving everywhere…");
    setWritingToolsStorageStatus("Saving everywhere…");
    setWebSharedLibraryStatus("Saving your changes everywhere…");
    webSharedLibrarySavingRef.current = true;
    setWebLibrarySaving(true);

    const savePromise = webSharedLibrarySaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        return withWebLibraryWriteLock(async () => {
          const activeOwnerKey = webLibraryOwnerKeyRef.current;
          if (!activeOwnerKey) {
            const error = new Error("Owner key required") as Error & {
              status?: number;
            };
            error.status = 401;
            throw error;
          }
          const deviceId = webLibraryDeviceIdRef.current;
          const actorId = webLibraryActorIdRef.current;
          const [initialRecords, canonicalState] = await Promise.all([
            fetchWebLibraryDeviceRecords(),
            fetchWebSharedCanonical().catch(() => null),
          ]);
          let records = initialRecords;
          const remoteOwnRecord = records.find(
            (record) => record.deviceId === deviceId,
          );
          const recordCandidates: WebLibraryDeviceRecord[] = [];
          if (remoteOwnRecord) recordCandidates.push(remoteOwnRecord);
          if (webLibraryDeviceRecordRef.current) {
            recordCandidates.push(webLibraryDeviceRecordRef.current);
          }
          let ownRecord =
            recordCandidates.length > 0
              ? (mergeWebLibraryDeviceRecords(
                  recordCandidates,
                  deviceId,
                ) as WebLibraryDeviceRecord)
              : (createEmptyWebLibraryDeviceRecord(
                  deviceId,
                  currentTimestamp(),
                ) as WebLibraryDeviceRecord);

          const pending = readWebLibraryOutbox();
          const processedIds = new Set(pending.map((entry) => entry.mutationId));
          if (pending.length > 0) {
            ownRecord = applyWebLibraryOperations(
              ownRecord,
              pending,
              currentTimestamp(),
            ) as WebLibraryDeviceRecord;
          }

          if (records.length === 0 && pending.length === 0) {
            const payload = webSharedLibraryLocalRef.current || sharedPayload;
            const seedMutations = diffWebLibraryPayload(
              { version: 1, updatedAt: 0, templates: [], quicktexts: [], vocabulary: [] },
              payload,
            ) as Array<{
              collection: WebLibraryCollection;
              itemId: string;
              tombstone: boolean;
              value?: Template | Quicktext | VocabularyItem;
            }>;
            const seedOperations: WebLibraryOperation[] = seedMutations.map(
              (mutation) => {
                webLibraryActorCounterRef.current += 1;
                return createWebLibraryOperation({
                  ...mutation,
                  actorId,
                  counter: webLibraryActorCounterRef.current,
                  context: {},
                }) as WebLibraryOperation;
              },
            );
            ownRecord = applyWebLibraryOperations(
              ownRecord,
              seedOperations,
              currentTimestamp(),
            ) as WebLibraryDeviceRecord;
          }

          let beforeNormalization = materializeWebLibraryDeviceRecords(
            [
              ...records.filter((record) => record.deviceId !== deviceId),
              ownRecord,
            ],
            currentTimestamp(),
          ) as {
            payload: WebSharedLibraryPayload;
            heads: Map<string, WebLibraryOperation[]>;
            conflicts: WebLibraryConflict[];
          };
          const desiredPayload =
            webSharedLibraryLocalRef.current || sharedPayload;
          const intentBase = webSharedLibraryBaseRef.current || {
            version: 1 as const,
            updatedAt: 0,
            templates: [],
            quicktexts: [],
            vocabulary: [],
          };
          const intendedMutations = diffWebLibraryPayload(
            intentBase,
            desiredPayload,
          ) as Array<{
            collection: WebLibraryCollection;
            itemId: string;
            tombstone: boolean;
            value?: Template | Quicktext | VocabularyItem;
          }>;
          const recoveryOperations: WebLibraryOperation[] = [];
          for (const mutation of intendedMutations) {
            const pendingForItem = pending.filter(
              (operation) =>
                operation.collection === mutation.collection &&
                operation.itemId === mutation.itemId,
            );
            const pendingAlreadyCarriesIntent = pendingForItem.some(
              (operation) =>
                operation.tombstone === mutation.tombstone &&
                (mutation.tombstone ||
                  stableWebLibraryJson(operation.value) ===
                    stableWebLibraryJson(mutation.value)),
            );
            if (pendingAlreadyCarriesIntent) continue;
            const materializedItem = (
              beforeNormalization.payload[mutation.collection] as Array<
                Template | Quicktext | VocabularyItem
              >
            ).find((item) => item.id === mutation.itemId);
            const materializedAlreadyCarriesIntent = mutation.tombstone
              ? !materializedItem
              : stableWebLibraryJson(materializedItem) ===
                stableWebLibraryJson(mutation.value);
            if (materializedAlreadyCarriesIntent) continue;

            const groupKey = `${mutation.collection}\u0000${mutation.itemId}`;
            const context = webLibraryContextFromOperations([
              ...(knownHeadsAtEdit.get(groupKey) || []),
              ...pendingForItem,
            ]) as Record<string, number>;
            webLibraryActorCounterRef.current += 1;
            recoveryOperations.push(
              createWebLibraryOperation({
                ...mutation,
                actorId,
                counter: webLibraryActorCounterRef.current,
                context,
              }) as WebLibraryOperation,
            );
          }
          if (recoveryOperations.length > 0) {
            ownRecord = applyWebLibraryOperations(
              ownRecord,
              recoveryOperations,
              currentTimestamp(),
            ) as WebLibraryDeviceRecord;
            beforeNormalization = materializeWebLibraryDeviceRecords(
              [
                ...records.filter((record) => record.deviceId !== deviceId),
                ownRecord,
              ],
              currentTimestamp(),
            ) as {
              payload: WebSharedLibraryPayload;
              heads: Map<string, WebLibraryOperation[]>;
              conflicts: WebLibraryConflict[];
            };
          }
          let canonicalWasAlreadyHandled = [
            ...records,
            ownRecord,
          ].some((record) =>
            record.canonicalFingerprints.includes(
              canonicalState?.fingerprint || "",
            ),
          );
          if (canonicalState && !canonicalWasAlreadyHandled) {
            try {
              const markerRefresh = await fetchWebLibraryDeviceRecords();
              canonicalWasAlreadyHandled = markerRefresh.some((record) =>
                record.canonicalFingerprints.includes(
                  canonicalState.fingerprint,
                ),
              );
            } catch {
              // The additive import below is safe if the marker check is offline.
            }
          }
          if (
            canonicalState &&
            !canonicalWasAlreadyHandled
          ) {
            // A v1 tab replaces the whole canonical record. With no revision
            // token, treat its additions and edits as additive and never turn
            // missing items into deletes that could erase newer v2 work.
            const legacyMerge = mergeWebSharedLibrary({
              base: null,
              remote: beforeNormalization.payload,
              local: canonicalState.payload,
              now: webLibraryConflictSeed(canonicalState.fingerprint),
            });
            const legacyMutations = diffWebLibraryPayload(
              beforeNormalization.payload,
              legacyMerge.payload,
            ) as Array<{
              collection: WebLibraryCollection;
              itemId: string;
              tombstone: boolean;
              value?: Template | Quicktext | VocabularyItem;
            }>;
            const legacyOperations: WebLibraryOperation[] = [];
            for (const mutation of legacyMutations) {
              if (mutation.tombstone) continue;
              const groupKey = `${mutation.collection}\u0000${mutation.itemId}`;
              webLibraryActorCounterRef.current += 1;
              legacyOperations.push(
                createWebLibraryOperation({
                  ...mutation,
                  actorId,
                  counter: webLibraryActorCounterRef.current,
                  context: webLibraryContextFromOperations(
                    beforeNormalization.heads.get(groupKey) || [],
                  ) as Record<string, number>,
                }) as WebLibraryOperation,
              );
            }
            if (legacyOperations.length > 0) {
              ownRecord = applyWebLibraryOperations(
                ownRecord,
                legacyOperations,
                currentTimestamp(),
              ) as WebLibraryDeviceRecord;
            }
            ownRecord = {
              ...ownRecord,
              canonicalFingerprints: collectCanonicalFingerprints(
                [...records, ownRecord],
                [canonicalState.fingerprint],
              ),
            };
            beforeNormalization = materializeWebLibraryDeviceRecords(
              [
                ...records.filter((record) => record.deviceId !== deviceId),
                ownRecord,
              ],
              currentTimestamp(),
            ) as {
              payload: WebSharedLibraryPayload;
              heads: Map<string, WebLibraryOperation[]>;
              conflicts: WebLibraryConflict[];
            };
          }
          const normalizationOperations: WebLibraryOperation[] = [];
          for (const conflict of beforeNormalization.conflicts) {
            const sourceContext = webLibraryContextFromOperations(
              conflict.heads,
            ) as Record<string, number>;
            webLibraryActorCounterRef.current += 1;
            normalizationOperations.push(
              createWebLibraryOperation({
                collection: conflict.collection,
                itemId: conflict.itemId,
                actorId,
                counter: webLibraryActorCounterRef.current,
                context: sourceContext,
                tombstone: false,
                value: conflict.primary,
              }) as WebLibraryOperation,
            );
            for (const copy of conflict.copies) {
              const copyKey = `${conflict.collection}\u0000${copy.conflictId}`;
              if ((beforeNormalization.heads.get(copyKey) || []).length > 0) {
                continue;
              }
              webLibraryActorCounterRef.current += 1;
              normalizationOperations.push(
                createWebLibraryOperation({
                  collection: conflict.collection,
                  itemId: copy.conflictId,
                  actorId,
                  counter: webLibraryActorCounterRef.current,
                  context: {},
                  tombstone: false,
                  value: copy.value,
                }) as WebLibraryOperation,
              );
            }
          }
          if (normalizationOperations.length > 0) {
            ownRecord = applyWebLibraryOperations(
              ownRecord,
              normalizationOperations,
              currentTimestamp(),
            ) as WebLibraryDeviceRecord;
          }
          ownRecord = pruneCoveredWebLibraryOperations(
            ownRecord,
            [
              ...records.filter((record) => record.deviceId !== deviceId),
              ownRecord,
            ],
            currentTimestamp(),
          ) as WebLibraryDeviceRecord;
          ownRecord = {
            ...ownRecord,
            canonicalFingerprints: collectCanonicalFingerprints(
              [...records, ownRecord],
              canonicalState ? [canonicalState.fingerprint] : [],
            ),
          };

          const serializedRecord = stableWebLibraryJson(ownRecord);
          if (utf8ByteLength(serializedRecord) > WEB_LIBRARY_DEVICE_MAX_BYTES) {
            const error = new Error("Library device record too large") as Error & {
              code?: string;
            };
            error.code = "library-too-large";
            throw error;
          }
          webLibraryDeviceRecordRef.current = ownRecord;
          window.localStorage.setItem(
            storageKeys.webLibraryDeviceRecord,
            serializedRecord,
          );

          const writeResponse = await fetch(webSharedLibraryDeviceUrl(deviceId), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Mantle-Key": activeOwnerKey,
            },
            body: serializedRecord,
          });
          if (!writeResponse.ok) {
            const error = new Error("Shared library save failed") as Error & {
              status?: number;
            };
            error.status = writeResponse.status;
            throw error;
          }
          const visibilityResponse = await fetch(
            webSharedLibraryDeviceVisibilityUrl(deviceId),
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "X-Mantle-Key": activeOwnerKey,
              },
              body: JSON.stringify({ public_read: true }),
            },
          );
          if (!visibilityResponse.ok) {
            throw new Error("The browser library record is not publicly readable");
          }
          const verifyResponse = await fetch(
            `${webSharedLibraryDeviceUrl(deviceId)}?verify=${currentTimestamp()}`,
            { cache: "no-store" },
          );
          if (!verifyResponse.ok) {
            throw new Error("The browser library record could not be verified");
          }
          let verifiedRecord = parseWebLibraryDeviceRecordForApp(
            await verifyResponse.text(),
          );
          if (
            !verifiedRecord ||
            stableWebLibraryJson(verifiedRecord) !== serializedRecord
          ) {
            throw new Error("The browser library verification did not match");
          }

          try {
            records = await fetchWebLibraryDeviceRecords();
          } catch {
            records = records.filter((record) => record.deviceId !== deviceId);
          }
          records = [
            ...records.filter((record) => record.deviceId !== deviceId),
            verifiedRecord,
          ];
          const finalMaterialized = materializeWebLibraryDeviceRecords(
            records,
            currentTimestamp(),
          ) as {
            payload: WebSharedLibraryPayload;
            heads: Map<string, WebLibraryOperation[]>;
            conflicts: WebLibraryConflict[];
          };
          const finalPayload = parseWebSharedLibraryPayload(
            JSON.stringify(finalMaterialized.payload),
          );
          if (!finalPayload) {
            throw new Error("The merged online library is invalid");
          }

          const canonicalBody = JSON.stringify(finalPayload);
          const canonicalFingerprint = await fingerprintWebLibrary(finalPayload);
          if (
            !verifiedRecord.canonicalFingerprints.includes(
              canonicalFingerprint,
            )
          ) {
            const markedRecord: WebLibraryDeviceRecord = {
              ...verifiedRecord,
              canonicalFingerprints: collectCanonicalFingerprints(
                records,
                [canonicalFingerprint],
              ),
            };
            const serializedMarkedRecord = stableWebLibraryJson(markedRecord);
            if (
              utf8ByteLength(serializedMarkedRecord) >
              WEB_LIBRARY_DEVICE_MAX_BYTES
            ) {
              const error = new Error(
                "Library device record too large",
              ) as Error & { code?: string };
              error.code = "library-too-large";
              throw error;
            }
            const markerWriteResponse = await fetch(
              webSharedLibraryDeviceUrl(deviceId),
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Mantle-Key": activeOwnerKey,
                },
                body: serializedMarkedRecord,
              },
            );
            if (!markerWriteResponse.ok) {
              throw new Error("The compatibility marker could not be saved");
            }
            const markerVerifyResponse = await fetch(
              `${webSharedLibraryDeviceUrl(deviceId)}?marker=${currentTimestamp()}`,
              { cache: "no-store" },
            );
            const markerVerifiedRecord = markerVerifyResponse.ok
              ? parseWebLibraryDeviceRecordForApp(
                  await markerVerifyResponse.text(),
                )
              : null;
            if (
              !markerVerifiedRecord ||
              stableWebLibraryJson(markerVerifiedRecord) !==
                serializedMarkedRecord
            ) {
              throw new Error("The compatibility marker could not be verified");
            }
            verifiedRecord = markerVerifiedRecord;
          }
          const latestCanonicalState = await fetchWebSharedCanonical().catch(
            () => null,
          );
          if (
            latestCanonicalState &&
            latestCanonicalState.fingerprint !== canonicalFingerprint &&
            latestCanonicalState.fingerprint !== canonicalState?.fingerprint
          ) {
            const error = new Error(
              "The older compatibility library changed during this save",
            ) as Error & { code?: string };
            error.code = "canonical-changed";
            throw error;
          }
          if (utf8ByteLength(canonicalBody) <= WEB_LIBRARY_MAX_BYTES) {
            try {
              await fetch(webSharedLibraryUrl(), {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Mantle-Key": activeOwnerKey,
                },
                body: canonicalBody,
              });
            } catch {
              // The canonical v1 record is compatibility-only in protocol v2.
            }
          }

          clearWebLibraryOutboxEntries(processedIds);
          webLibraryDeviceRecordRef.current = verifiedRecord;
          webLibraryHeadsRef.current = finalMaterialized.heads;
          webLibraryConflictsRef.current = finalMaterialized.conflicts;
          window.localStorage.setItem(
            storageKeys.webLibraryDeviceRecord,
            stableWebLibraryJson(verifiedRecord),
          );

          const remaining = readWebLibraryOutbox();
          const savedLatestLocal =
            remaining.length === 0 &&
            saveEpoch === webSharedLibraryMutationEpochRef.current;
          if (savedLatestLocal) {
            persistWebLibraryLocally(finalPayload, {
              dirty: false,
              base: finalPayload,
              snapshotReason: "Saved online",
            });
          }
          const conflictCount = finalMaterialized.conflicts.length;
          setSyncConflictNotice(
            conflictCount > 0
              ? `${conflictCount} competing edit${
                  conflictCount === 1 ? " was" : "s were"
                } preserved as conflict copies.`
              : "",
          );
          return savedLatestLocal;
        });
      });
    webSharedLibrarySaveQueueRef.current = savePromise;
    void savePromise
      .then((savedLatestLocal) => {
        setTemplateStorageStatus(
          savedLatestLocal ? "Saved everywhere" : "Browser changes waiting to sync",
        );
        setWritingToolsStorageStatus(
          savedLatestLocal ? "Saved everywhere" : "Browser changes waiting to sync",
        );
        setWebSharedLibraryStatus(
          savedLatestLocal
            ? "Your library is saved everywhere"
            : "Newer browser changes are preserved · retry sync",
        );
        setToast(
          savedLatestLocal
            ? "Saved everywhere"
            : "Newer browser changes are preserved and still need syncing",
        );
      })
      .catch((error: Error & { code?: string; status?: number }) => {
        const libraryTooLarge = error.code === "library-too-large";
        const unsafeBrowser = error.code === "web-locks-unavailable";
        setTemplateStorageStatus(
          libraryTooLarge
            ? "Library too large to sync"
            : unsafeBrowser
              ? "Safe multi-tab sync unavailable"
            : "Could not save everywhere",
        );
        setWritingToolsStorageStatus(
          libraryTooLarge
            ? "Library too large to sync"
            : unsafeBrowser
              ? "Safe multi-tab sync unavailable"
            : "Could not save everywhere",
        );
        const keyRejected = error.status === 401 || error.status === 403;
        setWebSharedLibraryStatus(
          libraryTooLarge
            ? "Library too large to sync · browser changes preserved"
            : unsafeBrowser
              ? "Editing paused · safe tab coordination unavailable"
            : keyRejected
              ? "Owner key rejected · browser changes preserved"
              : "Could not save online · browser changes preserved",
        );
        setToast(
          libraryTooLarge
            ? "Library too large to sync; reduce reusable content and retry"
            : unsafeBrowser
              ? "Use current Chrome or Edge to edit this shared library"
            : keyRejected
              ? "Owner key rejected; update it and retry"
              : "Online save failed; browser changes are preserved",
        );
      })
      .finally(() => {
        if (webSharedLibrarySaveQueueRef.current === savePromise) {
          webSharedLibrarySavingRef.current = false;
          setWebLibrarySaving(false);
        }
      });
  }

  function saveWritingTools(
    nextQuicktexts: Quicktext[],
    nextVocabulary: VocabularyItem[],
  ) {
    if (!requireWebLibraryOwner()) return;
    const updatedAt = currentTimestamp();
    const payload: WritingToolsVaultPayload = {
      version: 1,
      updatedAt,
      quicktexts: nextQuicktexts,
      vocabulary: nextVocabulary,
    };
    writingToolsUpdatedAtRef.current = updatedAt;
    setQuicktexts(nextQuicktexts);
    setVocabulary(nextVocabulary);
    setWritingToolsReady(true);
    window.localStorage.setItem(
      storageKeys.quicktexts,
      JSON.stringify(nextQuicktexts),
    );
    window.localStorage.setItem(
      storageKeys.vocabulary,
      JSON.stringify(nextVocabulary),
    );
    window.localStorage.setItem(
      storageKeys.writingToolsUpdatedAt,
      String(updatedAt),
    );
    if (webEdition) {
      saveWebSharedLibrary(templates, nextQuicktexts, nextVocabulary, updatedAt);
      return;
    }
    setWritingToolsStorageStatus("Syncing to Documents...");
    void persistWritingToolsToDisk(payload)
      .then((result) => {
        writingToolsBaseRef.current = result.payload;
        writingToolsUpdatedAtRef.current = result.payload.updatedAt;
        setQuicktexts(result.payload.quicktexts);
        setVocabulary(result.payload.vocabulary);
        window.localStorage.setItem(
          storageKeys.quicktexts,
          JSON.stringify(result.payload.quicktexts),
        );
        window.localStorage.setItem(
          storageKeys.vocabulary,
          JSON.stringify(result.payload.vocabulary),
        );
        window.localStorage.setItem(
          storageKeys.writingToolsUpdatedAt,
          String(result.payload.updatedAt),
        );
        setWritingToolsStorageStatus(
          result.conflictCount > 0
            ? "Merged safely; conflicts preserved"
            : "Saved in OneDrive folder",
        );
        if (result.conflictCount > 0) {
          setSyncConflictNotice(result.message);
          setToast("Both computers' writing-tool changes were preserved");
        }
        void refreshSharedLibraryRef.current?.();
      })
      .catch(() => {
        setWritingToolsStorageStatus("Browser backup only");
        setToast("Writing tool saved in browser; shared copy needs the launcher");
      });
  }

  function saveQuicktexts(nextQuicktexts: Quicktext[]) {
    saveWritingTools(nextQuicktexts, vocabulary);
  }

  function openQuicktextForm(item: Quicktext | null = null) {
    if (!requireWebLibraryOwner()) return;
    setEditingQuicktext(item);
    setShowQuicktextForm(true);
  }

  function addQuicktext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const shortcut = String(data.get("shortcut") || "")
      .trim()
      .replace(/^\.*(?=.)/, ".");
    const title = String(data.get("title") || "").trim();
    const content = String(data.get("content") || "").trim();
    if (!shortcut || !title || !content) return;
    const normalizedShortcut = shortcut.startsWith(".")
      ? shortcut
      : `.${shortcut}`;
    if (editingQuicktext) {
      saveQuicktexts(
        quicktexts.map((item) =>
          item.id === editingQuicktext.id
            ? {
                ...item,
                shortcut: normalizedShortcut,
                title,
                content,
              }
            : item,
        ),
      );
    } else {
      saveQuicktexts([
        ...quicktexts,
        {
          id: `${currentTimestamp()}`,
          shortcut: normalizedShortcut,
          title,
          content,
          category: "Custom",
        },
      ]);
    }
    setShowQuicktextForm(false);
    setEditingQuicktext(null);
    setToast(editingQuicktext ? "Quicktext updated" : "Quicktext saved");
  }

  function deleteQuicktext(item: Quicktext) {
    if (!window.confirm(`Delete the "${item.title}" quicktext?`)) return;
    saveQuicktexts(quicktexts.filter((entry) => entry.id !== item.id));
    setShowQuicktextForm(false);
    setEditingQuicktext(null);
    setToast("Quicktext deleted");
  }

  function saveVocabulary(nextVocabulary: VocabularyItem[]) {
    saveWritingTools(quicktexts, nextVocabulary);
  }

  function openVocabularyForm(item: VocabularyItem | null = null) {
    if (!requireWebLibraryOwner()) return;
    setEditingVocabulary(item);
    setLearningHeard("");
    setShowVocabularyForm(true);
  }

  function openVoiceLearning() {
    if (!requireWebLibraryOwner()) return;
    if (!lastRecognizedPhrase) {
      setToast("Dictate a phrase first, then teach its correction");
      return;
    }
    setEditingVocabulary(null);
    setLearningHeard(lastRecognizedPhrase);
    setActivePanel("vocabulary");
    setShowVocabularyForm(true);
  }

  function saveVocabularyItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const heard = String(data.get("heard") || "").trim();
    const replacement = String(data.get("replacement") || "").trim();
    if (!heard || !replacement) return;

    if (editingVocabulary) {
      saveVocabulary(
        vocabulary.map((item) =>
          item.id === editingVocabulary.id
            ? { ...item, heard, replacement }
            : item,
        ),
      );
      setToast("Vocabulary term updated");
    } else {
      const existingTerm = vocabulary.find(
        (item) => item.heard.toLowerCase() === heard.toLowerCase(),
      );
      if (existingTerm) {
        saveVocabulary(
          vocabulary.map((item) =>
            item.id === existingTerm.id
              ? { ...item, heard, replacement }
              : item,
          ),
        );
        setToast(
          learningHeard
            ? "Voice correction updated"
            : "Vocabulary term updated",
        );
      } else {
        saveVocabulary([
          ...vocabulary,
          {
            id: `vocabulary-${currentTimestamp()}`,
            heard,
            replacement,
          },
        ]);
        setToast(
          learningHeard ? "Voice correction learned" : "Vocabulary term added",
        );
      }
    }

    setShowVocabularyForm(false);
    setEditingVocabulary(null);
    setLearningHeard("");
  }

  function deleteVocabularyItem(item: VocabularyItem) {
    if (!window.confirm(`Remove "${item.replacement}" from vocabulary?`)) {
      return;
    }
    saveVocabulary(vocabulary.filter((entry) => entry.id !== item.id));
    setShowVocabularyForm(false);
    setEditingVocabulary(null);
    setLearningHeard("");
    setToast("Vocabulary term removed");
  }

  function saveTemplates(nextTemplates: Template[]) {
    if (!requireWebLibraryOwner()) return;
    const serializedTemplates = JSON.stringify(nextTemplates);
    const updatedAt = currentTimestamp();
    const payload: TemplateVaultPayload = {
      version: 1,
      updatedAt,
      templates: nextTemplates,
    };
    templatesUpdatedAtRef.current = updatedAt;
    setTemplates(nextTemplates);
    window.localStorage.setItem(
      storageKeys.templatesBackup,
      serializedTemplates,
    );
    window.localStorage.setItem(storageKeys.templates, serializedTemplates);
    window.localStorage.setItem(
      storageKeys.templatesUpdatedAt,
      String(updatedAt),
    );
    if (webEdition) {
      saveWebSharedLibrary(nextTemplates, quicktexts, vocabulary, updatedAt);
      return;
    }
    setTemplateStorageStatus("Protecting templates...");
    void persistTemplatesToDisk(payload)
      .then((result) => {
        templateBaseRef.current = result.payload;
        templatesUpdatedAtRef.current = result.payload.updatedAt;
        const reconciledTemplates = JSON.stringify(result.payload.templates);
        setTemplates(result.payload.templates);
        window.localStorage.setItem(
          storageKeys.templates,
          reconciledTemplates,
        );
        window.localStorage.setItem(
          storageKeys.templatesBackup,
          reconciledTemplates,
        );
        window.localStorage.setItem(
          storageKeys.templatesUpdatedAt,
          String(result.payload.updatedAt),
        );
        setTemplateStorageStatus(
          result.conflictCount > 0
            ? "Merged safely; conflicts preserved"
            : "Saved in OneDrive folder",
        );
        if (result.conflictCount > 0) {
          setSyncConflictNotice(result.message);
          setToast("Both computers' template changes were preserved");
        }
        void refreshSharedLibraryRef.current?.();
      })
      .catch(() => {
        setTemplateStorageStatus("Browser backup only");
        setToast("Template saved in browser; durable backup needs the launcher");
      });
  }

  function openTemplateForm(template: Template | null = null) {
    if (!requireWebLibraryOwner()) return;
    setEditingTemplate(template);
    templateSelectionRef.current = null;
    setShowTemplateForm(true);
  }

  function rememberTemplateSelection() {
    const editor = templateEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      templateSelectionRef.current = range.cloneRange();
    }
  }

  function applyTemplateFormatting(command: "bold" | "underline") {
    const editor = templateEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) return;

    if (
      templateSelectionRef.current &&
      editor.contains(templateSelectionRef.current.commonAncestorContainer)
    ) {
      selection.removeAllRanges();
      selection.addRange(templateSelectionRef.current);
    }

    editor.focus();
    document.execCommand(command, false);
    rememberTemplateSelection();
  }

  function insertTemplateField(field: PdfFieldToken) {
    const editor = templateEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) return;

    if (
      templateSelectionRef.current &&
      editor.contains(templateSelectionRef.current.commonAncestorContainer)
    ) {
      selection.removeAllRanges();
      selection.addRange(templateSelectionRef.current);
    } else {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    editor.focus();
    document.execCommand("insertText", false, field);
    rememberTemplateSelection();
  }

  function handleTemplateEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "b" && key !== "u") return;
    event.preventDefault();
    applyTemplateFormatting(key === "b" ? "bold" : "underline");
  }

  function pastePlainTextIntoTemplate(
    event: React.ClipboardEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    document.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
    rememberTemplateSelection();
  }

  function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") || "").trim();
    const type = String(data.get("type") || "").trim();
    const description = String(data.get("description") || "").trim();
    const content = (
      templateEditorRef.current?.innerText.replace(/\u00a0/g, " ") || ""
    ).trim();
    const contentHtml = sanitizeTemplateHtml(
      templateEditorRef.current?.innerHTML.trim() || plainTextToHtml(content),
    );
    if (!name || !type || !description || !content) {
      setToast("Complete every template field");
      return;
    }

    if (editingTemplate) {
      saveTemplates(
        templates.map((template) =>
          template.id === editingTemplate.id
            ? { ...template, name, type, description, content, contentHtml }
            : template,
        ),
      );
      setToast("Template updated");
    } else {
      saveTemplates([
        ...templates,
        {
          id: `template-${currentTimestamp()}`,
          name,
          type,
          description,
          content,
          contentHtml,
        },
      ]);
      setToast("Template created");
    }

    setShowTemplateForm(false);
    setEditingTemplate(null);
    templateSelectionRef.current = null;
  }

  function duplicateTemplate(template: Template) {
    const duplicate = {
      ...template,
      id: `template-${currentTimestamp()}`,
      name: `${template.name} copy`,
    };
    saveTemplates([...templates, duplicate]);
    setEditingTemplate(duplicate);
    setToast("Template duplicated");
  }

  function deleteTemplate(template: Template) {
    if (!window.confirm(`Delete the "${template.name}" template?`)) return;
    saveTemplates(templates.filter((item) => item.id !== template.id));
    setShowTemplateForm(false);
    setEditingTemplate(null);
    setToast("Template deleted");
  }

  async function copyNote() {
    const safeNoteHtml = sanitizeTemplateHtml(
      noteHtml || plainTextToHtml(note),
    );
    try {
      if ("ClipboardItem" in window && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([note], {
              type: "text/plain;charset=utf-8",
            }),
            "text/html": new Blob([safeNoteHtml], {
              type: "text/html;charset=utf-8",
            }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(note);
      }
    } catch {
      await navigator.clipboard.writeText(note);
    }
    setNoteCopied(true);
    setToast("Note copied to clipboard");
  }

  function newNote() {
    const warning = noteCopied
      ? "Start a new note? Your current note will be cleared."
      : "This note has not been copied. Start a new note and discard it?";
    if (note.trim() && !window.confirm(warning)) {
      return;
    }
    stopRecording();
    whisperSessionRef.current += 1;
    setEditorText("");
    setElapsed(0);
    setPdfMeasurements(null);
    setPdfStatus("Choose a PDF to extract intake and sleep fields");
    setPapPdfStatus("Choose a PAP compliance PDF to prepare .cpap");
    setHstStatus("Paste HST results to prepare .hst");
    setHstPasteText("");
    setShowHstPaste(false);
    setLastRecognizedPhrase("");
    setLearningHeard("");
    legacyPatientDataStorageKeys.forEach((key) =>
      window.localStorage.removeItem(key),
    );
    window.requestAnimationFrame(() => noteRef.current?.focus());
  }

  function saveWebLibraryOwnerKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ownerKey = String(data.get("ownerKey") || "").trim();
    if (!ownerKey) return;
    window.localStorage.setItem(storageKeys.webLibraryOwnerKey, ownerKey);
    webLibraryOwnerKeyRef.current = ownerKey;
    setWebLibraryOwnerKey(ownerKey);
    setWebSharedLibraryStatus(
      webSharedLibraryDirtyRef.current
        ? "Owner access saved · local changes ready to retry"
        : "Owner access enabled",
    );
    setToast("Owner access saved only on this browser");
  }

  function forgetWebLibraryOwnerKey() {
    window.localStorage.removeItem(storageKeys.webLibraryOwnerKey);
    webLibraryOwnerKeyRef.current = "";
    setWebLibraryOwnerKey("");
    setWebSharedLibraryStatus("View only · owner key required to edit");
    setToast("Owner access removed from this browser");
  }

  function retryWebLibrarySave() {
    const payload = webSharedLibraryLocalRef.current;
    if (!payload || !requireWebLibraryOwner()) return;
    saveWebSharedLibrary(
      payload.templates,
      payload.quicktexts,
      payload.vocabulary,
      Math.max(currentTimestamp(), payload.updatedAt + 1),
    );
  }

  function exportWebLibrary() {
    const payload = webSharedLibraryLocalRef.current;
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `scribeflow-library-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast("Reusable library exported");
  }

  async function importWebLibrary(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !requireWebLibraryOwner()) return;
    try {
      const imported = parseWebSharedLibraryPayload(await file.text());
      if (!imported) throw new Error("Invalid library backup");
      const payload = { ...imported, updatedAt: currentTimestamp() };
      rememberWebLibrarySnapshot(
        webSharedLibraryLocalRef.current || payload,
        "Before library import",
      );
      saveWebSharedLibrary(
        payload.templates,
        payload.quicktexts,
        payload.vocabulary,
        payload.updatedAt,
      );
      setToast("Imported library is being synced");
    } catch {
      setToast("That file is not a valid ScribeFlow library backup");
    }
  }

  function restoreWebLibrarySnapshot(snapshot: WebLibrarySnapshot) {
    if (!requireWebLibraryOwner()) return;
    if (!window.confirm("Restore this reusable library snapshot?")) return;
    const payload = { ...snapshot.payload, updatedAt: currentTimestamp() };
    saveWebSharedLibrary(
      payload.templates,
      payload.quicktexts,
      payload.vocabulary,
      payload.updatedAt,
    );
    setToast("Snapshot restored and queued to sync");
  }

  function changeDictationEngine(event: ChangeEvent<HTMLSelectElement>) {
    const nextEngine = event.currentTarget.value as DictationEngine;
    if (nextEngine !== "whisper" && nextEngine !== "chrome") return;
    stopMicrophoneTest(false);
    setDictationEngine(nextEngine);
    window.localStorage.setItem(storageKeys.dictationEngine, nextEngine);
    setStatus(
      nextEngine === "whisper"
        ? whisperReady
          ? "Ready · Whisper local"
          : "Loading local Whisper model"
        : "Ready · Chrome offline",
    );
  }

  function changeMicrophone(event: ChangeEvent<HTMLSelectElement>) {
    const microphoneId = event.currentTarget.value;
    stopMicrophoneTest(false);
    setSelectedMicrophoneId(microphoneId);
    window.localStorage.setItem(storageKeys.microphoneId, microphoneId);
    const selectedMicrophone = microphones.find(
      (microphone) => microphone.deviceId === microphoneId,
    );
    setToast(
      microphoneId === "default"
        ? "Using the system default microphone"
        : `Microphone selected: ${selectedMicrophone?.label || "Input device"}`,
    );
  }

  const clampDockPosition = useCallback((position: DockPosition) => {
    const dock = dockRef.current;
    const width = dock?.offsetWidth || (dockCollapsed ? 154 : 820);
    const height = dock?.offsetHeight || (dockCollapsed ? 68 : 100);
    return {
      x: Math.max(8, Math.min(position.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - height - 8)),
    };
  }, [dockCollapsed]);

  function beginDockDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const dock = dockRef.current;
    if (!dock) return;
    const rectangle = dock.getBoundingClientRect();
    const startingPosition = {
      x: rectangle.left,
      y: rectangle.top,
    };
    dockDragRef.current = {
      offsetX: event.clientX - rectangle.left,
      offsetY: event.clientY - rectangle.top,
      latest: startingPosition,
    };
    setDockPosition(startingPosition);
    setDockDragging(true);
    event.preventDefault();
  }

  useEffect(() => {
    if (!dockDragging) return;
    const moveDock = (event: PointerEvent) => {
      const drag = dockDragRef.current;
      if (!drag) return;
      const next = clampDockPosition({
        x: event.clientX - drag.offsetX,
        y: event.clientY - drag.offsetY,
      });
      drag.latest = next;
      setDockPosition(next);
    };
    const finishDockDrag = () => {
      const finalPosition = dockDragRef.current?.latest;
      dockDragRef.current = null;
      setDockDragging(false);
      if (finalPosition) {
        window.localStorage.setItem(
          storageKeys.dictationDockPosition,
          JSON.stringify(finalPosition),
        );
      }
    };
    window.addEventListener("pointermove", moveDock);
    window.addEventListener("pointerup", finishDockDrag, { once: true });
    window.addEventListener("pointercancel", finishDockDrag, { once: true });
    return () => {
      window.removeEventListener("pointermove", moveDock);
      window.removeEventListener("pointerup", finishDockDrag);
      window.removeEventListener("pointercancel", finishDockDrag);
    };
  }, [clampDockPosition, dockDragging]);

  useEffect(() => {
    if (!hasCustomDockPosition) return;
    const keepDockVisible = () => {
      setDockPosition((current) => {
        if (!current) return current;
        const next = clampDockPosition(current);
        if (next.x === current.x && next.y === current.y) return current;
        window.localStorage.setItem(
          storageKeys.dictationDockPosition,
          JSON.stringify(next),
        );
        return next;
      });
    };
    const frame = window.requestAnimationFrame(keepDockVisible);
    window.addEventListener("resize", keepDockVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepDockVisible);
    };
  }, [clampDockPosition, dockCollapsed, hasCustomDockPosition]);

  function toggleDockCollapsed() {
    const next = !dockCollapsed;
    setDockCollapsed(next);
    window.localStorage.setItem(
      storageKeys.dictationDockCollapsed,
      String(next),
    );
  }

  function resetDockPosition() {
    setDockPosition(null);
    setDockCollapsed(true);
    window.localStorage.removeItem(storageKeys.dictationDockPosition);
    window.localStorage.setItem(storageKeys.dictationDockCollapsed, "true");
    setToast("Microphone returned beside the ScribeFlow name");
  }

  const refreshSystemCheck = useCallback(async () => {
    setSystemCheckRefreshing(true);
    try {
      await Promise.all([
        refreshWhisperInstallStatus(),
        refreshMicrophones(),
        refreshSharedLibraryRef.current?.(false) ?? Promise.resolve(),
      ]);
      setToast("System check refreshed");
    } finally {
      setSystemCheckRefreshing(false);
    }
  }, [refreshMicrophones, refreshWhisperInstallStatus]);

  const wordCount = note.trim() ? note.trim().split(/\s+/).length : 0;
  const activeEngineSupported =
    dictationEngine === "whisper"
      ? whisperSupported && whisperReady
      : speechSupported;
  const selectedMicrophoneLabel =
    selectedMicrophoneId === "default"
      ? "System default"
      : microphones.find(
          (microphone) => microphone.deviceId === selectedMicrophoneId,
        )?.label || "Selected microphone";
  const sharedLibraryReady = Boolean(
    sharedStorageStatus?.templates.exists &&
      sharedStorageStatus.writingTools.exists,
  );
  const systemIssueCount =
    (whisperInstallStatus.installed ? 0 : 1) +
    (microphones.length > 0 ? 0 : 1) +
    (sharedStorageStatus?.oneDrive ? 0 : 1) +
    (sharedLibraryReady ? 0 : 1);
  const dockStyle = dockPosition
    ? {
        left: `${dockPosition.x}px`,
        top: `${dockPosition.y}px`,
        bottom: "auto",
        transform: "none",
      }
    : undefined;

  useEffect(() => {
    const whisperUpdateOpen =
      !webEdition &&
      whisperInstallStatus.status === "update_available" &&
      !whisperUpdatePromptDismissed;
    const dialogOpen =
      showWebLibraryManager ||
      showTemplateForm ||
      showQuicktextForm ||
      showVocabularyForm ||
      showHstPaste ||
      showSystemCheck ||
      showSyncDashboard ||
      whisperUpdateOpen;
    if (!dialogOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(
      ".modal-backdrop [role='dialog']",
    );
    if (!dialog) return;
    const focusableSelector =
      "button:not([disabled]), input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusFirstControl = () => {
      if (dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
      if (!dialog.contains(document.activeElement)) {
        dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
      }
    };
    const animationFrame = window.requestAnimationFrame(focusFirstControl);
    const handleDialogKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (showWebLibraryManager) setShowWebLibraryManager(false);
        else if (showTemplateForm) {
          setShowTemplateForm(false);
          setEditingTemplate(null);
          templateSelectionRef.current = null;
        } else if (showQuicktextForm) {
          setShowQuicktextForm(false);
          setEditingQuicktext(null);
        } else if (showVocabularyForm) {
          setShowVocabularyForm(false);
          setEditingVocabulary(null);
          setLearningHeard("");
        } else if (showHstPaste) {
          setHstPasteText("");
          setShowHstPaste(false);
        }
        else if (showSystemCheck) setShowSystemCheck(false);
        else if (showSyncDashboard) setShowSyncDashboard(false);
        else if (whisperUpdateOpen) setWhisperUpdatePromptDismissed(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", handleDialogKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [
    showHstPaste,
    showQuicktextForm,
    showSyncDashboard,
    showSystemCheck,
    showTemplateForm,
    showVocabularyForm,
    showWebLibraryManager,
    whisperInstallStatus.status,
    whisperUpdatePromptDismissed,
  ]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!note.trim() || noteCopied) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [note, noteCopied]);

  if (webEdition && isFramed) {
    return (
      <main className="frame-blocked-page">
        <section className="frame-blocked-card" role="alert">
          <span aria-hidden="true">S</span>
          <h1>ScribeFlow cannot run inside another site</h1>
          <p>
            For privacy and clickjacking protection, open ScribeFlow directly
            in its own browser tab or window.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${webEdition ? "web-edition" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <div>
            <strong>{webEdition ? "ScribeFlow Web" : "ScribeFlow"}</strong>
            <span>
              {webEdition ? "Clinical notes · Dragon ready" : "Clinical dictation"}
            </span>
          </div>
        </div>
        <div className="privacy-badge">
          <span className="privacy-dot" aria-hidden="true" />
          {webEdition
            ? "ScribeFlow itself does not upload clinical content"
            : "Local only — nothing leaves this device"}
        </div>
        <div className="top-actions">
          {webEdition ? (
            <div className="dragon-ready-badge" aria-label="Ready for Dragon dictation">
              <span aria-hidden="true">D</span>
              <div>
                <strong>Dragon ready</strong>
                <small>Dictate into the note</small>
              </div>
            </div>
          ) : (
            <>
          <label
            className="topbar-microphone-picker"
            title="Microphone used for local dictation"
          >
            <span>Mic</span>
            <select
              value={selectedMicrophoneId}
              onChange={changeMicrophone}
              disabled={isRecording}
              aria-label="Top bar microphone selection"
            >
              <option value="default">System default</option>
              {microphones
                .filter((microphone) => microphone.deviceId !== "default")
                .map((microphone) => (
                  <option value={microphone.deviceId} key={microphone.deviceId}>
                    {microphone.label}
                  </option>
                ))}
            </select>
          </label>
          <button
            className={`sync-status-button system-status-button ${
              systemIssueCount > 0 ? "has-attention" : ""
            }`}
            type="button"
            onClick={() => {
              setShowSystemCheck(true);
              void refreshSystemCheck();
            }}
            aria-haspopup="dialog"
            aria-label="Open system check"
          >
            <span className="system-status-icon" aria-hidden="true">
              {systemIssueCount > 0 ? "!" : "✓"}
            </span>
            <span>
              <strong>System check</strong>
              <small>{systemIssueCount > 0 ? "Needs attention" : "Ready"}</small>
            </span>
          </button>
          <button
            className={`sync-status-button ${
              sharedStorageStatus &&
              sharedStorageStatus.templates.conflicts +
                sharedStorageStatus.writingTools.conflicts >
                0
                ? "has-conflicts"
                : ""
            }`}
            type="button"
            onClick={() => setShowSyncDashboard(true)}
            aria-haspopup="dialog"
            aria-label="Open shared library status"
          >
            <span className="sync-status-icon" aria-hidden="true" />
            <span>
              <strong>Shared library</strong>
              <small>
                {sharedStorageStatus?.oneDrive
                  ? "OneDrive folder"
                  : "Check sync"}
              </small>
            </span>
          </button>
            </>
          )}
          <button className="button subtle" type="button" onClick={newNote}>
            <span aria-hidden="true">＋</span> New note
          </button>
          {note.trim() && (
            <span
              className={`copy-status ${noteCopied ? "copied" : "pending"}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true">{noteCopied ? "✓" : "•"}</span>
              {noteCopied ? "Copied" : "Not copied"}
            </span>
          )}
          <button
            className="button primary"
            type="button"
            onClick={copyNote}
            disabled={!note.trim()}
          >
            Copy note
          </button>
        </div>
      </header>

      {!webEdition &&
        dictationEngine === "whisper" &&
        (!whisperReady ||
          whisperInstallStatus.status === "update_available") && (
          <section
            className={`whisper-setup-banner ${whisperInstallStatus.status}`}
            aria-live="polite"
          >
            <div>
              <strong>
                {whisperInstallStatus.status === "installing"
                  ? "Installing Whisper on this computer"
                  : whisperInstallStatus.status === "starting"
                    ? "Starting Whisper"
                    : whisperInstallStatus.status === "update_available"
                      ? "Whisper update available"
                      : whisperInstallStatus.installed
                        ? "Whisper needs attention"
                        : "Whisper is recommended"}
              </strong>
              <span>{whisperInstallStatus.message}</span>
            </div>
            {!whisperInstallStatus.installed &&
              whisperInstallStatus.status !== "installing" &&
              whisperInstallStatus.status !== "starting" &&
              whisperInstallStatus.status !== "checking" && (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void installWhisper()}
                >
                  {whisperInstallStatus.status === "failed"
                    ? "Try Whisper install again"
                    : "Install Whisper"}
                </button>
              )}
            {whisperInstallStatus.installed &&
              whisperInstallStatus.status === "installed" && (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void installWhisper()}
                >
                  Repair or update Whisper
                </button>
              )}
            {whisperInstallStatus.status === "update_available" && (
              <button
                className="button primary"
                type="button"
                onClick={() => void installWhisper()}
              >
                Update Whisper
              </button>
            )}
            {(whisperInstallStatus.status === "installing" ||
              whisperInstallStatus.status === "starting") && (
              <span className="whisper-install-spinner" aria-hidden="true" />
            )}
          </section>
        )}

      <div className="workspace">
        <aside className="library-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Your library</p>
              <h2>Writing tools</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label={
                activePanel === "quicktext"
                  ? "Create quicktext"
                  : activePanel === "templates"
                    ? "Create template"
                    : "Add vocabulary term"
              }
              title={
                activePanel === "quicktext"
                  ? "Create quicktext"
                  : activePanel === "templates"
                    ? "Create template"
                    : "Add vocabulary term"
              }
              onClick={() =>
                activePanel === "quicktext"
                  ? openQuicktextForm()
                  : activePanel === "templates"
                    ? openTemplateForm()
                    : openVocabularyForm()
              }
              disabled={webEdition && !webLibraryOwnerKey}
            >
              +
            </button>
          </div>

          {webEdition && (
            <div className="web-shared-library-bar">
              <div className="web-shared-library-copy">
                <span className="web-shared-library-icon" aria-hidden="true">
                  ↻
                </span>
                <span>
                  <strong>Shared across computers</strong>
                  <small>{webSharedLibraryStatus}</small>
                </span>
              </div>
              <div className="web-shared-library-actions">
                <button
                  className="web-library-refresh-button"
                  type="button"
                  onClick={() => void refreshSharedLibraryRef.current?.(true)}
                  disabled={syncRefreshing}
                >
                  {syncRefreshing ? "Checking…" : "Check"}
                </button>
                <button
                  className="web-library-refresh-button"
                  type="button"
                  onClick={() => setShowWebLibraryManager(true)}
                  aria-haspopup="dialog"
                >
                  {webLibraryOwnerKey ? "Owner + backups" : "Owner setup"}
                </button>
              </div>
              <p className="web-shared-library-warning">
                Reusable library fields are stored online. Never put PHI in
                templates, Quicktext, vocabulary, names, or descriptions.
              </p>
            </div>
          )}

          <div className="segmented-control" aria-label="Library view">
            <button
              type="button"
              className={activePanel === "templates" ? "active" : ""}
              onClick={() => setActivePanel("templates")}
            >
              Templates
            </button>
            <button
              type="button"
              className={activePanel === "quicktext" ? "active" : ""}
              onClick={() => setActivePanel("quicktext")}
            >
              Quicktext
            </button>
            <button
              type="button"
              className={activePanel === "vocabulary" ? "active" : ""}
              onClick={() => setActivePanel("vocabulary")}
            >
              Vocabulary
            </button>
          </div>

          <label className="search-box" htmlFor="library-search">
            <span aria-hidden="true">⌕</span>
            <input
              id="library-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search library"
              aria-keyshortcuts="Control+K"
            />
            <kbd>Ctrl K</kbd>
          </label>

          <div className="library-list">
            {activePanel === "quicktext" ? (
              <>
                <div className="list-meta">
                  <span>
                    {writingToolsReady
                      ? `${filteredQuicktexts.length} snippets`
                      : "Loading Quicktext"}
                  </span>
                  <span>{writingToolsStorageStatus}</span>
                </div>
                {filteredQuicktexts.map((item) => (
                  <div className="quicktext-library-card" key={item.id}>
                    <button
                      className="library-item quicktext-item"
                      type="button"
                      onClick={() => expandQuicktext(item)}
                    >
                      <span className="item-topline">
                        <code>{item.shortcut}</code>
                        <span className="category">{item.category}</span>
                      </span>
                      <strong>{item.title}</strong>
                      <span className="snippet-preview">{item.content}</span>
                    </button>
                    <button
                      className="quicktext-edit-button"
                      type="button"
                      onClick={() => openQuicktextForm(item)}
                      aria-label={`Edit ${item.title}`}
                      disabled={webEdition && !webLibraryOwnerKey}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </>
            ) : activePanel === "templates" ? (
              <>
                <div className="list-meta">
                  <span>
                    {templatesReady
                      ? `${filteredTemplates.length} templates`
                      : "Loading templates"}
                  </span>
                  <span>{templateStorageStatus}</span>
                </div>
                {!templatesReady ? (
                  <div className="vocabulary-empty">
                    <strong>Restoring your templates</strong>
                    <span>Checking the protected copy on this PC.</span>
                  </div>
                ) : filteredTemplates.map((template) => (
                  <div className="template-library-card" key={template.id}>
                    <button
                      className="library-item template-item"
                      type="button"
                      onClick={() => applyTemplate(template)}
                    >
                      <span className="template-glyph" aria-hidden="true">
                        {template.name.slice(0, 1)}
                      </span>
                      <span>
                        <span className="item-topline">
                          <strong>{template.name}</strong>
                          <span className="category">{template.type}</span>
                        </span>
                        <span className="snippet-preview">
                          {template.description}
                        </span>
                      </span>
                    </button>
                    <button
                      className="template-edit-button"
                      type="button"
                      onClick={() => openTemplateForm(template)}
                      aria-label={`Edit ${template.name}`}
                      disabled={webEdition && !webLibraryOwnerKey}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="list-meta">
                  <span>
                    {writingToolsReady
                      ? `${filteredVocabulary.length} terms`
                      : "Loading vocabulary"}
                  </span>
                  <span>{writingToolsStorageStatus}</span>
                </div>
                {filteredVocabulary.length === 0 ? (
                  <div className="vocabulary-empty">
                    <strong>No custom terms yet</strong>
                    <span>
                      Add specialty names, medications, procedures, or acronyms.
                    </span>
                  </div>
                ) : (
                  filteredVocabulary.map((item) => (
                    <button
                      className="library-item vocabulary-item"
                      type="button"
                      key={item.id}
                      onClick={() => openVocabularyForm(item)}
                      aria-label={`Edit vocabulary ${item.replacement}`}
                      disabled={webEdition && !webLibraryOwnerKey}
                    >
                      <span className="vocabulary-heard">
                        Heard: <code>{item.heard}</code>
                      </span>
                      <span className="vocabulary-arrow" aria-hidden="true">
                        ↓
                      </span>
                      <strong>{item.replacement}</strong>
                    </button>
                  ))
                )}
              </>
            )}
          </div>

          <div className="library-tip">
            <span className="tip-icon" aria-hidden="true">
              i
            </span>
            {activePanel === "quicktext" ? (
              <p>
                Type <code>.normalexam</code> then press space to expand it
                inside your note.
              </p>
            ) : activePanel === "templates" ? (
              <p>
                Choose a template to start a note, select <strong>Edit</strong>{" "}
                to manage it, or use <strong>+</strong> to create one.
              </p>
            ) : (
              <p>
                Add what speech recognition may hear and the exact specialty
                term that should replace it.
              </p>
            )}
          </div>
        </aside>

        <section className="note-panel">
          <div className="encounter-strip">
            <span>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date())}</span>
            <span className="divider" />
            <span>{wordCount} words</span>
          </div>

          {webEdition && (
            <div className="web-clinical-privacy-notice" role="note">
              ScribeFlow itself does not upload note or PDF content. Dragon,
              browser and writing-assistant settings, and clipboard or OS sync
              are external and follow their own privacy controls.
            </div>
          )}

          <div className="format-toolbar" aria-label="Text formatting">
            <span>Format</span>
            <button
              type="button"
              className={activeFormats.bold ? "active" : ""}
              aria-label="Bold"
              aria-pressed={activeFormats.bold}
              title="Bold (Ctrl+B)"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormatting("bold")}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className={activeFormats.underline ? "active" : ""}
              aria-label="Underline"
              aria-pressed={activeFormats.underline}
              title="Underline (Ctrl+U)"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormatting("underline")}
            >
              <u>U</u>
            </button>
            <span className="format-help">Select text, then choose a style</span>
          </div>

          <div className="pdf-import-row" aria-label="PDF imports">
            <span className="pdf-import-label">Import</span>
            <button
              className={`pdf-import-button ${isScanningPdf ? "disabled" : ""}`}
              type="button"
              onClick={() => void choosePdf()}
              disabled={isScanningPdf}
            >
              <span aria-hidden="true">PDF</span>
              {isScanningPdf ? "Scanning..." : "Intake PDF"}
            </button>
            <input
              ref={pdfInputRef}
              className="pdf-fallback-input"
              type="file"
              accept="application/pdf,.pdf"
              onChange={handlePdfUpload}
              disabled={isScanningPdf}
            />
            <button
              className={`pdf-import-button ${isScanningPdf ? "disabled" : ""}`}
              type="button"
              onClick={() => void choosePdf("cpap")}
              disabled={isScanningPdf}
            >
              <span aria-hidden="true">PAP</span>
              {isScanningPdf ? "Scanning..." : "PAP PDF"}
            </button>
            <input
              ref={papPdfInputRef}
              className="pdf-fallback-input"
              type="file"
              accept="application/pdf,.pdf"
              onChange={handlePapPdfUpload}
              disabled={isScanningPdf}
            />
            <button
              className="pdf-import-button"
              type="button"
              onClick={() => {
                setHstPasteText("");
                setShowHstPaste(true);
              }}
            >
              <span aria-hidden="true">HST</span>
              Paste HST
            </button>
            {!webEdition && (
              <label
                className="pdf-delete-option"
                title="Permanently delete the selected original PDF only after a successful import"
              >
                <input
                  type="checkbox"
                  checked={deletePdfAfterScan}
                  onChange={(event) =>
                    setDeletePdfAfterScan(event.target.checked)
                  }
                  disabled={isScanningPdf}
                />
                Delete after import
              </label>
            )}
            <span className="pdf-import-live" role="status" aria-live="polite">
              {pdfStatus}. {papPdfStatus}. {hstStatus}.
            </span>
          </div>

          <div className="editor-wrap">
            {!note && !interimText && (
              <div className="empty-state" aria-hidden="true">
                <span className="empty-symbol">“</span>
                <h3>
                  {webEdition
                    ? "Dictate with Dragon or choose a template"
                    : "Start dictating or choose a template"}
                </h3>
                <p>
                  {webEdition
                    ? "Click the note, then use Dragon normally. You can also type or paste text."
                    : "Your note appears here as you speak. You can edit it at any time."}
                </p>
              </div>
            )}
            <div
              ref={noteRef}
              className="note-editor"
              contentEditable
              suppressContentEditableWarning
              onInput={() => {
                syncEditorState();
                updateEditorSelectionState();
              }}
              onKeyDown={handleNoteKeyDown}
              onKeyUp={updateEditorSelectionState}
              onMouseUp={updateEditorSelectionState}
              onBlur={rememberSelection}
              onPaste={(event) => {
                event.preventDefault();
                insertEditorText(event.clipboardData.getData("text/plain"));
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              data-lt-active="false"
              data-ms-editor="false"
              role="textbox"
              aria-multiline="true"
              aria-label="Clinical note editor"
            />
            {interimText && (
              <div className="interim-transcript" aria-live="polite">
                <span className="interim-label">
                  <i aria-hidden="true" />
                  Live dictation
                </span>
                <span>{interimText}</span>
              </div>
            )}
            {matchingSuggestions.length > 0 && (
              <div className="quicktext-suggestions" role="listbox">
                <p>Quicktext suggestions</p>
                {matchingSuggestions.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => expandQuicktext(item)}
                  >
                    <code>{item.shortcut}</code>
                    <span>{item.title}</span>
                    {index === 0 && <kbd>Tab</kbd>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!webEdition && (
            <div
              ref={dockRef}
            className={`dictation-dock ${isRecording ? "recording" : ""} ${
              dockCollapsed ? "collapsed" : "expanded"
            } ${dockPosition ? "custom-position" : ""} ${
              dockDragging ? "dragging" : ""
            }`}
            style={dockStyle}
            aria-label="Persistent dictation controls"
          >
            <button
              className="dock-drag-handle"
              type="button"
              onPointerDown={beginDockDrag}
              aria-label="Move dictation controls"
              title="Drag to move"
            >
              <span aria-hidden="true">•••</span>
            </button>
            <button
              className="dock-collapse-button"
              type="button"
              onClick={toggleDockCollapsed}
              aria-expanded={!dockCollapsed}
              aria-label={
                dockCollapsed
                  ? "Show full dictation controls"
                  : "Collapse dictation controls"
              }
              title={dockCollapsed ? "Show controls" : "Collapse controls"}
            >
              <span aria-hidden="true">{dockCollapsed ? "＋" : "−"}</span>
            </button>

            {dockCollapsed ? (
              <>
                <button
                  className="record-button"
                  type="button"
                  onClick={toggleRecording}
                  aria-pressed={isRecording}
                  aria-label={isRecording ? "Stop dictation" : "Start dictation"}
                  title="Start or stop dictation (`)"
                  disabled={!activeEngineSupported}
                >
                  <span className="mic-shape" aria-hidden="true" />
                </button>
                <div className="collapsed-dictation-info">
                  <strong>{formatDuration(elapsed)}</strong>
                  <span>
                    <i className="status-dot" aria-hidden="true" />
                    {isRecording
                      ? "Listening"
                      : activeEngineSupported
                        ? "Ready"
                        : "Setup"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="dictation-state">
                  <span className="status-dot" aria-hidden="true" />
                  <div>
                    <strong>{status}</strong>
                    <span>
                      {isRecording
                        ? dictationEngine === "whisper"
                          ? "Audio is processed in memory on this computer"
                          : "Speak naturally — punctuation is editable"
                        : activeEngineSupported
                          ? dictationEngine === "whisper"
                            ? whisperReady
                              ? "Whisper Large-v3 unquantized · native CUDA · no API"
                              : "Connecting to native Large-v3"
                            : "Chrome offline speech pack"
                          : "Selected engine is unavailable in this browser"}
                    </span>
                    <label className="dictation-device-picker">
                      <span>Engine</span>
                      <select
                        value={dictationEngine}
                        onChange={changeDictationEngine}
                        disabled={isRecording}
                        aria-label="Dictation engine"
                      >
                        <option value="whisper">
                          Whisper Large-v3 (local)
                        </option>
                        <option value="chrome">Chrome offline</option>
                      </select>
                    </label>
                    <div className="dictation-device-picker microphone-test-picker">
                      <span>Mic</span>
                      <span
                        className="selected-microphone-name"
                        title={selectedMicrophoneLabel}
                      >
                        {selectedMicrophoneLabel}
                      </span>
                      <button
                        className="microphone-test-button"
                        type="button"
                        onClick={() =>
                          microphoneTestState === "testing"
                            ? stopMicrophoneTest(true)
                            : void startMicrophoneTest()
                        }
                        disabled={isRecording}
                        aria-label={
                          microphoneTestState === "testing"
                            ? "Stop microphone test"
                            : "Test microphone"
                        }
                        title="Test microphone"
                      >
                        {microphoneTestState === "testing" ? "■" : "Test"}
                      </button>
                    </div>
                    {microphoneTestState !== "idle" && (
                      <div className={`microphone-test-inline ${microphoneTestState}`}>
                        <span className="microphone-level" aria-hidden="true">
                          <i style={{ width: `${microphoneLevel}%` }} />
                        </span>
                        <span>{microphoneTestMessage}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="waveform" aria-hidden="true">
                  {[13, 24, 38, 22, 45, 31, 19, 39, 27, 15].map(
                    (height, index) => (
                      <i
                        key={index}
                        style={{
                          height: `${height}px`,
                          animationDelay: `${index * 80}ms`,
                        }}
                      />
                    ),
                  )}
                </div>
                <button
                  className="record-button"
                  type="button"
                  onClick={toggleRecording}
                  aria-pressed={isRecording}
                  aria-label={isRecording ? "Stop dictation" : "Start dictation"}
                  title="Start or stop dictation (`)"
                  disabled={!activeEngineSupported}
                >
                  <span className="mic-shape" aria-hidden="true" />
                </button>
                <div className="record-time">
                  <strong>{formatDuration(elapsed)}</strong>
                  <span>
                    <kbd>`</kbd> Start / stop
                  </span>
                  <button
                    className="voice-learning-button"
                    type="button"
                    onClick={openVoiceLearning}
                    disabled={!lastRecognizedPhrase || isRecording}
                    title={
                      isRecording
                        ? "Stop dictation before teaching a correction"
                        : lastRecognizedPhrase
                          ? `Teach a correction for: ${lastRecognizedPhrase}`
                          : "Dictate a phrase first"
                    }
                  >
                    Teach last phrase
                  </button>
                </div>
              </>
            )}
            </div>
          )}
        </section>
      </div>

      {!webEdition &&
        whisperInstallStatus.status === "update_available" &&
        !whisperUpdatePromptDismissed && (
          <div className="modal-backdrop" role="presentation">
            <div
              className="modal-card whisper-update-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="whisper-update-title"
            >
              <div className="modal-heading">
                <div>
                  <p className="eyebrow">Local speech recognition</p>
                  <h2 id="whisper-update-title">Update Whisper?</h2>
                </div>
              </div>
              <p>
                A newer verified Whisper component is available. ScribeFlow
                will download only the files that changed, verify them, and
                restart local dictation. No audio or patient data is uploaded.
              </p>
              <div className="modal-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => setWhisperUpdatePromptDismissed(true)}
                >
                  No, not now
                </button>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void installWhisper()}
                >
                  Yes, update Whisper
                </button>
              </div>
            </div>
          </div>
        )}

      {!webEdition && showSystemCheck && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card system-check-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="system-check-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">This computer</p>
                <h2 id="system-check-title">System check</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowSystemCheck(false)}
                aria-label="Close system check"
              >
                ×
              </button>
            </div>
            <div className="system-check-summary">
              <span className={systemIssueCount > 0 ? "attention" : "ready"}>
                {systemIssueCount > 0 ? "!" : "✓"}
              </span>
              <div>
                <strong>
                  {systemIssueCount > 0
                    ? `${systemIssueCount} item${systemIssueCount === 1 ? "" : "s"} need attention`
                    : "ScribeFlow is ready"}
                </strong>
                <small>No note text or patient data is included in this check.</small>
              </div>
              <button
                type="button"
                onClick={() => void refreshSystemCheck()}
                disabled={systemCheckRefreshing}
              >
                {systemCheckRefreshing ? "Checking..." : "Check again"}
              </button>
            </div>
            <section className="system-check-list" aria-label="System readiness">
              <div className="system-check-row ready">
                <span className="system-check-dot" aria-hidden="true">✓</span>
                <span>
                  <strong>ScribeFlow</strong>
                  <small>Version {packageInfo.version}</small>
                </span>
                <em>Installed</em>
              </div>
              <div
                className={`system-check-row ${
                  whisperInstallStatus.installed && whisperReady
                    ? "ready"
                    : "attention"
                }`}
              >
                <span className="system-check-dot" aria-hidden="true">
                  {whisperInstallStatus.installed && whisperReady ? "✓" : "!"}
                </span>
                <span>
                  <strong>Whisper</strong>
                  <small>
                    {whisperInstallStatus.installedReleaseVersion
                      ? `Version ${whisperInstallStatus.installedReleaseVersion}`
                      : whisperInstallStatus.message}
                  </small>
                </span>
                <em>{whisperReady ? "Ready" : "Needs attention"}</em>
              </div>
              <div
                className={`system-check-row ${
                  microphones.length > 0 ? "ready" : "attention"
                }`}
              >
                <span className="system-check-dot" aria-hidden="true">
                  {microphones.length > 0 ? "✓" : "!"}
                </span>
                <span>
                  <strong>Microphone</strong>
                  <small>{selectedMicrophoneLabel}</small>
                  <span className="system-microphone-meter">
                    <i style={{ width: `${microphoneLevel}%` }} />
                  </span>
                  <small className={`microphone-test-result ${microphoneTestState}`}>
                    {microphoneTestMessage}
                  </small>
                </span>
                <button
                  className="system-row-action"
                  type="button"
                  onClick={() =>
                    microphoneTestState === "testing"
                      ? stopMicrophoneTest(true)
                      : void startMicrophoneTest()
                  }
                  disabled={isRecording}
                >
                  {microphoneTestState === "testing" ? "Stop test" : "Test mic"}
                </button>
              </div>
              <div
                className={`system-check-row ${
                  sharedStorageStatus?.oneDrive ? "ready" : "attention"
                }`}
              >
                <span className="system-check-dot" aria-hidden="true">
                  {sharedStorageStatus?.oneDrive ? "✓" : "!"}
                </span>
                <span>
                  <strong>OneDrive folder</strong>
                  <small>
                    {sharedStorageStatus?.documentsRoot ||
                      "Documents\\ScribeFlow could not be checked"}
                  </small>
                </span>
                <em>{sharedStorageStatus?.oneDrive ? "Available" : "Check folder"}</em>
              </div>
              <div
                className={`system-check-row ${
                  sharedLibraryReady ? "ready" : "attention"
                }`}
              >
                <span className="system-check-dot" aria-hidden="true">
                  {sharedLibraryReady ? "✓" : "!"}
                </span>
                <span>
                  <strong>Shared library</strong>
                  <small>
                    {templates.length} templates · {quicktexts.length} quicktext ·{" "}
                    {vocabulary.length} vocabulary entries
                  </small>
                </span>
                <em>{sharedLibraryReady ? "Ready" : "Check sync"}</em>
              </div>
              <div className="system-check-row ready">
                <span className="system-check-dot" aria-hidden="true">✓</span>
                <span>
                  <strong>App updates</strong>
                  <small>
                    {sharedStorageStatus?.update?.message ||
                      "Updates are checked when ScribeFlow opens"}
                  </small>
                </span>
                <em>{sharedStorageStatus?.update?.stage || "Automatic"}</em>
              </div>
            </section>
            <div className="system-check-footer">
              <span>
                Microphone position: {dockPosition ? "Custom" : "Beside ScribeFlow"}
              </span>
              <button type="button" onClick={resetDockPosition}>
                Reset position
              </button>
            </div>
          </div>
        </div>
      )}

      {!webEdition && showSyncDashboard && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card sync-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shared-library-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">OneDrive folder status</p>
                <h2 id="shared-library-title">Shared library</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowSyncDashboard(false)}
                aria-label="Close shared library status"
              >
                ×
              </button>
            </div>
            <section className="sync-dashboard" aria-label="OneDrive sync status">
              <div className="sync-dashboard-heading">
                <span>
                  <strong>
                    {sharedStorageStatus?.oneDrive
                      ? `OneDrive folder on ${sharedStorageStatus.deviceName}`
                      : "Local Documents fallback"}
                  </strong>
                  <small>Reusable writing tools shared between your PCs</small>
                </span>
                <button
                  type="button"
                  disabled={syncRefreshing}
                  onClick={() => void refreshSharedLibraryRef.current?.(true)}
                >
                  {syncRefreshing ? "Checking..." : "Sync now"}
                </button>
              </div>
              <div className="sync-dashboard-row">
                <span className="sync-dot" aria-hidden="true" />
                <span>
                  <strong>Templates</strong>
                  <small>
                    {formatSyncTime(sharedStorageStatus?.templates.modifiedAt)}
                    {sharedStorageStatus?.templates.lastWriter
                      ? ` · ${sharedStorageStatus.templates.lastWriter}`
                      : ""}
                  </small>
                </span>
                <em>{templateStorageStatus}</em>
              </div>
              <div className="sync-dashboard-row">
                <span className="sync-dot" aria-hidden="true" />
                <span>
                  <strong>Quicktext + vocabulary</strong>
                  <small>
                    {formatSyncTime(sharedStorageStatus?.writingTools.modifiedAt)}
                    {sharedStorageStatus?.writingTools.lastWriter
                      ? ` · ${sharedStorageStatus.writingTools.lastWriter}`
                      : ""}
                  </small>
                </span>
                <em>{writingToolsStorageStatus}</em>
              </div>
              {sharedStorageStatus?.update?.message && (
                <div className="sync-dashboard-row update-row">
                  <span className="sync-dot" aria-hidden="true" />
                  <span>
                    <strong>App update</strong>
                    <small>{sharedStorageStatus.update.message}</small>
                  </span>
                  <em>{sharedStorageStatus.update.stage || "Ready"}</em>
                </div>
              )}
              {(syncConflictNotice ||
                (sharedStorageStatus &&
                  sharedStorageStatus.templates.conflicts +
                    sharedStorageStatus.writingTools.conflicts >
                    0)) && (
                <div className="sync-conflict-notice">
                  {syncConflictNotice ||
                    "Conflicting edits were preserved in the Conflicts folders."}
                </div>
              )}
              <div className="shared-library-location">
                Shared folder: <code>OneDrive\Documents\ScribeFlow</code>
                {sharedStorageStatus && (
                  <span>
                    Last checked {formatSyncTime(sharedStorageStatus.checkedAt)}
                  </span>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {webEdition && showWebLibraryManager && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card web-library-manager-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="web-library-manager-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Reusable online fields</p>
                <h2 id="web-library-manager-title">Library access & backups</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowWebLibraryManager(false)}
                aria-label="Close library access and backups"
              >
                ×
              </button>
            </div>
            <p className="web-library-phi-warning">
              Templates, Quicktext, vocabulary, names, and descriptions sync
              online. They are reusable writing tools only: never include PHI
              or patient-specific content.
            </p>
            <form
              className="web-owner-key-form"
              onSubmit={saveWebLibraryOwnerKey}
            >
              <label>
                Mantle owner write key
                <input
                  name="ownerKey"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={
                    webLibraryOwnerKey
                      ? "Enter a replacement owner key"
                      : "Paste the one-time owner key"
                  }
                  required
                  autoFocus={!webLibraryOwnerKey}
                />
              </label>
              <p>
                The key is stored only in this browser. A setup link may use
                <code>#mantle-key=YOUR_KEY</code>; ScribeFlow stores it and
                immediately clears the fragment. Keep the Mantle library entry
                public-readable for anonymous reads; the key is sent only with
                writes.
              </p>
              <div className="web-owner-key-actions">
                {webLibraryOwnerKey && (
                  <button
                    className="button subtle"
                    type="button"
                    onClick={forgetWebLibraryOwnerKey}
                  >
                    Forget owner key
                  </button>
                )}
                <button className="button primary" type="submit">
                  {webLibraryOwnerKey ? "Replace owner key" : "Enable editing"}
                </button>
              </div>
            </form>
            <section
              className="web-library-backups"
              aria-labelledby="web-backups-title"
            >
              <div className="web-library-backups-heading">
                <div>
                  <strong id="web-backups-title">Browser backups</strong>
                  <small>Up to 10 recent reusable-library snapshots</small>
                </div>
                <div>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={exportWebLibrary}
                  >
                    Export
                  </button>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={() => {
                      if (requireWebLibraryOwner()) {
                        webLibraryImportRef.current?.click();
                      }
                    }}
                    disabled={!webLibraryOwnerKey}
                  >
                    Import
                  </button>
                  <input
                    ref={webLibraryImportRef}
                    className="visually-hidden"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => void importWebLibrary(event)}
                    tabIndex={-1}
                  />
                </div>
              </div>
              {webLibraryDirty && (
                <div className="web-library-pending-save">
                  <span>Unsynced browser changes are preserved.</span>
                  <button
                    className="button primary"
                    type="button"
                    onClick={retryWebLibrarySave}
                    disabled={!webLibraryOwnerKey || webLibrarySaving}
                  >
                    Retry sync
                  </button>
                </div>
              )}
              <div className="web-library-snapshot-list">
                {webLibrarySnapshots.length === 0 ? (
                  <p>No browser snapshots yet.</p>
                ) : (
                  webLibrarySnapshots.map((snapshot) => (
                    <div key={`${snapshot.savedAt}-${snapshot.reason}`}>
                      <span>
                        <strong>{snapshot.reason}</strong>
                        <small>{formatSyncTime(snapshot.savedAt)}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => restoreWebLibrarySnapshot(snapshot)}
                        disabled={!webLibraryOwnerKey}
                      >
                        Restore
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {showHstPaste && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card hst-paste-modal"
            onSubmit={importHstResults}
            role="dialog"
            aria-modal="true"
            aria-labelledby="hst-paste-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Local HST import</p>
                <h2 id="hst-paste-title">Paste HST results</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={closeHstPaste}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="hst-privacy-note">
              Processed only in memory and never saved. The HST patient name
              must match the currently imported intake form.
            </p>
            <label>
              HST report text
              <textarea
                value={hstPasteText}
                onChange={(event) => setHstPasteText(event.target.value)}
                placeholder="Paste the home sleep test results here..."
                autoFocus
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                data-gramm="false"
                data-gramm_editor="false"
                data-enable-grammarly="false"
                data-lt-active="false"
                data-ms-editor="false"
                required
              />
            </label>
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                onClick={closeHstPaste}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                Prepare .hst
              </button>
            </div>
          </form>
        </div>
      )}

      {showQuicktextForm && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card"
            onSubmit={addQuicktext}
            key={editingQuicktext?.id ?? "new-quicktext"}
            role="dialog"
            aria-modal="true"
            aria-labelledby="quicktext-form-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Personal library</p>
                <h2 id="quicktext-form-title">
                  {editingQuicktext ? "Edit quicktext" : "Create quicktext"}
                </h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  setShowQuicktextForm(false);
                  setEditingQuicktext(null);
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <label>
              Shortcut
              <div className="shortcut-field">
                <span>.</span>
                <input
                  name="shortcut"
                  placeholder="myphrase"
                  defaultValue={editingQuicktext?.shortcut.replace(/^\./, "")}
                  required
                  autoFocus
                  pattern="[.]?[A-Za-z0-9_-]+"
                />
              </div>
            </label>
            <label>
              Name
              <input
                name="title"
                placeholder="Phrase name"
                defaultValue={editingQuicktext?.title ?? ""}
                required
              />
            </label>
            <label>
              Expanded text
              <textarea
                name="content"
                placeholder="Enter the full text that should be inserted…"
                defaultValue={editingQuicktext?.content ?? ""}
                required
              />
            </label>
            <div
              className={`modal-actions ${
                editingQuicktext ? "template-manager-actions" : ""
              }`}
            >
              {editingQuicktext && (
                <button
                  className="button danger"
                  type="button"
                  onClick={() => deleteQuicktext(editingQuicktext)}
                >
                  Delete
                </button>
              )}
              <div className="template-save-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => {
                    setShowQuicktextForm(false);
                    setEditingQuicktext(null);
                  }}
                >
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  {editingQuicktext ? "Save changes" : "Save quicktext"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {showVocabularyForm && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card"
            onSubmit={saveVocabularyItem}
            key={
              editingVocabulary?.id ??
              (learningHeard ? `learn-${learningHeard}` : "new-vocabulary")
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="vocabulary-form-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">
                  {learningHeard ? "Voice learning" : "Recognition filter"}
                </p>
                <h2 id="vocabulary-form-title">
                  {editingVocabulary
                    ? "Edit vocabulary term"
                    : learningHeard
                      ? "Teach voice correction"
                    : "Add vocabulary term"}
                </h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  setShowVocabularyForm(false);
                  setEditingVocabulary(null);
                  setLearningHeard("");
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <label>
              Recognition may hear
              <input
                name="heard"
                placeholder="Example: met formin"
                defaultValue={editingVocabulary?.heard ?? learningHeard}
                required
                autoFocus
              />
            </label>
            <label>
              Replace with
              <input
                name="replacement"
                placeholder="Example: metformin"
                defaultValue={editingVocabulary?.replacement ?? ""}
                required
              />
            </label>
            <p className="vocabulary-help">
              {learningHeard
                ? "Only this correction is saved locally. Audio and full notes are never stored. It starts working with your next dictation."
                : "Matching is case-insensitive. The preferred term is also supplied to compatible Chrome speech recognition as a specialty phrase."}
            </p>
            <div
              className={`modal-actions ${
                editingVocabulary ? "template-manager-actions" : ""
              }`}
            >
              {editingVocabulary && (
                <button
                  className="button danger"
                  type="button"
                  onClick={() => deleteVocabularyItem(editingVocabulary)}
                >
                  Remove
                </button>
              )}
              <div className="template-save-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => {
                    setShowVocabularyForm(false);
                    setEditingVocabulary(null);
                    setLearningHeard("");
                  }}
                >
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  {editingVocabulary
                    ? "Save term"
                    : learningHeard
                      ? "Learn correction"
                      : "Add term"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {showTemplateForm && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card template-form-modal"
            onSubmit={saveTemplate}
            key={editingTemplate?.id ?? "new-template"}
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-form-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Template manager</p>
                <h2 id="template-form-title">
                  {editingTemplate ? "Edit template" : "Create template"}
                </h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  setShowTemplateForm(false);
                  setEditingTemplate(null);
                  templateSelectionRef.current = null;
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="template-form-fields">
              <label>
                Template name
                <input
                  name="name"
                  placeholder="Annual wellness visit"
                  defaultValue={editingTemplate?.name ?? ""}
                  required
                  autoFocus
                />
              </label>
              <label>
                Type
                <input
                  name="type"
                  placeholder="Primary care"
                  defaultValue={editingTemplate?.type ?? ""}
                  required
                />
              </label>
              <label className="full-width">
                Short description
                <input
                  name="description"
                  placeholder="What this template is used for"
                  defaultValue={editingTemplate?.description ?? ""}
                  required
                />
              </label>
              <div className="template-editor-label full-width">
                <span>Template text</span>
                <div
                  className="template-format-toolbar"
                  aria-label="Template text formatting"
                >
                  <span>Format</span>
                  <button
                    type="button"
                    aria-label="Bold template text"
                    title="Bold (Ctrl+B)"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyTemplateFormatting("bold")}
                  >
                    <strong>B</strong>
                  </button>
                  <button
                    type="button"
                    aria-label="Underline template text"
                    title="Underline (Ctrl+U)"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyTemplateFormatting("underline")}
                  >
                    <u>U</u>
                  </button>
                  <span className="template-field-label">PDF fields</span>
                  {pdfFieldTokens.map((field) => (
                    <button
                      className="template-field-button"
                      type="button"
                      key={field}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertTemplateField(field)}
                      title={`Insert ${field} at the cursor`}
                    >
                      {field}
                    </button>
                  ))}
                </div>
                <div
                  ref={templateEditorRef}
                  className="template-rich-editor"
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-label="Template text"
                  aria-multiline="true"
                  data-placeholder={`HISTORY\n[Enter history]\n\nASSESSMENT\n[Enter assessment]\n\nPLAN\n[Enter plan]`}
                  onMouseUp={rememberTemplateSelection}
                  onKeyUp={rememberTemplateSelection}
                  onBlur={rememberTemplateSelection}
                  onKeyDown={handleTemplateEditorKeyDown}
                  onPaste={pastePlainTextIntoTemplate}
                />
              </div>
            </div>
            <div
              className={`modal-actions ${
                editingTemplate ? "template-manager-actions" : ""
              }`}
            >
              {editingTemplate && (
                <div className="template-destructive-actions">
                  <button
                    className="button danger"
                    type="button"
                    onClick={() => deleteTemplate(editingTemplate)}
                  >
                    Delete
                  </button>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={() => duplicateTemplate(editingTemplate)}
                  >
                    Duplicate
                  </button>
                </div>
              )}
              <div className="template-save-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => {
                    setShowTemplateForm(false);
                    setEditingTemplate(null);
                    templateSelectionRef.current = null;
                  }}
                >
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  {editingTemplate ? "Save changes" : "Create template"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span aria-hidden="true">✓</span> {toast}
        </div>
      )}
    </main>
  );
}
