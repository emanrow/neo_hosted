'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { softHyphens, patternsFor, LANGUAGE_MODULES } = require('../hyphenate');

const SHY = '­';

describe('soft hyphens', () => {
  test('every language the editor speaks has patterns', () => {
    const locales = fs.readdirSync(path.join(__dirname, '..', '..', 'locales')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.replace('.json', ''));
    for (const locale of locales) assert.ok(patternsFor(locale), `${locale} hyphenates`);
    assert.equal(patternsFor('xx'), null);
    assert.equal(patternsFor(''), null);
    assert.ok(Object.values(LANGUAGE_MODULES).every((m) => typeof require(`hyphen/${m}`).hyphenateSync === 'function'));
  });

  test('breaks the paragraphs and nothing else', () => {
    const html = '<!DOCTYPE html><html><head><style>@font-face { src: url(data:font/woff2;base64,extraordinaryresponsibility) }</style></head>'
      + '<body><div class="titlepage"><h1>Extraordinary</h1><p class="auth">Responsibility Administration</p></div>'
      + '<section class="chapter"><h2 class="hd">Responsibility</h2>'
      + '<p class="extraordinary">The administration &amp; <b>responsibility</b>, <img alt="extraordinary" src="data:image/png;base64,responsibility"></p>'
      + '<p class="brk">***</p><p class="byline">Extraordinary Person</p></section></body></html>';
    const out = softHyphens(html, 'en');
    assert.ok(out.includes('<h1>Extraordinary</h1>') && out.includes('<h2 class="hd">Responsibility</h2>'), 'headings are untouched');
    assert.ok(out.includes('<p class="auth">Responsibility Administration</p>') && out.includes('<p class="byline">Extraordinary Person</p>'), 'the lines a running head is set from are untouched');
    assert.match(out, new RegExp(`ad${SHY}min${SHY}is${SHY}tra${SHY}tion`));
    assert.match(out, new RegExp(`<b>re${SHY}spon${SHY}si${SHY}bil${SHY}i${SHY}ty</b>`));
    assert.ok(out.includes('base64,extraordinaryresponsibility)'), 'the head is untouched');
    assert.ok(out.includes('class="extraordinary"') && out.includes('alt="extraordinary"') && out.includes('base64,responsibility"'), 'attributes are untouched');
    assert.ok(out.includes('&amp;'), 'entities survive');
  });

  test('speaks the writer\'s language, and leaves a document alone when it cannot', () => {
    assert.match(softHyphens('<body><p>wunderschönen</p></body>', 'de'), new RegExp(`wun${SHY}der${SHY}schö${SHY}nen`));
    assert.match(softHyphens('<body><p>responsabilidade</p></body>', 'pt-PT'), new RegExp(SHY));
    const plain = '<body><p>responsabilidade</p></body>';
    assert.equal(softHyphens(plain, 'xx'), plain);
    assert.equal(softHyphens('responsibility', 'en'), 'responsibility', 'a fragment with no body is not a book');
  });
});
