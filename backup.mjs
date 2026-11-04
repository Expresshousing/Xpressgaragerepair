// Safe backups of everything that matters: the database and customer photos.
//   node backup.mjs                   -> creates  backups/xpress-YYYY-MM-DD-HHMM.tar.gz  (keeps the newest 14)
//   node backup.mjs restore <file>    -> restores a backup (stop the server first!)
// The database is copied with SQLite's own backup routine, so it is consistent even while the site is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)), DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'), OUT = process.env.BACKUP_DIR || path.join(ROOT, 'backups'), KEEP = +process.env.BACKUP_KEEP || 14;
const [cmd, file] = process.argv.slice(2);

if (cmd === 'restore') {
  if (!file || !fs.existsSync(file)) { console.error('Usage: node backup.mjs restore <backup.tar.gz>'); process.exit(1); }
  if (fs.existsSync(path.join(DATA, 'xpress.db-wal')) && fs.statSync(path.join(DATA, 'xpress.db-wal')).size > 0) console.warn('WARNING: the site looks like it is still running. Stop it first (sudo systemctl stop xpress), then restore.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-restore-'));
  try { execFileSync('tar', ['-xzf', file, '-C', tmp], { stdio: 'pipe' }); } catch { console.error('That file is not a valid backup archive.'); process.exit(1); }
  if (!fs.existsSync(path.join(tmp, 'xpress.db'))) { console.error('That archive has no xpress.db. Not a valid backup.'); process.exit(1); }
  if (fs.existsSync(DATA)) { const keep = DATA + '.before-restore-' + Date.now(); fs.renameSync(DATA, keep); console.log(`Your current data was moved aside to ${keep}`); }
  fs.mkdirSync(DATA, { recursive: true }); fs.copyFileSync(path.join(tmp, 'xpress.db'), path.join(DATA, 'xpress.db'));
  if (fs.existsSync(path.join(tmp, 'uploads'))) fs.cpSync(path.join(tmp, 'uploads'), path.join(DATA, 'uploads'), { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true }); console.log('Restored. Start the site again.'); process.exit(0);
}

if (!fs.existsSync(path.join(DATA, 'xpress.db'))) { console.error('No database found at data/xpress.db. Nothing to back up yet.'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, ''), stage = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-backup-'));
const src = new DatabaseSync(path.join(DATA, 'xpress.db'));
await backup(src, path.join(stage, 'xpress.db')); src.close();
if (fs.existsSync(path.join(DATA, 'uploads'))) fs.cpSync(path.join(DATA, 'uploads'), path.join(stage, 'uploads'), { recursive: true });
const target = path.join(OUT, `xpress-${stamp}.tar.gz`);
execFileSync('tar', ['-czf', target, '-C', stage, '.']); fs.rmSync(stage, { recursive: true, force: true }); fs.chmodSync(target, 0o600);
const all = fs.readdirSync(OUT).filter(f => /^xpress-.*\.tar\.gz$/.test(f)).sort();
for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.unlinkSync(path.join(OUT, old));
console.log(`Backup saved: ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB). Keeping the newest ${KEEP}.`);
