# ScribeFlow

ScribeFlow is a focused, locally processed clinical dictation workspace. It combines
bundled Whisper speech recognition with an editable note, reusable dot phrases,
structured clinical templates, in-memory PDF parsing, and copy or OneDrive
document saving.

PDF templates can use `.pastmedicalhistory` to insert the Past Medical History
section extracted from an onboarding form.

PAP compliance reports have a separate local upload control. The `.cpap` field
inserts a concise summary of usage, machine settings, 95th-percentile pressure
when present, 95th-percentile leak, and residual AHI. The original PAP PDF is
permanently deleted after a successful scan using filename, size, and SHA-256
verification.

## Included workflows

- Start and stop dictation with the microphone control or the backquote key
  (`` ` ``).
- Choose **Whisper Large-v3 local** (default) or the optional Chrome offline
  speech pack. It uses the full unquantized Large-v3 model through native CUDA,
  with English-only, accuracy-focused five-beam decoding.
- See a revisable live Whisper preview about every 2.5 seconds while speaking;
  finalized text is committed after a pause. Abnormal three-or-more phrase
  repetitions, end-of-speech sign-offs, and common subtitle-credit
  hallucinations are removed before they enter the note.
- Dictation continues in lowercase when inserted mid-sentence, capitalizes only
  at the beginning of a note or after sentence-ending punctuation, and retains
  single commas recognized within speech. Repeated comma runs and automatic
  trailing commas are removed.
- Type a shortcut such as `.normalexam` followed by Space to expand quicktext.
- Start from SOAP, follow-up, consultation, or procedure templates.
- Create personal quicktexts that persist in the browser.
- Copy the completed note or save it directly to
  `OneDrive\Documents\ScribeFlow\Notes`.

## Development

```sh
pnpm install
pnpm dev
```

Run `pnpm build` for a production build.

On Windows, double-click `Launch ScribeFlow.cmd` to start the production build
and the loopback-only Whisper model service in the background, then open it in
Chrome.

## Windows installer and computer transfers

The GitHub repository contains source code and installer-building files only.
It intentionally excludes templates, notes, PDFs, recordings, generated builds,
Node modules, and speech-model files.

Create a per-user Windows installer with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-portable-installer.ps1
```

The package is written to
`Downloads\ScribeFlow-Windows-Online-Installer.zip`. It includes the production
build and a verified portable Node.js runtime, but not the multi-gigabyte speech
model. On the destination computer:

1. Download the installer ZIP from the repository's **Releases** page.
2. Extract the complete ZIP.
3. Double-click `Install ScribeFlow.cmd`.
4. Open ScribeFlow from its desktop shortcut.
5. If Whisper is not present, ScribeFlow recommends it in the app. Click
   **Install Whisper** and keep ScribeFlow open during the verified download.

Installation does not require administrator access. The ScribeFlow installer
stays small and never contains or automatically transfers the approximately
3.2 GB speech model. Whisper downloads only after the in-app recommendation is
accepted. App upgrades preserve Whisper and local runtime settings under
`%LOCALAPPDATA%\ScribeFlow`. Saved notes and reusable templates live under
`OneDrive\Documents\ScribeFlow`; patient notes, PDFs, audio, templates, and
browser storage are never included in the installer.

Each normal ScribeFlow launch checks this public repository's latest Release.
When a newer version is available, the launcher downloads both the installer
and its SHA-256 file, verifies the package, applies the update, and then opens
ScribeFlow. If GitHub is unavailable, the update is skipped and the installed
version opens normally.

Owner-created `agent/*` pull requests are built and tested automatically. A
verified update is marked ready and squash-merged without requiring a manual
button click. App changes must increase the version in `package.json`.

Every merged app version on `main` automatically receives its matching Git tag,
verified Windows installer, SHA-256 file, and GitHub Release. This is the
Release checked by installed desktop shortcuts, so a pushed update cannot remain
stranded in an unpublished draft pull request.

Native Whisper remains a separate local component even though its controls are
built into ScribeFlow. This keeps large model files out of GitHub and out of app
updates. ScribeFlow compares the installed Whisper manifest with the version
expected by the current app. When a future verified runtime or model update is
available, the app keeps dictation working, shows a persistent notice, and asks
**Update Whisper?** with **Yes, update Whisper** and **No, not now** choices.
Choosing **No** closes the prompt for that session while leaving the update
button visible. For troubleshooting, the same verified installer can be run
directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-native-whisper.ps1
```

The runtime, weights, logs, caches, and temporary service state are kept
outside OneDrive under
`%LOCALAPPDATA%\ScribeFlow\native-whisper`. The native inference service binds
only to `127.0.0.1:3002`; the local document bridge remains on
`127.0.0.1:3001`. Audio is submitted as an in-memory WAV buffer and the native
server's file converter is disabled, so dictation is not written to disk.
Runtime model loading has no remote fallback, and the app response has a
content security policy that blocks other outbound connections.

When PDF auto-delete is checked, the app first asks the browser to remove the
selected file handle. If that browser operation is unavailable, the loopback
service can delete the exact matching PDF from the user's Downloads folder only
after verifying its filename, byte size, and SHA-256 hash. No PDF content is
uploaded to the service or retained.

## Clinical use

Notes remain in memory until **Save** is clicked. Saved notes are written as
HTML documents under `OneDrive\Documents\ScribeFlow\Notes`. Microphone samples,
parsed PDF values, and PDFs are not written to app storage or transmitted.
Audio samples are cleared after local transcription.

Templates and up to 20 timestamped recovery copies are protected under
`OneDrive\Documents\ScribeFlow\Templates`, so they can follow the signed-in
OneDrive account to another PC. A valid legacy template vault is migrated from
`%LOCALAPPDATA%\ScribeFlow` once, verified, and then removed from the old local
location. The browser copy remains an additional fallback, and the newest
valid copy is restored when the app starts. Quicktexts, vocabulary corrections,
and up to 20 timestamped recovery copies are synced through
`OneDrive\Documents\ScribeFlow\Writing Tools\writing-tools.json`. Existing
browser Quicktext and vocabulary entries are merged into this shared copy the
first time the updated app runs on each PC. ScribeFlow checks the same shared
root every five seconds and whenever its window regains focus, so changes made
on another PC appear without restarting. Templates, Quicktext, and vocabulary
all use the single `OneDrive\Documents\ScribeFlow` root; no second local
Documents path is used when OneDrive is available. The selected dictation
engine and microphone remain local to each PC. Do not place patient identifiers
in reusable configuration items.

Only use OneDrive for protected health information when that account and your
organization's configuration are approved for that purpose.

Review all generated text before clinical use and complete your organization's
privacy, security, and compliance review before entering protected health
information.
