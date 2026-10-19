/**
 * Every user-facing text ships in all languages Haven offers. These tests fail
 * when a language misses a key, a placeholder or a plural form, or when the
 * code uses a key English does not define.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCALES = ["en", "de", "es", "fr", "it", "nb", "nl", "pl"];
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const categories = (locale: string) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[];
const sorted = (values: Iterable<string>) => [...values].sort();
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

describe("extension messages (chrome.i18n)", () => {
  type Message = { message: string; placeholders?: Record<string, { content: string }> };
  const bundles = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(read(`extension/_locales/${l}/messages.json`)) as Record<string, Message>]),
  );
  const en = bundles.en;
  const bases = new Set(Object.keys(en).filter((k) => PLURAL_SUFFIX.test(k)).map((k) => k.replace(PLURAL_SUFFIX, "")));

  it("has a folder for exactly the supported languages (Chrome calls Norwegian Bokmål nb)", () => {
    expect(sorted(readdirSync(join(ROOT, "extension/_locales")))).toEqual(sorted(LOCALES));
    expect(JSON.parse(read("extension/manifest.json")).default_locale).toBe("en");
  });

  for (const locale of LOCALES) {
    it(`${locale}: same keys and placeholders as en, all plural forms`, () => {
      const bundle = bundles[locale];
      const plain = (b: Record<string, Message>) => Object.keys(b).filter((k) => !PLURAL_SUFFIX.test(k));
      expect(sorted(plain(bundle))).toEqual(sorted(plain(en)));
      for (const base of bases) {
        const forms = Object.keys(bundle).filter((k) => k.replace(PLURAL_SUFFIX, "") === base && PLURAL_SUFFIX.test(k));
        expect(sorted(forms), `${locale} ${base}`).toEqual(sorted(categories(locale).map((c) => `${base}_${c}`)));
      }
      for (const [key, entry] of Object.entries(bundle)) {
        expect(entry.message.trim(), `${locale} ${key}`).not.toBe("");
        const reference = en[key] ?? en[`${key.replace(PLURAL_SUFFIX, "")}_other`];
        const contents = (m: Message) => Object.fromEntries(Object.entries(m.placeholders ?? {}).map(([n, p]) => [n, p.content]));
        expect(contents(entry), `${locale} ${key} placeholders`).toEqual(contents(reference));
        const used = sorted(new Set([...entry.message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase())));
        expect(used, `${locale} ${key} uses its placeholders`).toEqual(sorted(Object.keys(entry.placeholders ?? {})));
      }
    });
  }

  it("code only uses keys English defines", () => {
    const code = ["extension/popup.html", "extension/popup.js", "extension/background.js"].map(read).join("\n");
    const keys = [
      ...[...code.matchAll(/\bmsg\("(\w+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/data-i18n(?:-aria-label)?="(\w+)"/g)].map((m) => m[1]),
      ...[...read("extension/manifest.json").matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
    ];
    const plurals = [...code.matchAll(/\bplural\("(\w+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(en, key).toHaveProperty(key);
    for (const key of plurals) expect(bases.has(key), key).toBe(true);
  });
});

describe("debug GUI messages (ui/i18n.js)", () => {
  const source = read("ui/i18n.js");
  const load = (language?: string) =>
    runInNewContext(`${source}\n;({ HAB_MESSAGES, LOCALE, t, tc, habPickLocale })`, language ? { navigator: { language } } : {}) as {
      HAB_MESSAGES: Record<string, Record<string, string | Record<string, string>>>;
      LOCALE: string;
      t: (key: string, vars?: Record<string, unknown>) => string;
      tc: (key: string, count: number, vars?: Record<string, unknown>) => string;
      habPickLocale: (tag: string) => string;
    };
  const { HAB_MESSAGES: messages, habPickLocale } = load();
  const en = messages.en;
  const names = (text: string) => sorted(new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

  it("offers exactly the supported languages", () => {
    expect(sorted(Object.keys(messages))).toEqual(sorted(LOCALES));
  });

  for (const locale of LOCALES) {
    it(`${locale}: same keys, placeholders and all plural forms`, () => {
      const table = messages[locale];
      expect(sorted(Object.keys(table))).toEqual(sorted(Object.keys(en)));
      for (const [key, value] of Object.entries(table)) {
        const reference = en[key];
        if (typeof reference === "string") {
          expect(typeof value, `${locale} ${key}`).toBe("string");
          expect((value as string).trim(), `${locale} ${key}`).not.toBe("");
          expect(names(value as string), `${locale} ${key}`).toEqual(names(reference));
        } else {
          expect(typeof value, `${locale} ${key}`).toBe("object");
          const forms = value as Record<string, string>;
          expect(sorted(Object.keys(forms)), `${locale} ${key} plural forms`).toEqual(sorted(categories(locale)));
          for (const [category, text] of Object.entries(forms)) {
            expect(text.trim(), `${locale} ${key} ${category}`).not.toBe("");
            expect(names(text), `${locale} ${key} ${category}`).toEqual(names(reference.other));
          }
        }
      }
    });
  }

  it("code only uses keys English defines", () => {
    const code = read("ui/app.js") + read("ui/index.html");
    const keys = [
      ...[...code.matchAll(/\bt(?:c|Nodes)?\("(\w+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/data-i18n(?:-placeholder|-aria-label)?="(\w+)"/g)].map((m) => m[1]),
    ];
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) expect(en, key).toHaveProperty(key);
  });

  it("maps browser languages by their primary subtag", () => {
    expect(habPickLocale("de-AT")).toBe("de");
    expect(habPickLocale("nb-NO")).toBe("nb");
    expect(habPickLocale("no")).toBe("nb");
    expect(habPickLocale("nn-NO")).toBe("nb");
    expect(habPickLocale("pt-BR")).toBe("en");
    expect(habPickLocale("")).toBe("en");
  });

  it("picks Polish plural forms", () => {
    const { tc, LOCALE } = load("pl-PL");
    expect(LOCALE).toBe("pl");
    expect(tc("toolsCount", 1)).toBe("1 narzędzie");
    expect(tc("toolsCount", 3)).toBe("3 narzędzia");
    expect(tc("toolsCount", 5)).toBe("5 narzędzi");
  });
});
