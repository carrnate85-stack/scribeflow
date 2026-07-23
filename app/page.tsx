"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Template = {
  id: string;
  name: string;
  type: string;
  description: string;
  content: string;
};

type Quicktext = {
  id: string;
  shortcut: string;
  title: string;
  content: string;
  category: string;
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

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

const templates: Template[] = [
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
  note: "scribe-note-v1",
  title: "scribe-title-v1",
  quicktexts: "scribe-quicktexts-v1",
};

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function Home() {
  const [note, setNote] = useState("");
  const [noteTitle, setNoteTitle] = useState("Untitled encounter");
  const [activePanel, setActivePanel] = useState<"quicktext" | "templates">(
    "quicktext",
  );
  const [search, setSearch] = useState("");
  const [quicktexts, setQuicktexts] = useState(starterQuicktexts);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [savedAt, setSavedAt] = useState("Not saved yet");
  const [toast, setToast] = useState("");
  const [showQuicktextForm, setShowQuicktextForm] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [speechSupported, setSpeechSupported] = useState(true);
  const recognitionRef = useRef<Recognition | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldRestartRef = useRef(false);

  useEffect(() => {
    const storedNote = window.localStorage.getItem(storageKeys.note);
    const storedTitle = window.localStorage.getItem(storageKeys.title);
    const storedQuicktexts = window.localStorage.getItem(storageKeys.quicktexts);
    if (storedNote) setNote(storedNote);
    if (storedTitle) setNoteTitle(storedTitle);
    if (storedQuicktexts) {
      try {
        setQuicktexts(JSON.parse(storedQuicktexts) as Quicktext[]);
      } catch {
        setQuicktexts(starterQuicktexts);
      }
    }
    setSpeechSupported(
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    );
  }, []);

  useEffect(() => {
    const saveTimer = window.setTimeout(() => {
      window.localStorage.setItem(storageKeys.note, note);
      window.localStorage.setItem(storageKeys.title, noteTitle);
      setSavedAt(
        `Saved ${new Intl.DateTimeFormat("en", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date())}`,
      );
    }, 450);
    return () => window.clearTimeout(saveTimer);
  }, [note, noteTitle]);

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

  const stopRecording = useCallback(() => {
    shouldRestartRef.current = false;
    recognitionRef.current?.stop();
    setIsRecording(false);
    setInterimText("");
    setStatus("Ready");
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      setToast("Live dictation is not supported in this browser");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    shouldRestartRef.current = true;

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalTranscript += result[0].transcript;
        else interimTranscript += result[0].transcript;
      }
      if (finalTranscript) {
        setNote((current) => {
          const spacer = current && !/\s$/.test(current) ? " " : "";
          return `${current}${spacer}${finalTranscript.trim()} `;
        });
      }
      setInterimText(interimTranscript);
    };

    recognition.onerror = () => {
      shouldRestartRef.current = false;
      setIsRecording(false);
      setInterimText("");
      setStatus("Microphone unavailable");
      setToast("Check microphone permission and try again");
    };

    recognition.onend = () => {
      if (shouldRestartRef.current) {
        try {
          recognition.start();
        } catch {
          shouldRestartRef.current = false;
          setIsRecording(false);
          setStatus("Ready");
        }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setElapsed(0);
      setIsRecording(true);
      setStatus("Listening");
    } catch {
      setToast("Unable to start dictation");
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === "Space") {
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
  }, [search]);

  const currentToken = useMemo(() => {
    const beforeCursor =
      noteRef.current?.selectionStart != null
        ? note.slice(0, noteRef.current.selectionStart)
        : note;
    return beforeCursor.match(/\.[a-zA-Z]*$/)?.[0] ?? "";
  }, [note]);

  const matchingSuggestions = useMemo(() => {
    if (!currentToken) return [];
    return quicktexts
      .filter((item) => item.shortcut.startsWith(currentToken.toLowerCase()))
      .slice(0, 3);
  }, [currentToken, quicktexts]);

  function insertAtCursor(content: string) {
    const textarea = noteRef.current;
    const start = textarea?.selectionStart ?? note.length;
    const end = textarea?.selectionEnd ?? note.length;
    const leading = start > 0 && !/\s/.test(note[start - 1]) ? "\n" : "";
    const next = `${note.slice(0, start)}${leading}${content}${note.slice(end)}`;
    setNote(next);
    window.requestAnimationFrame(() => {
      const cursor = start + leading.length + content.length;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  }

  function expandQuicktext(item: Quicktext) {
    const textarea = noteRef.current;
    const cursor = textarea?.selectionStart ?? note.length;
    const before = note.slice(0, cursor);
    const tokenMatch = before.match(/\.[a-zA-Z]+$/);
    if (tokenMatch) {
      const tokenStart = cursor - tokenMatch[0].length;
      const next = `${note.slice(0, tokenStart)}${item.content}${note.slice(cursor)}`;
      setNote(next);
      window.requestAnimationFrame(() => {
        const nextCursor = tokenStart + item.content.length;
        textarea?.focus();
        textarea?.setSelectionRange(nextCursor, nextCursor);
      });
    } else {
      insertAtCursor(item.content);
    }
    setToast(`${item.shortcut} inserted`);
  }

  function handleNoteKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      (event.key === " " || event.key === "Enter" || event.key === "Tab") &&
      currentToken
    ) {
      const match = quicktexts.find(
        (item) => item.shortcut.toLowerCase() === currentToken.toLowerCase(),
      );
      if (match) {
        event.preventDefault();
        expandQuicktext(match);
      }
    }
    if (event.key === "Tab" && matchingSuggestions[0]) {
      event.preventDefault();
      expandQuicktext(matchingSuggestions[0]);
    }
  }

  function applyTemplate(template: Template) {
    const hasContent = note.trim().length > 0;
    if (hasContent && !window.confirm("Replace the current note with this template?")) {
      return;
    }
    setNote(template.content);
    setNoteTitle(template.name);
    setShowTemplatePicker(false);
    setToast(`${template.name} applied`);
    window.requestAnimationFrame(() => noteRef.current?.focus());
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
    const next = [
      ...quicktexts,
      {
        id: `${Date.now()}`,
        shortcut: shortcut.startsWith(".") ? shortcut : `.${shortcut}`,
        title,
        content,
        category: "Custom",
      },
    ];
    setQuicktexts(next);
    window.localStorage.setItem(storageKeys.quicktexts, JSON.stringify(next));
    setShowQuicktextForm(false);
    setToast("Quicktext saved");
  }

  async function copyNote() {
    await navigator.clipboard.writeText(note);
    setToast("Note copied to clipboard");
  }

  function downloadNote() {
    const blob = new Blob([note], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${noteTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "clinical-note"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("Note downloaded");
  }

  function newNote() {
    if (note.trim() && !window.confirm("Start a new note? Your current note will be cleared.")) {
      return;
    }
    stopRecording();
    setNote("");
    setNoteTitle("Untitled encounter");
    setElapsed(0);
    window.localStorage.removeItem(storageKeys.note);
    window.localStorage.removeItem(storageKeys.title);
    window.requestAnimationFrame(() => noteRef.current?.focus());
  }

  const wordCount = note.trim() ? note.trim().split(/\s+/).length : 0;

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
          Notes saved on this device
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
              aria-label="Create quicktext"
              title="Create quicktext"
              onClick={() => setShowQuicktextForm(true)}
            >
              +
            </button>
          </div>

          <div className="segmented-control" aria-label="Library view">
            <button
              type="button"
              className={activePanel === "quicktext" ? "active" : ""}
              onClick={() => setActivePanel("quicktext")}
            >
              Quicktext
            </button>
            <button
              type="button"
              className={activePanel === "templates" ? "active" : ""}
              onClick={() => setActivePanel("templates")}
            >
              Templates
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

          <div className="library-list">
            {activePanel === "quicktext" ? (
              <>
                <div className="list-meta">
                  <span>{filteredQuicktexts.length} snippets</span>
                  <span>Type shortcut + space</span>
                </div>
                {filteredQuicktexts.map((item) => (
                  <button
                    className="library-item"
                    type="button"
                    key={item.id}
                    onClick={() => expandQuicktext(item)}
                  >
                    <span className="item-topline">
                      <code>{item.shortcut}</code>
                      <span className="category">{item.category}</span>
                    </span>
                    <strong>{item.title}</strong>
                    <span className="snippet-preview">{item.content}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="list-meta">
                  <span>{filteredTemplates.length} templates</span>
                  <span>Start structured</span>
                </div>
                {filteredTemplates.map((template) => (
                  <button
                    className="library-item template-item"
                    type="button"
                    key={template.id}
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
                ))}
              </>
            )}
          </div>

          <div className="library-tip">
            <span className="tip-icon" aria-hidden="true">
              i
            </span>
            <p>
              Type <code>.normalexam</code> then press space to expand it inside
              your note.
            </p>
          </div>
        </aside>

        <section className="note-panel">
          <div className="note-toolbar">
            <div className="note-identity">
              <label htmlFor="note-title">Encounter note</label>
              <input
                id="note-title"
                value={noteTitle}
                onChange={(event) => setNoteTitle(event.target.value)}
                aria-label="Note title"
              />
            </div>
            <div className="note-actions">
              <span className="save-status">
                <span aria-hidden="true">✓</span> {savedAt}
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
                onClick={downloadNote}
                disabled={!note.trim()}
                aria-label="Download note"
                title="Download note"
              >
                ↓
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
            <textarea
              ref={noteRef}
              className="note-editor"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={handleNoteKeyDown}
              onSelect={() => setNote((current) => current)}
              spellCheck
              aria-label="Clinical note editor"
              placeholder=""
            />
            {interimText && (
              <div className="interim-transcript" aria-live="polite">
                {interimText}
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

          <div className={`dictation-dock ${isRecording ? "recording" : ""}`}>
            <div className="dictation-state">
              <span className="status-dot" aria-hidden="true" />
              <div>
                <strong>{status}</strong>
                <span>
                  {isRecording
                    ? "Speak naturally — punctuation is editable"
                    : speechSupported
                      ? "Microphone is ready"
                      : "Dictation unavailable in this browser"}
                </span>
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
              disabled={!speechSupported}
            >
              <span className="mic-shape" aria-hidden="true" />
            </button>
            <div className="record-time">
              <strong>{formatDuration(elapsed)}</strong>
              <span>
                <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd>
              </span>
            </div>
          </div>
        </section>
      </div>

      {showQuicktextForm && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={addQuicktext}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Personal library</p>
                <h2>Create quicktext</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowQuicktextForm(false)}
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
                  required
                  autoFocus
                  pattern="[.]?[A-Za-z0-9_-]+"
                />
              </div>
            </label>
            <label>
              Name
              <input name="title" placeholder="Phrase name" required />
            </label>
            <label>
              Expanded text
              <textarea
                name="content"
                placeholder="Enter the full text that should be inserted…"
                required
              />
            </label>
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                onClick={() => setShowQuicktextForm(false)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                Save quicktext
              </button>
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
