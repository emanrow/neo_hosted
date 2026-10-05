'use strict';

// Branches of a book: whole alternate drafts, kept as copies of the book
// folder under <book>/.branches/<name>/. "main" is the book folder itself.
// A small file, <book>/.branches/active, names the branch the writer is in;
// library.js asks folderFor() where a book's files are and never knows more.
// The editor is unaware too: it reads and writes "the book", and the server
// points that at the active branch. Switching is therefore a page reload,
// never a merge of two drafts onto one page (web/public/web-branches.js).
//
// Everything is files, so a laptop without Postgres has branches too, the
// daily zip carries them, and trashing a book trashes its branches with it.
// The revision log keys rows by branch name (revisions.js), so each branch
// has its own history from the moment it is made.
//
// Gotchas:
// - A branch is copied from the branch the writer is in, not from main.
// - Deleting a branch moves it to the library's Trash; words are never discarded.
// - Covers, notes, outline, darlings and stickies are part of the copy: a
//   branch is the whole draft, as the writer would expect of "what if".

const fs = require('node:fs');
const path = require('node:path');
const { libName, writeFileDurable, readJSON, writeJSON } = require('./files');

const MAIN = 'main';
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const BRANCHES_DIR = '.branches';

/** A branch name as the writer typed it, or a thrown reason. */
function checkBranchName(name) {
  const trimmed = String(name || '').trim();
  if (!BRANCH_NAME.test(trimmed) || trimmed.toLowerCase() === MAIN) throw new Error('A branch name is up to 40 letters, digits, spaces, dashes or underscores, and not "main"');
  return libName(trimmed);
}

// main's folder holds the branches, so a copy of it must leave .branches out
// (fs.cpSync refuses to copy a folder into itself, filter or no filter)
function copyDraft(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === BRANCHES_DIR) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDraft(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dir   the library folder (the same one openLibrary gets)
 * @param {(source: string, err: unknown) => void} deps.logError
 */
function openBranches({ dir, logError }) {
  const bookRoot = (bookId) => path.join(dir, libName(bookId));
  const branchesDir = (bookId) => path.join(bookRoot(bookId), BRANCHES_DIR);
  const branchFolder = (bookId, name) => (name === MAIN ? bookRoot(bookId) : path.join(branchesDir(bookId), checkBranchName(name)));
  const activeFile = (bookId) => path.join(branchesDir(bookId), 'active');

  /** The branch the writer is in: "main" unless the active file names a branch that exists. */
  function activeBranch(bookId) {
    let name = '';
    try { name = fs.readFileSync(activeFile(bookId), 'utf8').trim(); } catch { return MAIN; }
    if (!name || name === MAIN) return MAIN;
    try { return fs.existsSync(branchFolder(bookId, name)) ? name : MAIN; } catch { return MAIN; }
  }

  /** Where the book's files are right now. library.js's bookDirFor. */
  const folderFor = (bookId) => branchFolder(bookId, activeBranch(bookId));

  function list(bookId) {
    const branches = [{ name: MAIN, createdAt: null, from: null }];
    try {
      for (const entry of fs.readdirSync(branchesDir(bookId), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const info = readJSON(path.join(branchesDir(bookId), entry.name, 'branch.json'), {}, () => {});
        branches.push({ name: entry.name, createdAt: info.createdAt || null, from: info.from || null });
      }
    } catch { /* no branches yet */ }
    branches.sort((a, b) => (a.name === MAIN ? -1 : b.name === MAIN ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))));
    return { active: activeBranch(bookId), branches };
  }

  /** Copies the branch the writer is in to a new one and moves them onto it. */
  function create(bookId, name) {
    const target = path.join(branchesDir(bookId), checkBranchName(name)); // "main" is refused here, not found
    const from = activeBranch(bookId);
    const source = branchFolder(bookId, from);
    if (!fs.existsSync(path.join(source, 'book.json'))) throw new Error('No such book');
    if (fs.existsSync(target)) throw new Error('A branch with that name already exists');
    fs.mkdirSync(branchesDir(bookId), { recursive: true });
    copyDraft(source, target);
    writeJSON(path.join(target, 'branch.json'), { name: path.basename(target), from, createdAt: new Date().toISOString() });
    switchTo(bookId, path.basename(target));
    return list(bookId);
  }

  function switchTo(bookId, name) {
    const target = name === MAIN ? MAIN : path.basename(branchFolder(bookId, name));
    if (target !== MAIN && !fs.existsSync(branchFolder(bookId, target))) throw new Error('No such branch');
    fs.mkdirSync(branchesDir(bookId), { recursive: true });
    writeFileDurable(activeFile(bookId), target + '\n');
    return list(bookId);
  }

  /** A branch goes to the library's Trash, never away. The active branch and main stay. */
  function remove(bookId, name) {
    const target = branchFolder(bookId, name);
    if (name === MAIN) throw new Error('The main draft cannot be deleted; delete the book instead');
    if (path.basename(target) === activeBranch(bookId)) throw new Error('Switch to another branch first');
    if (!fs.existsSync(target)) throw new Error('No such branch');
    try {
      const trash = path.join(dir, 'Trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.renameSync(target, path.join(trash, `${libName(bookId)}--branch-${path.basename(target)}--${stamp}`));
    } catch (err) {
      logError('branch trash', err);
      throw new Error('Could not move the branch to Trash');
    }
    return list(bookId);
  }

  return { MAIN, activeBranch, folderFor, list, create, switchTo, remove };
}

module.exports = { openBranches, checkBranchName, MAIN_BRANCH: MAIN };
