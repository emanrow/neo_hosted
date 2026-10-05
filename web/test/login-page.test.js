'use strict';

// The sign-in page in the visitor's language: the hosted overlays are
// complete and keep their placeholders, the template renders in German with
// every marker replaced and nothing unescaped, and English is the fallback.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../lib/i18n');
const { buildLoginPage, PAGE_STRINGS } = require('../lib/login-page');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
const english = i18n.hostedStrings('en');

describe('web/locales', () => {
  test('every language the editor speaks has the hosted strings, and each keeps its placeholders', () => {
    const codes = i18n.listLanguages().map((l) => l.code);
    const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    for (const code of codes) {
      const strings = i18n.hostedStrings(code);
      for (const key of Object.keys(english)) {
        assert.ok(strings[key], `${code} is missing: ${key}`);
        assert.equal(placeholders(strings[key]), placeholders(key), `${code} placeholders in: ${key}`);
      }
      for (const key of Object.keys(strings)) assert.ok(english[key], `${code} has a key English does not: ${key}`);
    }
  });

  test('the hosted strings lay over upstream\'s dictionary for the same code', () => {
    const de = i18n.localeDict('de');
    assert.equal(de['Sign in'], 'Anmelden');
    assert.equal(i18n.localeDict('fr-CA').Email, 'Courriel', 'the regional file wins');
    assert.equal(i18n.localeDict('fr').Email, 'E-mail');
    assert.ok(de['(none — removed from shelves)'], 'upstream\'s own strings are still there');
  });
});

describe('buildLoginPage', () => {
  test('its stylesheet and script carry the deploy fingerprint when given one', () => {
    const page = buildLoginPage(html, { locale: 'en', t: i18n.translatorFor('en'), assetVersion: 'deadbeef00' });
    assert.ok(page.includes('href="/web/web.css?v=deadbeef00"') && page.includes('src="/web/login.js?v=deadbeef00"'));
    assert.ok(!buildLoginPage(html, { locale: 'en', t: i18n.translatorFor('en') }).includes('?v='), 'without one the URLs stay bare');
  });

  test('renders German with every marker replaced and the run-time strings in a JSON block', () => {
    const page = buildLoginPage(html, { locale: 'de', t: i18n.translatorFor('de') });
    assert.match(page, /^<!DOCTYPE html>\n<html lang="de">/);
    assert.match(page, /<title>NEO — Anmelden<\/title>/);
    assert.match(page, /<label for="email">E-Mail<\/label>/);
    assert.match(page, /id="submit">Anmelden</);
    assert.ok(!/\{\{/.test(page), 'no marker left behind');
    assert.match(page, /<a href="https:\/\/github.com\/hughhowey\/neo"[^>]*>Hugh Howey<\/a>, MIT-lizenziert\./, 'the credit keeps its link');
    assert.match(page, /<a href="https:\/\/github.com\/emanrow\/neo_hosted"[^>]*>gehostete Ausgabe<\/a>/);
    const block = page.match(/<script type="application\/json" id="login-strings">(.*?)<\/script>/s);
    assert.ok(block, 'the JSON block is there');
    const strings = JSON.parse(block[1]);
    assert.deepEqual(Object.keys(strings).sort(), [...PAGE_STRINGS].sort());
    assert.equal(strings['Create account'], 'Konto erstellen');
    assert.ok(!/<script>/.test(page), 'no inline script');
  });

  test('escapes what a translation might carry', () => {
    const t = (key) => (key === 'Email' ? '<b>"Mail"</b> & co' : key);
    const page = buildLoginPage(html, { locale: 'x"y', t });
    assert.match(page, /<label for="email">&lt;b&gt;&quot;Mail&quot;&lt;\/b&gt; &amp; co<\/label>/);
    assert.match(page, /<html lang="x&quot;y">/);
  });

  test('English is itself', () => {
    const page = buildLoginPage(html, { locale: 'en', t: i18n.translatorFor('en') });
    assert.match(page, /<html lang="en">/);
    assert.match(page, /<title>NEO — Sign in<\/title>/);
    assert.match(page, /Your books are yours: download your whole library any time from the File menu\./);
  });
});
