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

**In this repo:** user-facing texts are the Chrome extension's popup and toolbar tooltip
(`extension/popup.html`, `extension/popup.js`, `extension/background.js`) and the debug GUI
(`ui/index.html`, `ui/app.js`).

- **Extension:** `chrome.i18n` with `extension/_locales/<lang>/messages.json`
  (`default_locale: "en"`; Chrome's folder for Norwegian Bokmål is `nb`, a `no` folder is
  ignored). HTML gets its texts from `data-i18n` / `data-i18n-aria-label` via
  `extension/i18n.js` (`__MSG_…__` only works in the manifest and CSS). Counted texts are
  `<key>_<plural category>` and go through `plural()`.
- **Debug GUI:** the table in `ui/i18n.js` (`t`, `tc` for counts, `tNodes` for texts with
  markup), locale from `navigator.language`. HTML uses `data-i18n`,
  `data-i18n-placeholder` and `data-i18n-aria-label`.
- `src/i18n.test.ts` (part of `npm test`) fails when a language misses a key, a
  placeholder or a plural form, or when code uses a key English does not define.
- Stays English on purpose: MCP/protocol names (`tools/list`, `list_changed`, tool names),
  error texts sent to agents, daemon log lines and event titles, the product name.
