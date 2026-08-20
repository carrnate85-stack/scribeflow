"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
  quicktexts: Quicktext[];
  vocabulary: VocabularyItem[];
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

type WhisperWorkerResponse =
  | {
      type: "progress";
      progress?: number;
      status?: string;
      file?: string;
    }
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      session: number;
      text: string;
    }
  | {
      type: "error";
      id?: number;
      session?: number;
      message: string;
    };

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
};

const legacyPatientDataStorageKeys = [
  "scribe-note-v1",
  "scribe-note-html-v1",
  "scribe-title-v1",
];

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
    return parsed as Template[];
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
      quicktexts,
      vocabulary,
    };
  } catch {
    return null;
  }
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
    updatedAt: Math.max(Date.now(), diskPayload.updatedAt + 1),
    quicktexts: Array.from(quicktexts.values()),
    vocabulary: Array.from(vocabulary.values()),
  };
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
    /\bAHI(?:\s*\(events\/hour\))?\s*:?\s*(\d+(?:\.\d+)?)\b/i,
  ]);

  if (!usageDays && !fourHourUsage && !mode && !pressure95 && !leak95 && !ahi) {
    return undefined;
  }

  const lines: string[] = [];
  if (reportPeriod) lines.push(`PAP compliance period: ${reportPeriod}.`);

  const usageParts = [
    usageDays ? `${usageDays} used` : null,
    fourHourUsage ? `>=4 hours ${fourHourUsage}` : null,
    averageUsage ? `average ${averageUsage} on days used` : null,
  ].filter((value): value is string => Boolean(value));
  if (usageParts.length > 0) lines.push(`Usage: ${usageParts.join("; ")}.`);

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

