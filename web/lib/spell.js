'use strict';

// Spellcheck for every writer at once. Hunspell (WebAssembly) reads the same
// .aff/.dic packages the desktop app ships, one instance per language shared
// by everyone, loaded the first time anyone asks for that language. A
// writer's own words (library.json customWords) are laid over the top at
// check time instead of being added to the shared instance, so one writer's
// character names never pass another writer's check.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeRomanianWord } = require('../../spell-ro');

// the same table as main.js SPELL_LANGUAGES
const SPELL_LANGUAGES = {
  'en-US': { label: 'English (US)', pkg: 'dictionary-en-us' },
  'en-GB': { label: 'English (UK)', pkg: 'dictionary-en-gb' },
  'en-CA': { label: 'English (Canada)', pkg: 'dictionary-en-ca' },
  'en-AU': { label: 'English (Australia)', pkg: 'dictionary-en-au' },
  'fr': { label: 'Français', pkg: 'dictionary-fr' },
  'es': { label: 'Español', pkg: 'dictionary-es' },
  'de': { label: 'Deutsch', pkg: 'dictionary-de' },
  'nl': { label: 'Nederlands', pkg: 'dictionary-nl' },
  'pl': { label: 'Polski', pkg: 'dictionary-pl' },
  'pt-BR': { label: 'Português (Brasil)', pkg: 'dictionary-pt' },
  'ro': { label: 'Română', pkg: 'dictionary-ro' },
  'ru': { label: 'Русский', pkg: 'dictionary-ru' },
  'el': { label: 'Ελληνικά', pkg: 'dictionary-el' }
};

/** Spellcheck follows the interface language when NEO has its dictionary, else US English. */
function defaultSpellLanguage(uiLanguage) {
  const ui = String(uiLanguage || 'en');
  if (SPELL_LANGUAGES[ui]) return ui;
  if (ui === 'pt' || ui === 'pt-BR') return 'pt-BR';
  const base = ui.split('-')[0];
  return SPELL_LANGUAGES[base] ? base : 'en-US';
}

class SpellService {
  /** @param {{ nodeModulesDir: string, logError: Function }} opts */
  constructor({ nodeModulesDir, logError }) {
    this.nodeModulesDir = nodeModulesDir;
    this.logError = logError || (() => {});
    this.factory = null;
    this.checkers = new Map(); // code -> Promise<{ spell, suggest }>
    this.mounts = 0;
  }

  knows(code) { return !!SPELL_LANGUAGES[code]; }

  /** The checker for a language, loading it on first use; a failed load is not cached. */
  checker(code) {
    const known = SPELL_LANGUAGES[code] ? code : 'en-US';
    if (!this.checkers.has(known)) {
      const loading = this.load(known).catch((err) => {
        this.checkers.delete(known);
        this.logError('spell', err);
        return null;
      });
      this.checkers.set(known, loading);
    }
    return this.checkers.get(known);
  }

  async load(code) {
    const { loadModule } = require('@farscrl/hunspell-wasm');
    if (!this.factory) this.factory = await loadModule();
    const dir = path.join(this.nodeModulesDir, SPELL_LANGUAGES[code].pkg);
    const n = ++this.mounts;
    const aff = this.factory.mountBuffer(fs.readFileSync(path.join(dir, 'index.aff')), `neo-${n}.aff`);
    const dic = this.factory.mountBuffer(fs.readFileSync(path.join(dir, 'index.dic')), `neo-${n}.dic`);
    const hunspell = this.factory.create(aff, dic);
    const normalize = code === 'ro' ? normalizeRomanianWord : (word) => word;
    return {
      spell: (word) => hunspell.spell(normalize(word)),
      suggest: (word) => hunspell.suggest(normalize(word)).slice(0, 6)
    };
  }

  /** {word: isCorrect}. With no checker (still loading, or failed) everything is correct: never cry wolf. */
  async check(code, words, customWords = []) {
    const checker = await this.checker(code);
    const mine = new Set(customWords.filter((w) => typeof w === 'string'));
    const out = {};
    for (const word of words || []) out[word] = !checker || !word || mine.has(word) || checker.spell(word);
    return out;
  }

  async suggest(code, word) {
    const checker = await this.checker(code);
    return checker && word ? checker.suggest(word) : [];
  }
}

module.exports = { SpellService, SPELL_LANGUAGES, defaultSpellLanguage };
