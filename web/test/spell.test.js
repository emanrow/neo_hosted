'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const { SpellService, defaultSpellLanguage } = require('../lib/spell');

describe('spellcheck', () => {
  test('follows the interface language when NEO has its dictionary', () => {
    assert.equal(defaultSpellLanguage('fr'), 'fr');
    assert.equal(defaultSpellLanguage('fr-CA'), 'fr');
    assert.equal(defaultSpellLanguage('pt'), 'pt-BR');
    assert.equal(defaultSpellLanguage('it'), 'en-US');
    assert.equal(defaultSpellLanguage(undefined), 'en-US');
  });

  test('checks against the shared dictionary with a writer\'s own words laid on top', async () => {
    const errors = [];
    const spell = new SpellService({ nodeModulesDir: path.join(__dirname, '..', 'node_modules'), logError: (s, e) => errors.push(e) });
    const result = await spell.check('en-US', ['hello', 'helo', 'Zarquon', ''], ['Zarquon']);
    assert.deepEqual(result, { hello: true, helo: false, Zarquon: true, '': true });
    const plain = await spell.check('en-US', ['Zarquon'], []);
    assert.equal(plain.Zarquon, false, 'another writer does not inherit the word');
    const suggestions = await spell.suggest('en-US', 'helo');
    assert.ok(suggestions.includes('hello'), String(suggestions));
    assert.ok(suggestions.length <= 6);
    assert.deepEqual(errors, []);
  });

  test('an unknown language falls back to US English and nothing is wrong while a load fails', async () => {
    const spell = new SpellService({ nodeModulesDir: '/nowhere', logError: () => {} });
    assert.equal(spell.knows('xx'), false);
    assert.deepEqual(await spell.check('en-US', ['anything'], []), { anything: true });
    assert.deepEqual(await spell.suggest('en-US', 'anything'), []);
  });
});
