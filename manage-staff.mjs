// Emergency staff tool: run on the server when nobody can sign in.
//   node manage-staff.mjs list
//   STAFF_PASSWORD='a-long-password' node manage-staff.mjs create-owner you@email.com "Your Name"
//   STAFF_PASSWORD='a-long-password' node manage-staff.mjs reset-password you@email.com
// The password comes from the STAFF_PASSWORD environment variable so it never appears in the command history.
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'), 'xpress.db'));
const [cmd, email, name] = process.argv.slice(2), pw = process.env.STAFF_PASSWORD || '';
const hash = (p, salt) => crypto.scryptSync(p, salt, 64).toString('hex'), now = () => new Date().toISOString();
const need = () => { if (pw.length < 10) { console.error('Set STAFF_PASSWORD to a password of at least 10 characters.'); process.exit(1); } };
try { db.prepare('SELECT 1 FROM staff LIMIT 1').get(); } catch { console.error('No staff table yet. Start the server once first (node server.mjs), then run this.'); process.exit(1); }

if (cmd === 'list') { for (const s of db.prepare('SELECT id,email,name,role,active,last_login FROM staff ORDER BY id').all()) console.log(`${s.id}\t${s.active ? 'active  ' : 'disabled'}\t${s.role}\t${s.email}\t${s.name}\tlast login ${s.last_login || 'never'}`); }
else if (cmd === 'create-owner' && email) {
  need(); const salt = crypto.randomBytes(16).toString('hex'), e = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM staff WHERE lower(email)=?').get(e)) { console.error('That email already has an account. Use reset-password.'); process.exit(1); }
  db.prepare("INSERT INTO staff(email,name,role,pw_salt,pw_hash,created_at) VALUES(?,?,'owner',?,?,?)").run(e, name || e, salt, hash(pw, salt), now());
  console.log(`Owner account created for ${e}. They can sign in at /admin/.`);
} else if (cmd === 'reset-password' && email) {
  need(); const salt = crypto.randomBytes(16).toString('hex'), s = db.prepare('SELECT id FROM staff WHERE lower(email)=?').get(email.toLowerCase());
  if (!s) { console.error('No staff account with that email.'); process.exit(1); }
  db.prepare('UPDATE staff SET pw_salt=?,pw_hash=?,must_change=1,active=1 WHERE id=?').run(salt, hash(pw, salt), s.id); db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(s.id);
  console.log('Password reset. They will be asked to choose a new one at next sign-in.');
} else console.log('Usage: node manage-staff.mjs list | create-owner <email> "<name>" | reset-password <email>   (password via STAFF_PASSWORD)');
