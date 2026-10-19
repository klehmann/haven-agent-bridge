// Texts of the popup and the toolbar button, from _locales/<lang>/messages.json.
// Loaded as a classic script by the popup and imported by the service worker.
(() => {
  const lang = () => chrome.i18n.getUILanguage();

  /** Message by key; substitutions in the order the English message defines them. */
  function msg(key, ...subs) {
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
  }

  /** Counted message: `<key>_<plural category>` with the count as first substitution. */
  function plural(key, count) {
    const category = new Intl.PluralRules(lang()).select(count);
    const text = chrome.i18n.getMessage(`${key}_${category}`, [count.toLocaleString(lang())]);
    return text || msg(`${key}_other`, count.toLocaleString(lang()));
  }

  /** Fills data-i18n (text) and data-i18n-aria-label attributes below `root`. */
  function localize(root) {
    document.documentElement.lang = lang();
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = msg(node.dataset.i18n);
    for (const node of root.querySelectorAll("[data-i18n-aria-label]")) node.setAttribute("aria-label", msg(node.dataset.i18nAriaLabel));
  }

  globalThis.habI18n = { msg, plural, localize };
})();
