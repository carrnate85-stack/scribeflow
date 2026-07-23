# ScribeFlow

ScribeFlow is a focused, local-first clinical dictation workspace. It combines
live browser speech recognition with an editable note, reusable dot phrases,
structured clinical templates, automatic device-local saving, and copy or text
export.

## Included workflows

- Start and stop live dictation with the microphone control or
  `Ctrl + Shift + Space`.
- Type a shortcut such as `.normalexam` followed by Space to expand quicktext.
- Start from SOAP, follow-up, consultation, or procedure templates.
- Create personal quicktexts that persist in the browser.
- Copy or download the completed note.

## Development

```sh
pnpm install
pnpm dev
```

Run `pnpm build` for a production build.

## Clinical use

This prototype stores note text in the current browser's local storage. Browser
speech-recognition implementations may use a browser vendor's speech service.
Review all generated text before clinical use and complete your organization's
privacy, security, and compliance review before entering protected health
information.
