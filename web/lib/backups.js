'use strict';

// One zip of a writer's library per day, kept for two weeks. Both libraries
// use this: the file library walks its folder into the zip, the Postgres
// library writes its rows out in the same layout. Either way the zip is the
// desktop app's folder, so it opens in desktop NEO.
//
// With an off-site `copy`, each zip is also handed to it once; a copy that
// fails is retried on the next sweep (hourly) until it lands, and a small
// `.offsite` marker beside the zip records that it did. Losing the volume
// loses the markers too, which is fine: they only say "already copied".

const fs = require('node:fs');
const path = require('node:path');
const { writeFileDurable } = require('../../library-disk');

const BACKUPS_KEPT = 14;
const OFFSITE_MARK = '.offsite';

/**
 * Writes today's zip into `backupsDir` unless it is already there, then
 * prunes the oldest beyond BACKUPS_KEPT. `fill(zip)` adds the files.
 * `copy(name, bytes)`, when given, sends the zip off-site; it runs after the
 * local write and again on later calls until it succeeds, so its error is
 * the caller's to log and the zip on the volume is never at risk.
 * Returns true when a zip was written.
 *
 * @param {{ backupsDir: string, fill: (zip: import('jszip')) => Promise<void> | void, copy?: (name: string, bytes: Buffer) => Promise<void> }} job
 */
async function dailyZip({ backupsDir, fill, copy }) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const name = `neo-backup-${today}.zip`;
  const target = path.join(backupsDir, name);
  if (fs.existsSync(target)) {
    if (copy && !fs.existsSync(target + OFFSITE_MARK)) await sendOffsite(copy, target, name, fs.readFileSync(target));
    return false;
  }
  const JSZip = require('jszip');
  const zip = new JSZip();
  await fill(zip);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileDurable(target, bytes);
  const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-') && f.endsWith('.zip')).sort();
  while (backups.length > BACKUPS_KEPT) {
    const old = path.join(backupsDir, backups.shift());
    fs.unlinkSync(old);
    fs.rmSync(old + OFFSITE_MARK, { force: true });
  }
  if (copy) await sendOffsite(copy, target, name, bytes);
  return true;
}

async function sendOffsite(copy, target, name, bytes) {
  await copy(name, bytes);
  fs.writeFileSync(target + OFFSITE_MARK, new Date().toISOString() + '\n');
}

module.exports = { dailyZip, BACKUPS_KEPT, OFFSITE_MARK };