function extractHstSummary(text: string) {
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
      `\\b(?:overall|total)\\s+(${labelPattern})\\s*(?:\\([^)]*\\))?\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b`,
      "i",
    );
    const overallMatch = normalizedText.match(overallPattern);
    if (overallMatch?.[1] && overallMatch[2]) {
      return { label: overallMatch[1], value: overallMatch[2] };
    }

    const generalPattern = new RegExp(
      `\\b(${labelPattern})\\s*(?:\\([^)]*\\))?\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\b`,
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

  const studyDate = findValue([
    /\b(?:Date of Study|Study Date|Recording Date)\s*[:=-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/i,
  ]);
  const recordingTime = findValue([
    /\b(?:Total )?(?:Recording|Monitoring|Analysis|Sleep) Time\s*[:=-]?\s*(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)(?:\s+\d+(?:\.\d+)?\s*(?:minutes?|mins?))?)/i,
  ]);
  const respiratoryIndex = findIndex("p?AHI|REI");
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
  const impression = findValue([
    /\b(?:Impression|Interpretation|Diagnosis)\s*[:=-]\s*((?:mild|moderate|severe)\s+(?:obstructive sleep apnea|sleep apnea|OSA))\b/i,
    /\b((?:mild|moderate|severe)\s+(?:obstructive sleep apnea|sleep apnea|OSA))\b/i,
  ]);

  if (
    !respiratoryIndex &&
    !supineIndexMatch &&
    !rdi &&
    !odi &&
    !oxygenNadir &&
    !meanSpo2 &&
    !timeAtOrBelow88 &&
    !impression
  ) {
    return undefined;
  }

  const withPercent = (value: string) =>
    value.includes("%") ? value : `${value}%`;
  const lines: string[] = [];
  if (studyDate) lines.push(`HST date: ${studyDate}.`);
  if (recordingTime) lines.push(`Recording time: ${recordingTime}.`);
  const respiratoryParts = [
    respiratoryIndex
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
  if (impression) lines.push(`Impression: ${impression}.`);
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
  const [noteHtml, setNoteHtml] = useState("");
  const [noteTitle, setNoteTitle] = useState("Untitled encounter");
  const [savedNoteName, setSavedNoteName] = useState("");
  const [activePanel, setActivePanel] = useState<
    "quicktext" | "templates" | "vocabulary"
  >("templates");
  const [search, setSearch] = useState("");
  const [quicktexts, setQuicktexts] = useState(starterQuicktexts);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);
  const [templateStorageStatus, setTemplateStorageStatus] =
    useState("Loading protected copy");
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [writingToolsReady, setWritingToolsReady] = useState(false);
  const [writingToolsStorageStatus, setWritingToolsStorageStatus] =
    useState("Loading shared copy");
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
  const [deletePdfAfterScan, setDeletePdfAfterScan] = useState(true);
  const [isScanningPdf, setIsScanningPdf] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [dictationEngine, setDictationEngine] =
    useState<DictationEngine>("whisper");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("default");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [toast, setToast] = useState("");
  const [showQuicktextForm, setShowQuicktextForm] = useState(false);
  const [editingQuicktext, setEditingQuicktext] =
    useState<Quicktext | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
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
  const templateSelectionRef = useRef<Range | null>(null);
  const interimTranscriptRef = useRef("");
  const shouldRestartRef = useRef(false);

  useEffect(() => {
    if (!showTemplateForm) return;
    const editor = templateEditorRef.current;
    if (!editor) return;

    editor.innerHTML =
      editingTemplate?.contentHtml ||
      plainTextToHtml(editingTemplate?.content ?? "");
    templateSelectionRef.current = null;
  }, [editingTemplate, showTemplateForm]);

  const syncEditorState = useCallback(() => {
    const editor = noteRef.current;
    if (!editor) return;
    setNote(editor.innerText.replace(/\u00a0/g, " "));
    setNoteHtml(editor.innerHTML);
    setSavedNoteName("");
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
    const html = contentHtml || plainTextToHtml(content);
    setNote(content);
    setNoteHtml(html);
    setSavedNoteName("");
    if (noteRef.current) noteRef.current.innerHTML = html;
    lastSelectionRef.current = null;
    setCurrentToken("");
  }, []);

  const populateMeasurementTokensInNote = useCallback(
    (measurements: PdfMeasurements) => {
      const editor = noteRef.current;
      if (!editor) return false;
      const nextHtml = resolveMeasurementTokens(
        editor.innerHTML,
        measurements,
        true,
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

    let pdfBytes: Uint8Array | null = null;
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
      loadingTask = pdfjs.getDocument({ data: pdfBytes });
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

  const persistTemplatesToDisk = useCallback(
    async (payload: TemplateVaultPayload) => {
      const response = await fetch(
        "http://127.0.0.1:3001/config/templates",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        throw new Error("The durable template backup could not be updated");
      }
    },
    [],
  );

  const persistWritingToolsToDisk = useCallback(
    async (payload: WritingToolsVaultPayload) => {
      const response = await fetch(
        "http://127.0.0.1:3001/config/writing-tools",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        throw new Error("The shared writing-tools copy could not be updated");
      }
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
    const browserTemplates =
      parseStoredTemplates(storedTemplates) ||
      parseStoredTemplates(storedTemplateBackup);
    void (async () => {
      let diskPayload: TemplateVaultPayload | null = null;
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

      const browserPayload: TemplateVaultPayload | null = browserTemplates
        ? {
            version: 1,
            updatedAt:
              storedTemplatesUpdatedAt > 0
                ? storedTemplatesUpdatedAt
                : Date.now(),
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
              updatedAt: Date.now(),
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
      if (diskMatches) {
        setTemplateStorageStatus("Synced in OneDrive");
      } else {
        try {
          await persistTemplatesToDisk(selectedPayload);
          setTemplateStorageStatus("Synced in OneDrive");
        } catch {
          setTemplateStorageStatus("Browser backup only");
        }
      }
    })();
    const browserQuicktexts = parseStoredQuicktexts(storedQuicktexts);
    const browserVocabulary = parseStoredVocabulary(storedVocabulary);
    void (async () => {
      let diskPayload: WritingToolsVaultPayload | null = null;
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
                    : Date.now(),
              }
            : {
                version: 1,
                updatedAt: Date.now(),
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
      if (diskMatches) {
        setWritingToolsStorageStatus("Synced in OneDrive");
      } else {
        try {
          await persistWritingToolsToDisk(selectedPayload);
          setWritingToolsStorageStatus("Synced in OneDrive");
        } catch {
          setWritingToolsStorageStatus("Browser backup only");
        }
      }
    })();
    setSpeechSupported(
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    );
    setWhisperSupported(
      Boolean(navigator.mediaDevices?.getUserMedia && "AudioContext" in window),
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
    void refreshMicrophones();
  }, [persistTemplatesToDisk, persistWritingToolsToDisk, refreshMicrophones]);

  useEffect(() => {
    if (!templatesReady || !writingToolsReady) return;

    let cancelled = false;
    const refreshSharedLibrary = async () => {
      try {
        const [templateResponse, writingToolsResponse] = await Promise.all([
          fetch("http://127.0.0.1:3001/config/templates", {
            cache: "no-store",
          }),
          fetch("http://127.0.0.1:3001/config/writing-tools", {
            cache: "no-store",
          }),
        ]);
        if (cancelled) return;

        if (templateResponse.ok) {
          const payload = parseTemplateVaultPayload(
            await templateResponse.text(),
          );
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
            setTemplateStorageStatus("Updated from OneDrive");
          }
        }

        if (writingToolsResponse.ok) {
          const payload = parseWritingToolsVaultPayload(
            await writingToolsResponse.text(),
          );
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
            setWritingToolsStorageStatus("Updated from OneDrive");
          }
        }
      } catch {
        // Keep the browser backup active while the local helper is restarting.
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshSharedLibrary();
      }
    };
    const timer = window.setInterval(() => {
      void refreshSharedLibrary();
    }, 5000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [templatesReady, writingToolsReady]);

  useEffect(() => {
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

    whisperLoadPromiseRef.current = fetch("http://127.0.0.1:3002/", {
      cache: "no-store",
    })
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
    void refreshWhisperInstallStatus();
  }, [refreshWhisperInstallStatus]);

  useEffect(() => {
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
    if (
      dictationEngine !== "whisper" ||
      !whisperSupported ||
      !whisperInstallStatus.installed ||
      whisperReady
    ) {
      return;
    }

    setStatus("Starting local Whisper");
    const connect = () => {
      void ensureWhisperWorker()
        .then(() => setStatus("Ready · Whisper local"))
        .catch(() => setStatus("Starting local Whisper"));
    };
    connect();
    const timer = window.setInterval(connect, 3000);
    return () => window.clearInterval(timer);
  }, [
    dictationEngine,
    ensureWhisperWorker,
    whisperReady,
    whisperInstallStatus.installed,
    whisperSupported,
  ]);

  useEffect(() => {
    if (dictationEngine !== "whisper" || whisperReady) return;
    if (whisperInstallStatus.status === "installing") {
      setStatus("Installing Whisper locally");
    } else if (
      whisperInstallStatus.status === "missing" ||
      whisperInstallStatus.status === "failed"
    ) {
      setStatus("Whisper installation recommended");
    }
  }, [dictationEngine, whisperInstallStatus.status, whisperReady]);

  useEffect(() => {
    if (whisperInstallStatus.status !== "update_available") {
      setWhisperUpdatePromptDismissed(false);
    }
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

      return fetch("http://127.0.0.1:3002/inference", {
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
        const now = Date.now();
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
    if (dictationEngine === "whisper") void startWhisperRecording();
    else void startChromeRecording();
  }, [dictationEngine, startChromeRecording, startWhisperRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
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
    if (hasContent && !window.confirm("Replace the current note with this template?")) {
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
    setNoteTitle(template.name);
    setShowTemplatePicker(false);
    setToast(`${template.name} applied`);
    window.requestAnimationFrame(() => noteRef.current?.focus());
  }

  function saveWritingTools(
    nextQuicktexts: Quicktext[],
    nextVocabulary: VocabularyItem[],
  ) {
    const updatedAt = Date.now();
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
    setWritingToolsStorageStatus("Syncing to Documents...");
    void persistWritingToolsToDisk(payload)
      .then(() => setWritingToolsStorageStatus("Synced in OneDrive"))
      .catch(() => {
        setWritingToolsStorageStatus("Browser backup only");
        setToast(
          "Writing tool saved in browser; shared copy needs the launcher",
        );
      });
  }

  function saveQuicktexts(nextQuicktexts: Quicktext[]) {
    saveWritingTools(nextQuicktexts, vocabulary);
  }

  function openQuicktextForm(item: Quicktext | null = null) {
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
          id: `${Date.now()}`,
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
    setEditingVocabulary(item);
    setLearningHeard("");
    setShowVocabularyForm(true);
  }

  function openVoiceLearning() {
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
            id: `vocabulary-${Date.now()}`,
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
    const serializedTemplates = JSON.stringify(nextTemplates);
    const updatedAt = Date.now();
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
    setTemplateStorageStatus("Protecting templates...");
    void persistTemplatesToDisk(payload)
      .then(() => setTemplateStorageStatus("Synced in OneDrive"))
      .catch(() => {
        setTemplateStorageStatus("Browser backup only");
        setToast("Template saved in browser; durable backup needs the launcher");
      });
  }

  function openTemplateForm(template: Template | null = null) {
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
    const contentHtml =
      templateEditorRef.current?.innerHTML.trim() || plainTextToHtml(content);
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
          id: `template-${Date.now()}`,
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
      id: `template-${Date.now()}`,
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
    try {
      if ("ClipboardItem" in window && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([note], {
              type: "text/plain;charset=utf-8",
            }),
            "text/html": new Blob([noteHtml || plainTextToHtml(note)], {
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
    setToast("Note copied to clipboard");
  }

  async function saveNote() {
    try {
      const response = await fetch(
        "http://127.0.0.1:3001/documents/save-note",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: noteTitle,
            note,
            noteHtml,
          }),
        },
      );
      if (!response.ok) {
        throw new Error("The note could not be saved");
      }
      const saved = (await response.json()) as { fileName: string };
      setSavedNoteName(saved.fileName);
      setToast(`Saved in Documents\\ScribeFlow\\Notes: ${saved.fileName}`);
    } catch {
      setToast("Note was not saved. Keep ScribeFlow open and try again.");
    }
  }

  function newNote() {
    if (note.trim() && !window.confirm("Start a new note? Your current note will be cleared.")) {
      return;
    }
    stopRecording();
    whisperSessionRef.current += 1;
    setEditorText("");
    setNoteTitle("Untitled encounter");
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

  function changeDictationEngine(event: ChangeEvent<HTMLSelectElement>) {
    const nextEngine = event.currentTarget.value as DictationEngine;
    if (nextEngine !== "whisper" && nextEngine !== "chrome") return;
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

  const wordCount = note.trim() ? note.trim().split(/\s+/).length : 0;
  const activeEngineSupported =
    dictationEngine === "whisper"
      ? whisperSupported && whisperReady
      : speechSupported;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <div>
            <strong>ScribeFlow</strong>
            <span>Clinical dictation</span>
          </div>
        </div>
        <div className="privacy-badge">
          <span className="privacy-dot" aria-hidden="true" />
          Local-only â€” nothing leaves this device
        </div>
        <div className="top-actions">
          <button className="button subtle" type="button" onClick={newNote}>
            <span aria-hidden="true">＋</span> New note
          </button>
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

      {dictationEngine === "whisper" &&
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
            >
              +
            </button>
          </div>

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
            />
            <kbd>⌘K</kbd>
          </label>

          <div className="shared-library-location">
            Shared folder: <code>OneDrive\Documents\ScribeFlow</code>
          </div>

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
                    >
                      <span className="vocabulary-heard">
                        Heard: <code>{item.heard}</code>
                      </span>
                      <span className="vocabulary-arrow" aria-hidden="true">
                        â†“
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
          <div className="note-toolbar">
            <div className="note-identity">
              <label htmlFor="note-title">Encounter note</label>
              <input
                id="note-title"
                value={noteTitle}
                onChange={(event) => {
                  setNoteTitle(event.target.value);
                  setSavedNoteName("");
                }}
                aria-label="Note title"
              />
            </div>
            <div className="note-actions">
              <span className="save-status">
                <span aria-hidden="true">◉</span>{" "}
                {savedNoteName
                  ? "Saved in OneDrive"
                  : "Not saved · save to OneDrive"}
              </span>
              <button
                className="toolbar-button"
                type="button"
                onClick={() => setShowTemplatePicker(true)}
              >
                Use template
              </button>
              <button
                className="toolbar-button"
                type="button"
                onClick={() => void saveNote()}
                disabled={!note.trim()}
                aria-label="Save note to Documents"
                title="Save note to Documents\ScribeFlow\Notes"
              >
                Save
              </button>
            </div>
          </div>

          <div className="encounter-strip">
            <span className="encounter-pill">Outpatient</span>
            <span>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date())}</span>
            <span className="divider" />
            <span>{wordCount} words</span>
            <span className="divider" />
            <span>English (US)</span>
          </div>

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
            <span className="pdf-import-live" role="status" aria-live="polite">
              {pdfStatus}. {papPdfStatus}. {hstStatus}.
            </span>
          </div>

          <div className="editor-wrap">
            {!note && !interimText && (
              <div className="empty-state" aria-hidden="true">
                <span className="empty-symbol">“</span>
                <h3>Start dictating or choose a template</h3>
                <p>
                  Your note appears here as you speak. You can edit it at any
                  time.
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
              spellCheck
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

          <div
            className={`dictation-dock ${isRecording ? "recording" : ""}`}
            aria-label="Persistent dictation controls"
          >
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
                <label
                  className="dictation-device-picker"
                  title={
                    dictationEngine === "chrome"
                      ? "Chrome offline dictation uses the browser or Windows default microphone"
                      : "Choose the microphone used by local Whisper"
                  }
                >
                  <span>Mic</span>
                  <select
                    value={
                      dictationEngine === "whisper"
                        ? selectedMicrophoneId
                        : "default"
                    }
                    onChange={changeMicrophone}
                    disabled={isRecording || dictationEngine === "chrome"}
                    aria-label="Microphone input"
                  >
                    <option value="default">System default</option>
                    {microphones
                      .filter(
                        (microphone) => microphone.deviceId !== "default",
                      )
                      .map((microphone) => (
                        <option
                          value={microphone.deviceId}
                          key={microphone.deviceId}
                        >
                          {microphone.label}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="waveform" aria-hidden="true">
              {[13, 24, 38, 22, 45, 31, 19, 39, 27, 15].map((height, index) => (
                <i
                  key={index}
                  style={{
                    height: `${height}px`,
                    animationDelay: `${index * 80}ms`,
                  }}
                />
              ))}
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
          </div>
        </section>
      </div>

      {whisperInstallStatus.status === "update_available" &&
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

      {showHstPaste && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card hst-paste-modal"
            onSubmit={importHstResults}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Local HST import</p>
                <h2>Paste HST results</h2>
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
              Processed only in memory. The pasted source is never saved.
            </p>
            <label>
              HST report text
              <textarea
                value={hstPasteText}
                onChange={(event) => setHstPasteText(event.target.value)}
                placeholder="Paste the home sleep test results here..."
                autoFocus
                spellCheck={false}
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
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Personal library</p>
                <h2>
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
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">
                  {learningHeard ? "Voice learning" : "Recognition filter"}
                </p>
                <h2>
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
                Ã—
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
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Template manager</p>
                <h2>
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
                Ã—
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

      {showTemplatePicker && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card template-modal">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Structured notes</p>
                <h2>Choose a template</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowTemplatePicker(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="template-grid">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                >
                  <span className="template-glyph" aria-hidden="true">
                    {template.name.slice(0, 1)}
                  </span>
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </button>
              ))}
            </div>
          </div>
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
