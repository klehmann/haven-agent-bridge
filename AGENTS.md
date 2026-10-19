# AGENTS.md

Notes for people and coding agents working on this repo.

## Languages

Every user-facing string ships in all languages the product supports, in the same
change that adds it: labels, buttons, placeholders, empty states, errors,
`aria-label`s, notifications and dialogs. For Haven and its apps that is
**en, de, es, fr, it, nb, nl, pl** — never only English, never only English and German.

- **Make a gap impossible to merge.** Typed tables
  (`satisfies Record<Locale, Messages>`, `Messages` derived from English), in Rust a
  `match` over the language enum, or — with one file per locale — a test that compares
  every locale's keys and `{placeholders}` with `en`. Falling back to English is for
  languages Haven does not offer, not for strings nobody translated.
- **Map the tag** by its primary subtag: `de-AT` → `de`, `no`/`nn` → `nb`, anything
  else → `en`. Dates and numbers go through `Intl` with the active locale.
- **Say it as Haven says it.** Haven's terms (database, tenant, attachment, …) and its
  form of address: German *du*, Spanish *tú*, French *vous*, Italian *tu*,
  Norwegian *du*, Dutch *je*, Polish informal.

**In this repo:** user-facing texts are the Chrome extension's popup
(`extension/popup.html`, `extension/popup.js`) and the debug GUI (`ui/index.html`,
`ui/app.js`). For the extension, `chrome.i18n` with `extension/_locales/<lang>/messages.json`
(`default_locale: "en"`) is the natural place; for the GUI, a typed table.

**Known gap:** the bridge is English only today (both the popup and the debug GUI have
hard-coded English strings, `lang="en"`). New texts must not widen the gap; moving the
existing ones into tables is open work.
