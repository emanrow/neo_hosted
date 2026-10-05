'use strict';

// One zip of a writer's library per day, kept for two weeks. Both libraries
// use this: the file library walks its folder into the zip, the Postgres
// library writes its rows out in the same layout. Either way the zip is the
// desktop app's folder, so it opens in desktop NEO.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileDurable } = require('./files');

const BACKUPS_KEPT = 14;

/**
 * Writes today's zip into `backupsDir` unless it is already there, then
 * prunes the oldest beyond BACKUPS_KEPT. `fill(zip)` adds the files.
 * Returns true when a zip was written.
 *
 * @param {{ backupsDir: string, fill: (zip: import('jszip')) => Promise<void> | void }} job
 */
async function dailyZip({ backupsDir, fill }) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const target = path.join(backupsDir, `neo-backup-${today}.zip`);
  if (fs.existsSync(target)) return false;
  const JSZip = require('jszip');
  const zip = new JSZip();
  await fill(zip);
  writeFileDurable(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-')).sort();
  while (backups.length > BACKUPS_KEPT) fs.unlinkSync(path.join(backupsDir, backups.shift()));
  return true;
}

module.exports = { dailyZip, BACKUPS_KEPT };
