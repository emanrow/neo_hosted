'use strict';

// Interface language on the server: which locales/ files exist, which one a
// writer gets, and a translator for the few strings the server itself writes
// into a library (shelf names, "Untitled", the catalog header) and says on
// the sign-in page.
//
// The hosted edition's own strings (the sign-in page, its errors) live in
// web/locales/<code>.json, laid over upstream's locales/<code>.json for the
// same code, so upstream's files are never edited here and the editor's
// language list is still upstream's.
//
// Gotcha: the shared i18n.js is a singleton with one current locale. The
// translator returned here sets that locale on every call, and the library
// code that uses it is synchronous, so two writers' requests never see each
// other's language. Do not hold a t() across an await.

const fs = require('node:fs');
const path = require('node:path');
const NeoI18n = require('../../i18n.js');

const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');
const HOSTED_LOCALES_DIR = path.join(__dirname, '..', 'locales');
const CODE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const normCode = (c) => String(c || '').replace(/_/g, '-');

function readLocaleFile(code, dir = LOCALES_DIR) {
  if (!CODE.test(code)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8')); } catch { return null; }
}

/** The hosted edition's strings for one code, without the _meta entry. */
function hostedStrings(code) {
  const { _meta, ...strings } = readLocaleFile(code, HOSTED_LOCALES_DIR) || {};
  return strings;
}

/** Every locales/<code>.json, named in its own words, sorted by name. */
function listLanguages() {
  const out = [];
  for (const f of fs.readdirSync(LOCALES_DIR)) {
    const m = f.match(/^([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)\.json$/);
    if (!m) continue;
    const data = readLocaleFile(m[1]);
    if (!data) continue;
    out.push({ code: m[1], name: (data._meta && data._meta.name) || m[1] });
  }
  if (!out.some((l) => l.code === 'en')) out.push({ code: 'en', name: 'English' });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** fr-CA → fr-CA if NEO has it, else fr, else null. */
function resolveLanguage(wanted) {
  wanted = normCode(wanted);
  if (!wanted) return null;
  const codes = listLanguages().map((l) => l.code);
  for (const c of [wanted, wanted.split('-')[0]]) {
    const hit = codes.find((x) => x.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** The chosen language's strings: its base language, then the regional file on top. */
function localeDict(code) {
  if (code === 'en') return { ...(readLocaleFile('en') || {}), ...hostedStrings('en') };
  const base = code.split('-')[0];
  const dict = base !== code ? { ...(readLocaleFile(base) || {}), ...hostedStrings(base) } : {};
  Object.assign(dict, readLocaleFile(code) || {}, hostedStrings(code));
  return dict;
}

/** What the page reads as window.neo.i18n before app.js runs. */
function bundleFor(code) {
  const locale = resolveLanguage(code) || 'en';
  return { locale, dict: localeDict(locale), base: readLocaleFile('en') || {} };
}

/** A t() for one writer. See the gotcha at the top of this file. */
function translatorFor(code) {
  const { locale, dict, base } = bundleFor(code);
  return (key, vars) => {
    NeoI18n.setLocale(locale, dict, base);
    return NeoI18n.t(key, vars);
  };
}

/**
 * The writer's saved choice wins; a first visit follows the browser's
 * Accept-Language when NEO speaks it; English otherwise.
 */
function pickLanguage({ saved, acceptLanguage }) {
  if (saved && resolveLanguage(saved)) return resolveLanguage(saved);
  for (const part of String(acceptLanguage || '').split(',')) {
    const tag = part.split(';')[0].trim();
    const hit = tag && resolveLanguage(tag);
    if (hit) return hit;
  }
  return 'en';
}

module.exports = { listLanguages, resolveLanguage, localeDict, hostedStrings, bundleFor, translatorFor, pickLanguage, HOSTED_LOCALES_DIR };
