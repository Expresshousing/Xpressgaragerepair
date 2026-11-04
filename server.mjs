// Xpress Garage Doors: website + backend (no npm dependencies, Node 22+).
//   ADMIN_PASSWORD=... PORT=4190 node server.mjs
// Stores everything in data/xpress.db (SQLite): customers, sessions, quotes, chats, notes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as alerts from './alerts.mjs';
import * as pay from './payments.mjs';
const safe = p => Promise.resolve(p).catch(e => console.error('ALERT FAILED:', e?.message || e));

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist'), PUB = path.join(ROOT, 'public'), DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = +process.env.PORT || 4190, HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = ['1', 'true', 'on'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
// Behind a reverse proxy (Caddy) set TRUST_PROXY=1: the visitor's address is then the last X-Forwarded-For entry (added by our own proxy, so it can't be forged by the visitor).
const clientIp = req => TRUST_PROXY ? (String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '') : (req.socket.remoteAddress || '');
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url'); console.log(`ADMIN_PASSWORD not set. Temporary staff password for this run: ${ADMIN_PASSWORD}`); }
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'xpress.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', door_notes TEXT DEFAULT '', pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), name TEXT, email TEXT, phone TEXT, service TEXT, city TEXT, state TEXT, message TEXT, pref_date TEXT, pref_time TEXT, urgent INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', quote_amount TEXT DEFAULT '', scheduled_for TEXT DEFAULT '', staff_note TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quote_events(id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, label TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, guest_token TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), name TEXT, email TEXT, topic TEXT, status TEXT NOT NULL DEFAULT 'open', unread_staff INTEGER DEFAULT 0, unread_customer INTEGER DEFAULT 0, created_at TEXT NOT NULL, last_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_notes(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_msg ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS ix_quote_email ON quotes(email);
`);

const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
db.exec("CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, kind TEXT NOT NULL, description TEXT DEFAULT '', amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', method TEXT DEFAULT '', stripe_session TEXT DEFAULT '', created_at TEXT NOT NULL, paid_at TEXT DEFAULT '')");
const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const invView = i => ({ id: i.id, kind: i.kind, description: i.description, amountCents: i.amount_cents, amount: money(i.amount_cents), status: i.status, method: i.method, dueDate: i.due_date, refundedCents: i.refunded_cents, refunded: money(i.refunded_cents), createdAt: i.created_at, paidAt: i.paid_at });
const invoicesOf = quoteId => db.prepare('SELECT * FROM invoices WHERE quote_id=? ORDER BY id').all(quoteId).map(invView);
const siteUrl = () => (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
/* idempotent: safe if the webhook, the return page and staff all try to mark the same invoice paid */
function markPaid(invoiceId, method, pi = '') {
  const r = db.prepare("UPDATE invoices SET status='paid',method=?,paid_at=?,stripe_pi=COALESCE(NULLIF(?, ''), stripe_pi) WHERE id=? AND status='open'").run(method, now(), String(pi || ''), invoiceId);
  if (!r.changes) return false;
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId), q = db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id);
  addEvent(q.id, `Payment received: ${money(inv.amount_cents)} (${inv.kind}${method === 'card' ? '' : ', ' + method})`);
  console.log(`PAYMENT ${q.ref} ${money(inv.amount_cents)} via ${method}`);
  safe(alerts.paymentReceived(q, invView(inv)));
  return true;
}
addCol('invoices', 'due_date', "TEXT DEFAULT ''"); addCol('invoices', 'remind_stage', 'INTEGER DEFAULT 0'); addCol('invoices', 'refunded_cents', 'INTEGER DEFAULT 0'); addCol('invoices', 'stripe_pi', "TEXT DEFAULT ''");
/* Refunds: the total refunded only ever moves up and is capped at the invoice amount, so the webhook and the staff button can't double count. */
function setRefundTotal(invoiceId, total) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId); if (!inv) return 0;
  const next = Math.min(inv.amount_cents, Math.max(inv.refunded_cents, total)), delta = next - inv.refunded_cents; if (delta <= 0) return 0;
  db.prepare("UPDATE invoices SET refunded_cents=?,status=CASE WHEN ?>=amount_cents THEN 'refunded' ELSE status END WHERE id=?").run(next, next, inv.id);
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id); addEvent(q.id, `Refund issued: ${money(delta)}`); console.log(`REFUND ${q.ref} ${money(delta)}`);
  safe(alerts.refundIssued(q, invView(db.prepare('SELECT * FROM invoices WHERE id=?').get(inv.id)), money(delta)));
  return delta;
}
const daysBetween = (a, b) => Math.round((parseYmd(a) - parseYmd(b)) / 864e5);
db.exec(`
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, last_login TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_sessions(token_hash TEXT PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, staff_id INTEGER, staff_name TEXT, action TEXT NOT NULL, target TEXT DEFAULT '', detail TEXT DEFAULT '', created_at TEXT NOT NULL);
`);
addCol('customers', 'verified', 'INTEGER DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS email_tokens(token_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_q_cust ON quotes(customer_id); CREATE INDEX IF NOT EXISTS ix_inv_q ON invoices(quote_id); CREATE INDEX IF NOT EXISTS ix_conv_cust ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS ix_events_q ON quote_events(quote_id);
`);
// Until an email address is confirmed, an account sees only what it created itself. Local testing without email can set AUTO_VERIFY=1.
const AUTO_VERIFY = ['1', 'true', 'on'].includes(String(process.env.AUTO_VERIFY || '').toLowerCase());
addCol('messages', 'staff_name', "TEXT DEFAULT ''"); addCol('quotes', 'assigned_to', 'INTEGER');
const audit = (sf, action, target = '', detail = '') => db.prepare('INSERT INTO audit(staff_id,staff_name,action,target,detail,created_at) VALUES(?,?,?,?,?,?)').run(sf?.id ?? null, sf?.name ?? '', action, String(target).slice(0, 60), String(detail).slice(0, 200), now());
const stName = id => id ? (db.prepare('SELECT name FROM staff WHERE id=?').get(id)?.name || '') : '';
const staffView = x => ({ id: x.id, name: x.name, email: x.email, role: x.role, active: !!x.active, mustChange: !!x.must_change, lastLogin: x.last_login, createdAt: x.created_at });
const tempPassword = () => crypto.randomBytes(9).toString('base64url');
function startStaffSession(req, staffId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(sha(token), staffId, Date.now() + 12 * 3600e3);
  return setCookie(req, 'xp_staff', token, 12 * 3600, 'Strict');
}
db.exec(`
CREATE TABLE IF NOT EXISTS review_requests(id INTEGER PRIMARY KEY, quote_id INTEGER UNIQUE NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, token_hash TEXT DEFAULT '', send_at TEXT NOT NULL, sent_at TEXT DEFAULT '', reminded_at TEXT DEFAULT '', rating INTEGER DEFAULT 0, comment TEXT DEFAULT '', responded_at TEXT DEFAULT '', clicked_public INTEGER DEFAULT 0, via TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS maintenance_reminders(id INTEGER PRIMARY KEY, quote_id INTEGER UNIQUE NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, due_at TEXT NOT NULL, sent_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS email_optout(email TEXT PRIMARY KEY, created_at TEXT NOT NULL);
`);
addCol('review_requests', 'public_ok', 'INTEGER DEFAULT 0'); addCol('review_requests', 'featured', 'INTEGER DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS ix_rr_tok ON review_requests(token_hash)');
const numEnv = (k, d) => { const v = process.env[k]; return v !== undefined && v !== '' && Number.isFinite(+v) && +v >= 0 ? +v : d; };
const REVIEW_DELAY_H = () => numEnv('REVIEW_DELAY_HOURS', 4), MAINT_MONTHS = () => numEnv('MAINTENANCE_MONTHS', 12), GOOGLE_URL = () => /^https:\/\//.test(process.env.REVIEW_GOOGLE_URL || '') ? process.env.REVIEW_GOOGLE_URL : '';
function secretKey() { let r = db.prepare("SELECT value FROM settings WHERE key='secret'").get(); if (!r) { db.prepare("INSERT INTO settings(key,value) VALUES('secret',?)").run(crypto.randomBytes(32).toString('hex')); r = db.prepare("SELECT value FROM settings WHERE key='secret'").get(); } return r.value; }
const unsubToken = email => { const e = Buffer.from(email.toLowerCase()).toString('base64url'); return `${e}.${crypto.createHmac('sha256', secretKey()).update(e).digest('base64url')}`; };
const unsubEmail = tok => { const [e, sig] = String(tok || '').split('.'); if (!e || !sig) return null; const good = crypto.createHmac('sha256', secretKey()).update(e).digest('base64url'); if (!same(sig, good)) return null; try { return Buffer.from(e, 'base64url').toString(); } catch { return null; } };
const optedOut = email => !!db.prepare('SELECT 1 FROM email_optout WHERE email=?').get(String(email).toLowerCase());
const setOptout = (email, out) => out ? db.prepare('INSERT OR IGNORE INTO email_optout(email,created_at) VALUES(?,?)').run(String(email).toLowerCase(), now()) : db.prepare('DELETE FROM email_optout WHERE email=?').run(String(email).toLowerCase());
const unsubUrl = email => `${siteUrl()}/unsubscribe/?t=${unsubToken(email)}`;
const reviewOf = quoteId => { const r = db.prepare('SELECT * FROM review_requests WHERE quote_id=?').get(quoteId); return r ? { rating: r.rating, comment: r.comment, publicOk: !!r.public_ok, featured: !!r.featured, sentAt: r.sent_at, respondedAt: r.responded_at, clickedPublic: !!r.clicked_public } : null; };
db.exec('CREATE TABLE IF NOT EXISTS review_tokens(token_hash TEXT PRIMARY KEY, rr_id INTEGER NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE)');
// Every link ever issued for a job keeps working (emailed link, reminder, a link staff copied to text), so issuing a new one never kills an old one.
function newReviewLink(rrId) { const tok = crypto.randomBytes(24).toString('base64url'); db.prepare('INSERT INTO review_tokens VALUES(?,?)').run(sha(tok), rrId); return `${siteUrl()}/review/?t=${tok}`; }
function scheduleFollowUps(q) { // called once a job is marked completed; INSERT OR IGNORE keeps it to one of each per job
  db.prepare('INSERT OR IGNORE INTO review_requests(quote_id,send_at) VALUES(?,?)').run(q.id, new Date(Date.now() + REVIEW_DELAY_H() * 3600e3).toISOString());
  const months = MAINT_MONTHS(); if (months > 0) { const d = new Date(); d.setMonth(d.getMonth() + months); db.prepare('INSERT OR IGNORE INTO maintenance_reminders(quote_id,due_at) VALUES(?,?)').run(q.id, d.toISOString()); }
}
function saveRating(quoteId, rating, comment, via, publicOk = false) {
  db.prepare('INSERT OR IGNORE INTO review_requests(quote_id,send_at,sent_at) VALUES(?,?,?)').run(quoteId, now(), now());
  const prev = db.prepare('SELECT * FROM review_requests WHERE quote_id=?').get(quoteId);
  const keep = prev.featured && publicOk && prev.comment === comment && prev.rating === rating ? 1 : 0; // edited or withdrawn consent => needs fresh approval
  db.prepare('UPDATE review_requests SET rating=?,comment=?,responded_at=?,via=?,public_ok=?,featured=? WHERE quote_id=?').run(rating, comment, now(), via, publicOk ? 1 : 0, keep, quoteId);
  if (!prev.responded_at) { const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId); addEvent(q.id, 'Review received'); safe(alerts.reviewReceived(q, rating, comment)); }
}
const parseRating = v => { const n = Math.floor(+v); return n >= 1 && n <= 5 ? n : 0; };
const parseDollars = v => { const t = String(v ?? '').replace(/[$,\s]/g, ''); if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return 0; const c = Math.round(parseFloat(t) * 100); return c >= 100 && c <= 5000000 ? c : 0; };
addCol('quotes', 'upload_token_hash', "TEXT DEFAULT ''");
db.exec("CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, orig_name TEXT, stored TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ix_photo_q ON photos(quote_id)");
const UPLOADS = path.join(DATA, 'uploads'); fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_PHOTO = 8 * 1024 * 1024, MAX_PHOTOS = 8;
/* identify the real file type from its first bytes; the browser's claimed type is never trusted */
function sniff(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (b.length > 16 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|mif1|msf1)/.test(b.toString('latin1', 8, 12))) return ['image/heic', 'heic'];
  return null;
}
function rawBody(req, max) { // oversize bodies are drained (not stored) so the client can still receive a clear 413
  return new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 40e6) req.destroy(); else if (n <= max) c.push(d); }); req.on('end', () => n > max ? no(Object.assign(new Error('too large'), { code: 413 })) : ok(Buffer.concat(c))); req.on('error', no); });
}
const photosOf = quoteId => db.prepare('SELECT id,orig_name AS name,mime,size FROM photos WHERE quote_id=? ORDER BY id').all(quoteId);
function sendPhoto(res, ph) {
  const f = path.join(UPLOADS, ph.stored); if (!fs.existsSync(f)) return json(res, 404, { error: 'Not found' });
  const inline = ph.mime !== 'image/heic';
  res.writeHead(200, { 'content-type': ph.mime, 'content-length': ph.size, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="photo-${ph.id}.${ph.stored.split('.').pop()}"`, 'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'; sandbox", ...SEC });
  fs.createReadStream(f).pipe(res);
}
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function receiptHtml(inv, q) {
  const v = invView(inv), paid = inv.status === 'paid' || inv.status === 'refunded', fmt = d => d ? new Date(d.length === 10 ? d + 'T12:00' : d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const stamp = inv.status === 'refunded' ? 'REFUNDED' : paid ? 'PAID' : inv.status === 'void' ? 'CANCELLED' : 'AMOUNT DUE';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${paid ? 'Receipt' : 'Invoice'} ${escH(q.ref)}-${inv.id} | Xpress Garage Doors</title><style>body{font-family:Arial,sans-serif;color:#111;max-width:720px;margin:30px auto;padding:0 20px}h1{margin:0}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #ef4b00;padding-bottom:16px}.muted{color:#666;font-size:13px}table{width:100%;border-collapse:collapse;margin:22px 0}td,th{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}.stamp{display:inline-block;border:3px solid ${paid && inv.status !== 'refunded' ? '#1a7f37' : '#b53b00'};color:${paid && inv.status !== 'refunded' ? '#1a7f37' : '#b53b00'};padding:4px 14px;font-weight:bold;letter-spacing:.1em;transform:rotate(-3deg)}.tot td{font-weight:bold;font-size:18px;border-bottom:0}button{background:#ef4b00;color:#fff;border:0;border-radius:30px;padding:12px 24px;font:bold 14px Arial;cursor:pointer}@media print{button{display:none}body{margin:0}}</style></head><body>
<div class="top"><div><h1>Xpress Garage Doors</h1><div class="muted">1807 Easton Rd, Willow Grove, PA 19090<br>215-397-1926 · info@xpressgaragedoorservics.com</div></div><div style="text-align:right"><h1 style="font-size:22px">${paid ? 'RECEIPT' : 'INVOICE'}</h1><div class="muted">No. ${escH(q.ref)}-${inv.id}<br>Issued ${fmt(inv.created_at)}${inv.due_date && !paid ? '<br><b>Due ' + fmt(inv.due_date) + '</b>' : ''}${inv.paid_at ? '<br>Paid ' + fmt(inv.paid_at) : ''}</div></div></div>
<p style="margin-top:20px"><b>Billed to</b><br>${escH(q.name)}<br>${escH(q.email)}<br>${escH(q.city)}, ${escH(q.state)}</p>
<table><tr><th>Description</th><th>Amount</th></tr><tr><td>${escH(v.kind === 'deposit' ? 'Deposit' : v.kind === 'installment' ? 'Installment' : 'Payment')}: ${escH(inv.description || q.service)}<br><span class="muted">${escH(q.service)} · request ${escH(q.ref)}</span></td><td>${v.amount}</td></tr>${inv.refunded_cents ? `<tr><td>Refunded</td><td>-${v.refunded}</td></tr>` : ''}<tr class="tot"><td>${paid ? 'Total paid' : 'Amount due'}${paid && inv.method ? ` <span class="muted">(${escH(inv.method)})</span>` : ''}</td><td>${money(inv.amount_cents - (inv.refunded_cents || 0))}</td></tr></table>
<p><span class="stamp">${stamp}</span></p><p class="muted">Thank you for choosing Xpress Garage Doors. Questions about this ${paid ? 'receipt' : 'invoice'}? Call 215-397-1926.</p><p><button onclick="window.print()">Print or save as PDF</button></p></body></html>`;
}
const sendHtml = (res, html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", ...SEC }); res.end(html); };
const photoTimers = new Map(); // one staff alert per burst of uploads
function photoAlert(quoteId) {
  clearTimeout(photoTimers.get(quoteId));
  photoTimers.set(quoteId, setTimeout(() => { photoTimers.delete(quoteId); const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId); if (q) safe(alerts.photosAdded(q, photosOf(quoteId).length)); }, 15e3).unref());
}
addCol('quotes', 'slot_date', "TEXT DEFAULT ''"); addCol('quotes', 'slot_window', "TEXT DEFAULT ''"); addCol('quotes', 'reminded', 'INTEGER DEFAULT 0');
db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ix_slot ON quotes(slot_date,slot_window)");

/* ---- booking calendar ---- */
const WINDOWS = [{ id: '8am–10am', start: 8 }, { id: '10am–12pm', start: 10 }, { id: '12pm–2pm', start: 12 }, { id: '2pm–4pm', start: 14 }];
const DEFAULT_SCHEDULE = { capacity: { PA: 2, NJ: 1, LA: 1 }, openDays: [1, 2, 3, 4, 5, 6], blackouts: [], leadHours: 3, maxDays: 30 };
const getSchedule = () => { const r = db.prepare("SELECT value FROM settings WHERE key='schedule'").get(); return { ...DEFAULT_SCHEDULE, ...(r ? JSON.parse(r.value) : {}) }; };
const tzOf = st => st === 'LA' ? 'America/Chicago' : 'America/New_York';
const wallNow = st => new Date(new Date().toLocaleString('en-US', { timeZone: tzOf(st) })); // the business's local clock
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return ymd(d) === v ? d : null; };
const slotLabel = (date, win) => { const d = parseYmd(date); return d && win ? `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${win}` : ''; };
const booked = (state, date, win, exceptId = 0) => db.prepare("SELECT COUNT(*) n FROM quotes WHERE state=? AND slot_date=? AND slot_window=? AND status!='cancelled' AND id!=?").get(state, date, win, exceptId).n;
function slotOpen(state, date, win, exceptId = 0) { // returns '' when bookable, otherwise the reason
  const sc = getSchedule(), d = parseYmd(date), w = WINDOWS.find(x => x.id === win);
  if (!d || !w || !STATES.includes(state)) return 'Choose a valid date and time.';
  const now = wallNow(state), start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), w.start);
  if (!sc.openDays.includes(d.getDay()) || sc.blackouts.includes(date)) return 'We are not booking that day.';
  if (start - now < sc.leadHours * 3600e3) return 'That time is too soon to book online. Please call us.';
  if ((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5 > sc.maxDays) return 'That date is too far ahead.';
  if (booked(state, date, win, exceptId) >= (sc.capacity[state] ?? 1)) return 'That time was just taken. Please choose another.';
  return '';
}
function availability(state, days) {
  const sc = getSchedule(), n = wallNow(state), out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + i), date = ymd(d);
    out.push({ date, weekday: d.toLocaleDateString('en-US', { weekday: 'short' }), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), windows: WINDOWS.map(w => ({ id: w.id, available: !slotOpen(state, date, w.id) })) });
  }
  return { state, days: out, note: `Arrival windows. Your technician will call ahead. Times are ${state === 'LA' ? 'Central' : 'Eastern'}.` };
}
function icsFor(q, cust) {
  const w = WINDOWS.find(x => x.id === q.slot_window), d = parseYmd(q.slot_date); if (!w || !d) return null;
  const p = n => String(n).padStart(2, '0'), day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, esc = t => String(t).replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Xpress Garage Doors//Booking//EN', 'BEGIN:VEVENT', `UID:${q.ref}@xpressgaragedoors`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    `DTSTART;TZID=${tzOf(q.state)}:${day}T${p(w.start)}0000`, `DTEND;TZID=${tzOf(q.state)}:${day}T${p(w.start + 2)}0000`, `SUMMARY:${esc('Xpress Garage Doors: ' + q.service)}`, `DESCRIPTION:${esc(`Arrival window ${q.slot_window}. Reference ${q.ref}. Questions: 215-397-1926`)}`, `LOCATION:${esc([cust?.address, q.city, q.state].filter(Boolean).join(', '))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

const STATUSES = ['new', 'reviewing', 'quoted', 'scheduled', 'completed', 'cancelled'];
const STATUS_TEXT = { new: 'Request received', reviewing: 'Our team is reviewing your request', quoted: 'Your quote is ready', scheduled: 'Appointment scheduled', completed: 'Job completed', cancelled: 'Request closed' };
const STATES = ['PA', 'NJ', 'LA'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN' };
const now = () => new Date().toISOString();
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n);
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC, ...extra }); res.end(JSON.stringify(obj)); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const validEmail = e => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;

const hits = new Map();
const limited = (key, max, windowMs) => { const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < windowMs); a.push(t); if (a.length > 300) a.splice(0, a.length - 300); hits.set(key, a); return a.length > max; };
const remind = () => { try {
  for (const st of STATES) { const n = wallNow(st), tomorrow = ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
    for (const q of db.prepare("SELECT * FROM quotes WHERE state=? AND slot_date=? AND status='scheduled' AND reminded=0").all(st, tomorrow)) { db.prepare('UPDATE quotes SET reminded=1 WHERE id=?').run(q.id); q.slot_label = slotLabel(q.slot_date, q.slot_window); safe(alerts.appointmentReminder(q)); } }
  for (const r of db.prepare("SELECT i.*, q.state AS qstate FROM invoices i JOIN quotes q ON q.id=i.quote_id WHERE i.status='open' AND q.status!='cancelled'").all()) {
    const today = ymd(wallNow(r.qstate)); let stage = 0;
    if (r.due_date) { const left = daysBetween(r.due_date, today); stage = left <= -3 ? 3 : left <= 0 ? 2 : left <= 3 ? 1 : 0; }
    else { const age = daysBetween(today, r.created_at.slice(0, 10)); stage = age >= 7 ? 2 : age >= 3 ? 1 : 0; }
    if (stage > r.remind_stage) { db.prepare('UPDATE invoices SET remind_stage=? WHERE id=?').run(stage, r.id); const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(r.quote_id); addEvent(q.id, `Payment reminder sent (${money(r.amount_cents)})`); safe(alerts.invoiceReminder(q, invView(r), stage, !!r.due_date)); }
  }
  const t0 = now();
  for (const rr of db.prepare("SELECT rr.id,rr.quote_id FROM review_requests rr JOIN quotes q ON q.id=rr.quote_id WHERE rr.sent_at='' AND rr.send_at<=? AND q.status='completed'").all(t0)) {
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(rr.quote_id); db.prepare('UPDATE review_requests SET sent_at=? WHERE id=?').run(t0, rr.id);
    if (optedOut(q.email)) continue; const link = newReviewLink(rr.id); addEvent(q.id, 'Review request sent');
    if (!alerts.channels().customerEmail) console.log(`REVIEW LINK for ${q.email} (email is not set up, so it is only shown here): ${link}`);
    safe(alerts.reviewRequest(q, link, false, unsubUrl(q.email)));
  }
  const fiveDaysAgo = new Date(Date.now() - 5 * 864e5).toISOString();
  for (const rr of db.prepare("SELECT id,quote_id FROM review_requests WHERE sent_at!='' AND sent_at<? AND responded_at='' AND reminded_at=''").all(fiveDaysAgo)) { // one gentle nudge, then stop
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(rr.quote_id); db.prepare('UPDATE review_requests SET reminded_at=? WHERE id=?').run(t0, rr.id);
    if (!optedOut(q.email)) safe(alerts.reviewRequest(q, newReviewLink(rr.id), true, unsubUrl(q.email)));
  }
  for (const mr of db.prepare("SELECT id,quote_id FROM maintenance_reminders WHERE sent_at='' AND due_at<=?").all(t0)) {
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(mr.quote_id); db.prepare('UPDATE maintenance_reminders SET sent_at=? WHERE id=?').run(t0, mr.id);
    const recent = db.prepare("SELECT 1 FROM quotes WHERE lower(email)=lower(?) AND id!=? AND created_at>? AND status!='cancelled'").get(q.email, q.id, new Date(Date.now() - 180 * 864e5).toISOString());
    if (optedOut(q.email) || recent) continue;
    const link = `${siteUrl()}/contact-us/?service=garage-door-maintenance&state=${q.state}&city=${encodeURIComponent(q.city)}`;
    addEvent(q.id, 'Maintenance reminder sent'); safe(alerts.maintenanceReminder(q, link, unsubUrl(q.email)));
  }
} catch (e) { console.error('reminder job failed:', e.message); } };
setInterval(remind, 15 * 60e3).unref(); setTimeout(remind, 5e3).unref();
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600e3)) hits.delete(k); db.prepare('DELETE FROM sessions WHERE expires_at<?').run(t); db.prepare('DELETE FROM staff_sessions WHERE expires_at<?').run(t); db.prepare('DELETE FROM password_resets WHERE expires_at<?').run(t); }, 600e3).unref();

function body(req, max = 20000) {
  return new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > max) { no(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new Error('bad json')); } }); req.on('error', no); });
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const secure = req => req.headers['x-forwarded-proto'] === 'https';
const setCookie = (req, name, val, maxAge, sameSite = 'Lax') => `${name}=${val}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

function customerFrom(req) {
  const t = cookies(req).xp_session; if (!t) return null;
  const s = db.prepare('SELECT customer_id,expires_at FROM sessions WHERE token_hash=?').get(sha(t));
  if (!s || s.expires_at < Date.now()) return null;
  return db.prepare('SELECT * FROM customers WHERE id=?').get(s.customer_id) || null;
}
function staffFrom(req) {
  const t = cookies(req).xp_staff; if (!t) return null;
  const x = db.prepare('SELECT staff_id,expires_at FROM staff_sessions WHERE token_hash=?').get(sha(t)); if (!x || x.expires_at < Date.now()) return null;
  return db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(x.staff_id) || null;
}
const publicCustomer = c => c && ({ verified: !!c.verified, id: c.id, email: c.email, name: c.name, phone: c.phone, address: c.address, city: c.city, state: c.state, doorNotes: c.door_notes, createdAt: c.created_at });
function startSession(req, res, customerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), customerId, Date.now() + 30 * 864e5);
  return setCookie(req, 'xp_session', token, 30 * 86400);
}
function linkGuestData(customer) { // attach earlier quotes and chats made with the same email, but ONLY once the email is confirmed
  if (!customer.verified) return;
  db.prepare('UPDATE quotes SET customer_id=? WHERE customer_id IS NULL AND lower(email)=lower(?)').run(customer.id, customer.email);
  db.prepare('UPDATE conversations SET customer_id=? WHERE customer_id IS NULL AND lower(email)=lower(?)').run(customer.id, customer.email);
}
function sendVerification(c) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM email_tokens WHERE customer_id=?').run(c.id); db.prepare('INSERT INTO email_tokens VALUES(?,?,?)').run(sha(token), c.id, Date.now() + 2 * 864e5);
  const link = `${siteUrl()}/account/?verify=${token}`;
  if (!alerts.channels().customerEmail) console.log(`VERIFY LINK for ${c.email} (email is not set up, so it is only shown here): ${link}`);
  safe(alerts.verifyEmail(c, link));
}
/* Proof that a signup comes from the person who just sent the quote / chat: the one-time token only their browser received. */
function claimGuestItems(c, claim, chatToken) {
  if (claim && typeof claim.ref === 'string' && typeof claim.token === 'string') {
    const q = db.prepare('SELECT * FROM quotes WHERE ref=?').get(claim.ref);
    if (q && !q.customer_id && q.upload_token_hash && same(sha(claim.token), q.upload_token_hash) && Date.now() - Date.parse(q.created_at) < 864e5) {
      db.prepare('UPDATE quotes SET customer_id=? WHERE id=?').run(c.id, q.id);
      db.prepare("UPDATE customers SET phone=CASE WHEN phone='' THEN ? ELSE phone END, city=CASE WHEN city='' THEN ? ELSE city END, state=CASE WHEN state='' THEN ? ELSE state END WHERE id=?").run(q.phone || '', q.city || '', q.state || '', c.id);
    }
  }
  if (typeof chatToken === 'string' && chatToken.length >= 20) { const cv = db.prepare('SELECT * FROM conversations WHERE guest_token=?').get(chatToken); if (cv && !cv.customer_id) db.prepare('UPDATE conversations SET customer_id=? WHERE id=?').run(c.id, cv.id); }
}
function addEvent(quoteId, label) { db.prepare('INSERT INTO quote_events(quote_id,label,created_at) VALUES(?,?,?)').run(quoteId, label, now()); }
function quoteView(q) {
  return { ref: q.ref, service: q.service, city: q.city, state: q.state, message: q.message, prefDate: q.pref_date, prefTime: q.pref_time, urgent: !!q.urgent, status: q.status, statusText: STATUS_TEXT[q.status], quoteAmount: q.quote_amount, scheduledFor: q.scheduled_for, slotDate: q.slot_date, slotWindow: q.slot_window, slotLabel: slotLabel(q.slot_date, q.slot_window), createdAt: q.created_at, updatedAt: q.updated_at,
    review: reviewOf(q.id), invoices: invoicesOf(q.id), photos: photosOf(q.id), events: db.prepare('SELECT label,created_at AS at FROM quote_events WHERE quote_id=? ORDER BY id').all(q.id) };
}
function convoView(c, after = 0) {
  return { id: c.id, status: c.status, topic: c.topic, name: c.name, messages: db.prepare('SELECT id,sender,body,staff_name AS staffName,created_at AS at FROM messages WHERE conversation_id=? AND id>? ORDER BY id').all(c.id, after) };
}
function postMessage(convId, sender, text, staffName = '') {
  db.prepare('INSERT INTO messages(conversation_id,sender,body,created_at,staff_name) VALUES(?,?,?,?,?)').run(convId, sender, text, now(), staffName);
  if (sender === 'customer') db.prepare("UPDATE conversations SET last_at=?, unread_staff=unread_staff+1, status='open' WHERE id=?").run(now(), convId);
  else db.prepare('UPDATE conversations SET last_at=?, unread_customer=unread_customer+(?) WHERE id=?').run(now(), sender === 'staff' ? 1 : 0, convId);
}

/* business hours: staff are "online" when marked available AND within hours (Mon-Sat 7-19 ET). Emergency line is always 24/7. */
let staffAvailable = true;
function chatState() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const inHours = d.getDay() !== 0 && d.getHours() >= 7 && d.getHours() < 19;
  return { online: staffAvailable && inHours, hours: 'Mon to Sat, 7am to 7pm ET', emergency: '24-hour emergency line' };
}

async function api(req, res, url) {
  const ip = clientIp(req), p = url.pathname, m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) { let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { } if (!ok) { req.resume(); return json(res, 403, { error: 'Cross-site request blocked.' }); } }
  const bodyOf = async (max) => { try { return await body(req, max); } catch { throw Object.assign(new Error('Invalid request'), { code: 400 }); } };

  /* ---- public: quotes ---- */
  if (p === '/api/quotes' && m === 'POST') {
    if (limited('q' + ip, 10, 3600e3)) return json(res, 429, { error: 'Too many requests. Please call us.' });
    const d = await bodyOf(); if (d.website) return json(res, 200, { ok: true, ref: 'XG-OK' });
    const state = STATES.includes(d.state) ? d.state : '';
    const q = { name: clean(d.name, 100), email: clean(d.email, 120).toLowerCase(), phone: clean(d.phone, 40), service: clean(d.service, 120), city: clean(d.city, 100), message: clean(d.message, 2000), pref_date: clean(d.date, 20), pref_time: clean(d.time, 20) };
    if (q.name.length < 2 || !validEmail(q.email) || q.phone.replace(/\D/g, '').length < 7 || !q.service || !q.city) return json(res, 422, { error: 'Please check your name, email, phone, service and town.' });
    if (limited('qe' + q.email, 4, 3600e3)) return json(res, 429, { error: 'We already have several requests from that email. Please call us, or wait a little.' });
    let slotDate = '', slotWindow = '';
    if (WINDOWS.some(w => w.id === q.pref_time) && parseYmd(q.pref_date)) { // customer picked a real slot
      const why = slotOpen(state, q.pref_date, q.pref_time); if (why) return json(res, 409, { error: why, code: 'slot_unavailable' });
      slotDate = q.pref_date; slotWindow = q.pref_time;
    }
    const uploadToken = crypto.randomBytes(24).toString('base64url');
    const me = customerFrom(req), ref = 'XG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const cid = me?.id ?? null, t = now(), urgent = /emergency|24-hour|stuck|won.?t (open|close)|broken spring|off track/i.test(q.service + ' ' + q.message) ? 1 : 0;
    const r = db.prepare('INSERT INTO quotes(ref,customer_id,name,email,phone,service,city,state,message,pref_date,pref_time,urgent,status,created_at,updated_at,slot_date,slot_window,upload_token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(ref, cid, q.name, q.email, q.phone, q.service, q.city, state, q.message, q.pref_date, q.pref_time, urgent, 'new', t, t, slotDate, slotWindow, sha(uploadToken));
    addEvent(Number(r.lastInsertRowid), 'Request received');
    const row = db.prepare('SELECT * FROM quotes WHERE ref=?').get(ref);
    row.slot_label = slotLabel(row.slot_date, row.slot_window);
    safe(alerts.newQuote(row)); safe(alerts.quoteReceived(row, !!me));
    console.log(`NEW QUOTE ${ref}${urgent ? ' URGENT' : ''}: ${q.service} in ${q.city}, ${state} (${q.name})`);
    return json(res, 200, { ok: true, ref, uploadToken, hasAccount: !!me, email: q.email });
  }

  if (p === '/api/availability' && m === 'GET') {
    const st = url.searchParams.get('state'); if (!STATES.includes(st)) return json(res, 422, { error: 'Choose a state.' });
    return json(res, 200, availability(st, Math.min(30, Math.max(1, +url.searchParams.get('days') || 14))));
  }

  if (p === '/api/stripe/webhook' && m === 'POST') {
    let raw; try { raw = (await rawBody(req, 1e6)).toString('utf8'); } catch { return json(res, 400, { error: 'Bad body' }); }
    let ev; try { ev = pay.verifyWebhook(raw, req.headers['stripe-signature']); } catch (e) { console.error('WEBHOOK REJECTED:', e.message); return json(res, 400, { error: 'Invalid signature' }); }
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      const sess = ev.data?.object || {}, inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(+sess.metadata?.invoice_id || 0);
      if (inv && sess.payment_status === 'paid' && sess.amount_total === inv.amount_cents && String(sess.currency).toLowerCase() === 'usd') {
        if (!markPaid(inv.id, 'card', sess.payment_intent)) { const cur = db.prepare('SELECT * FROM invoices WHERE id=?').get(inv.id); if (cur.status !== 'void' && sess.payment_intent && cur.stripe_pi && sess.payment_intent !== cur.stripe_pi) { console.error(`DUPLICATE PAYMENT on invoice ${inv.id}: ${sess.payment_intent} paid after ${cur.stripe_pi}. Refund one in Stripe.`); safe(alerts.duplicatePayment(db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id), invView(cur), sess.payment_intent)); } }
      } else if (inv && sess.payment_status === 'paid') console.error(`WEBHOOK amount mismatch for invoice ${inv.id}: got ${sess.amount_total} ${sess.currency}, expected ${inv.amount_cents} usd`);
    }
    if (ev.type === 'charge.refunded') {
      const ch = ev.data?.object || {}, inv = ch.payment_intent ? db.prepare('SELECT * FROM invoices WHERE stripe_pi=?').get(String(ch.payment_intent)) : null;
      if (inv && Number.isFinite(ch.amount_refunded)) setRefundTotal(inv.id, ch.amount_refunded);
    }
    return json(res, 200, { received: true });
  }

  let um = p.match(/^\/api\/quotes\/(XG-[A-F0-9]+)\/photos$/);
  if (um && m === 'POST') {
    if (limited('u' + ip, 80, 3600e3)) return json(res, 429, { error: 'Too many uploads. Please try again later.' });
    const q = db.prepare('SELECT * FROM quotes WHERE ref=?').get(um[1]), me = customerFrom(req), tok = String(req.headers['x-upload-token'] || '');
    const allowed = q && ((me && q.customer_id === me.id) || (tok && q.upload_token_hash && same(sha(tok), q.upload_token_hash) && Date.now() - Date.parse(q.created_at) < 864e5));
    if (!allowed) { req.resume(); return json(res, 404, { error: 'Not found' }); }
    if (['cancelled', 'completed'].includes(q.status)) { req.resume(); return json(res, 422, { error: 'This request is closed.' }); }
    if (db.prepare('SELECT COUNT(*) n FROM photos WHERE quote_id=?').get(q.id).n >= MAX_PHOTOS) { req.resume(); return json(res, 422, { error: `You can add up to ${MAX_PHOTOS} photos.` }); }
    let buf; try { buf = await rawBody(req, MAX_PHOTO); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'That photo is too large (8 MB max).' : 'Upload failed.' }); }
    const kind = sniff(buf); if (!kind) return json(res, 415, { error: 'Please upload a JPG, PNG, WebP or HEIC photo.' });
    const stored = crypto.randomBytes(16).toString('hex') + '.' + kind[1]; fs.writeFileSync(path.join(UPLOADS, stored), buf, { mode: 0o600 });
    const r = db.prepare('INSERT INTO photos(quote_id,orig_name,stored,mime,size,created_at) VALUES(?,?,?,?,?,?)').run(q.id, clean((() => { try { return decodeURIComponent(String(req.headers['x-file-name'] || 'photo').slice(0, 200)); } catch { return 'photo'; } })(), 80), stored, kind[0], buf.length, now());
    addEvent(q.id, 'Photo added'); photoAlert(q.id);
    return json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }

  /* ---- public: private review link from the email ---- */
  let rm = p.match(/^\/api\/review\/([\w-]{20,})(\/click)?$/);
  if (rm) {
    if (limited('rv' + ip, 60, 3600e3)) return json(res, 429, { error: 'Too many requests.' });
    const rr = db.prepare('SELECT rr.* FROM review_tokens t JOIN review_requests rr ON rr.id=t.rr_id WHERE t.token_hash=?').get(sha(rm[1])); if (!rr) return json(res, 404, { error: 'This review link is not valid any more.' });
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(rr.quote_id);
    if (rm[2] && m === 'POST') { db.prepare('UPDATE review_requests SET clicked_public=1 WHERE id=?').run(rr.id); return json(res, 200, { ok: true }); }
    if (m === 'GET') return json(res, 200, { firstName: q.name.split(' ')[0], service: q.service, city: q.city, rating: rr.rating, comment: rr.comment, publicOk: !!rr.public_ok, googleUrl: GOOGLE_URL() });
    if (m === 'POST') { const d = await bodyOf(), rating = parseRating(d.rating); if (!rating) return json(res, 422, { error: 'Please choose 1 to 5 stars.' }); saveRating(rr.quote_id, rating, clean(d.comment, 1000), 'email', !!d.publicOk); return json(res, 200, { ok: true, googleUrl: GOOGLE_URL() }); }
  }
  if (p === '/api/public/reviews' && m === 'GET') {
    // The average counts EVERY rating (never just the displayed ones). Only reviews the customer allowed AND staff approved are shown, with the customer's own unedited words.
    const all = db.prepare('SELECT rating FROM review_requests WHERE rating>0').all(), count = all.length;
    const items = db.prepare("SELECT rr.rating, rr.comment, rr.responded_at, q.name, q.city, q.state, q.service FROM review_requests rr JOIN quotes q ON q.id=rr.quote_id WHERE rr.featured=1 AND rr.public_ok=1 AND rr.rating>0 AND length(rr.comment)>=10 ORDER BY rr.responded_at DESC LIMIT 12").all()
      .map(r => { const parts = r.name.trim().split(/\s+/); return { name: parts[0] + (parts[1] ? ' ' + parts[1][0].toUpperCase() + '.' : ''), town: r.city, state: r.state, service: r.service, rating: r.rating, text: r.comment, date: r.responded_at.slice(0, 7) }; });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...SEC });
    return res.end(JSON.stringify({ count, average: count >= 3 ? Math.round(all.reduce((a, r) => a + r.rating, 0) / count * 10) / 10 : 0, items }));
  }
  if (p === '/api/unsubscribe' && m === 'POST') { // one click; also works for mail apps' one-click unsubscribe (token in the query)
    let tok = url.searchParams.get('t'); if (!tok) { const d = await bodyOf().catch(() => ({})); tok = d.token; }
    const email = unsubEmail(tok); if (!email) return json(res, 422, { error: 'This unsubscribe link is not valid.' });
    setOptout(email, true); return json(res, 200, { ok: true, email });
  }

  /* ---- public: chat status ---- */
  if (p === '/api/chat/status' && m === 'GET') return json(res, 200, chatState());

  /* ---- chat (customer side; identified by guest token or logged-in account) ---- */
  if (p === '/api/chat/start' && m === 'POST') {
    if (limited('c' + ip, 8, 3600e3)) return json(res, 429, { error: 'Too many chats started. Please call us.' });
    const d = await bodyOf(), me = customerFrom(req);
    const name = clean(me?.name || d.name, 80), email = clean(me?.email || d.email, 120).toLowerCase(), text = clean(d.message, 2000);
    if (name.length < 2 || !validEmail(email) || !text) return json(res, 422, { error: 'Please add your name, a valid email and a message.' });
    if (!me && limited('ce' + email, 6, 3600e3)) return json(res, 429, { error: 'Too many chats from that email. Please call us.' });
    let conv = me ? db.prepare("SELECT * FROM conversations WHERE customer_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(me.id) : null;
    let token, isNewChat = !conv;
    if (conv) token = conv.guest_token;
    else {
      token = crypto.randomBytes(24).toString('base64url');
      const r = db.prepare('INSERT INTO conversations(guest_token,customer_id,name,email,topic,created_at,last_at) VALUES(?,?,?,?,?,?,?)').run(token, me?.id ?? null, name, email, clean(d.topic, 60) || 'General question', now(), now());
      conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(Number(r.lastInsertRowid));
      const cs = chatState();
      postMessage(conv.id, 'system', cs.online ? 'Thanks for reaching out. A team member will reply here shortly. For an emergency, call us now.' : `We're away right now (${cs.hours}). Leave your message and we'll reply here and by email. For an emergency, call our 24-hour line.`);
    }
    postMessage(conv.id, 'customer', text);
    safe(isNewChat ? alerts.newChat(conv, text) : alerts.chatMessage(conv, text));
    return json(res, 200, { token, ...convoView(conv) });
  }
  let mm = p.match(/^\/api\/chat\/([\w-]{20,})$/);
  if (mm) {
    const conv = db.prepare('SELECT * FROM conversations WHERE guest_token=?').get(mm[1]);
    if (!conv) return json(res, 404, { error: 'Chat not found' });
    if (m === 'GET') {
      const after = +url.searchParams.get('after') || 0, v = convoView(conv, after);
      if (conv.unread_customer) db.prepare('UPDATE conversations SET unread_customer=0 WHERE id=?').run(conv.id);
      return json(res, 200, v);
    }
    if (m === 'POST') {
      if (limited('m' + mm[1], 40, 600e3)) return json(res, 429, { error: 'Slow down a little.' });
      const d = await bodyOf(), text = clean(d.message, 2000); if (!text) return json(res, 422, { error: 'Empty message' });
      if (conv.status === 'closed') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(conv.id);
      postMessage(conv.id, 'customer', text); safe(alerts.chatMessage(conv, text)); return json(res, 200, { ok: true });
    }
  }

  /* ---- accounts ---- */
  if (p === '/api/auth/signup' && m === 'POST') {
    if (limited('s' + ip, 10, 3600e3)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const d = await bodyOf(), email = clean(d.email, 120).toLowerCase(), name = clean(d.name, 100), pw = String(d.password || '');
    if (!validEmail(email) || name.length < 2) return json(res, 422, { error: 'Enter your name and a valid email.' });
    if (pw.length < 8 || pw.length > 200) return json(res, 422, { error: 'Password must be at least 8 characters.' });
    if (db.prepare('SELECT 1 FROM customers WHERE lower(email)=?').get(email)) return json(res, 409, { error: 'An account with this email already exists. Please sign in.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare('INSERT INTO customers(email,name,phone,pw_salt,pw_hash,created_at,verified) VALUES(?,?,?,?,?,?,?)').run(email, name, clean(d.phone, 40), salt, hashPw(pw, salt), now(), AUTO_VERIFY ? 1 : 0);
    let c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(r.lastInsertRowid));
    claimGuestItems(c, d.claim, d.chatToken);
    if (!c.verified) sendVerification(c);
    linkGuestData(c); // does nothing until verified
    c = db.prepare('SELECT * FROM customers WHERE id=?').get(c.id);
    return json(res, 200, { customer: publicCustomer(c) }, { 'set-cookie': startSession(req, res, c.id) });
  }
  if (p === '/api/auth/verify' && m === 'POST') {
    if (limited('vf' + ip, 20, 900e3)) return json(res, 429, { error: 'Too many attempts.' });
    const d = await bodyOf(), t = db.prepare('SELECT * FROM email_tokens WHERE token_hash=?').get(sha(String(d.token || '')));
    if (!t || t.expires_at < Date.now()) return json(res, 410, { error: 'This confirmation link has expired. Sign in and ask for a new one.' });
    // Opened in the same browser that is signed in to this account = fine. Opened anywhere else, the person must choose a password,
    // which locks out whoever created the account (stops "sign up with someone else's email, wait for them to click confirm").
    const same_ = customerFrom(req)?.id === t.customer_id, extra = {};
    if (!same_) {
      const pw = String(d.password || '');
      if (!pw) return json(res, 422, { error: 'Choose a password to finish confirming your email.', code: 'password_needed' });
      if (pw.length < 8 || pw.length > 200) return json(res, 422, { error: 'Password must be at least 8 characters.', code: 'password_needed' });
      const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE customers SET pw_salt=?,pw_hash=? WHERE id=?').run(salt, hashPw(pw, salt), t.customer_id); db.prepare('DELETE FROM sessions WHERE customer_id=?').run(t.customer_id);
      extra['set-cookie'] = startSession(req, res, t.customer_id);
    }
    db.prepare('UPDATE customers SET verified=1 WHERE id=?').run(t.customer_id); db.prepare('DELETE FROM email_tokens WHERE customer_id=?').run(t.customer_id);
    linkGuestData(db.prepare('SELECT * FROM customers WHERE id=?').get(t.customer_id)); return json(res, 200, { ok: true }, extra);
  }
  if (p === '/api/auth/login' && m === 'POST') {
    if (limited('l' + ip, 15, 900e3)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const d = await bodyOf(), email = clean(d.email, 120).toLowerCase(), c = db.prepare('SELECT * FROM customers WHERE lower(email)=?').get(email);
    const ok = c && same(hashPw(String(d.password || ''), c.pw_salt), c.pw_hash);
    if (!ok) return json(res, 401, { error: 'Email or password is incorrect.' });
    linkGuestData(c);
    return json(res, 200, { customer: publicCustomer(c) }, { 'set-cookie': startSession(req, res, c.id) });
  }
  if (p === '/api/auth/forgot' && m === 'POST') {
    // Always answers the same way so nobody can use this to find out who has an account.
    if (limited('f' + ip, 6, 3600e3)) return json(res, 429, { error: 'Too many requests. Try again later.' });
    const d = await bodyOf(), email = clean(d.email, 120).toLowerCase(), c = validEmail(email) ? db.prepare('SELECT * FROM customers WHERE lower(email)=?').get(email) : null;
    if (c && !limited('fe' + email, 3, 3600e3)) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM password_resets WHERE customer_id=?').run(c.id);
      db.prepare('INSERT INTO password_resets VALUES(?,?,?,0)').run(sha(token), c.id, Date.now() + 3600e3);
      const link = `${(process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/account/?reset=${token}`;
      if (!alerts.channels().customerEmail) console.log(`PASSWORD RESET LINK for ${c.email} (email is not set up, so it is only shown here): ${link}`);
      safe(alerts.passwordReset(c, link));
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/reset' && m === 'POST') {
    if (limited('r' + ip, 15, 900e3)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const d = await bodyOf(), pw = String(d.password || '');
    if (pw.length < 8 || pw.length > 200) return json(res, 422, { error: 'Password must be at least 8 characters.' });
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(sha(String(d.token || '')));
    if (!r || r.used || r.expires_at < Date.now()) return json(res, 410, { error: 'This reset link has expired or was already used. Please request a new one.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE customers SET pw_salt=?,pw_hash=?,verified=1 WHERE id=?').run(salt, hashPw(pw, salt), r.customer_id); // using the emailed link proves the address
    db.prepare('UPDATE password_resets SET used=1 WHERE token_hash=?').run(r.token_hash);
    db.prepare('DELETE FROM sessions WHERE customer_id=?').run(r.customer_id); // sign out everywhere else
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(r.customer_id); linkGuestData(c);
    return json(res, 200, { customer: publicCustomer(c) }, { 'set-cookie': startSession(req, res, c.id) });
  }
  if (p === '/api/auth/logout' && m === 'POST') { const t = cookies(req).xp_session; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t)); return json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, 'xp_session', '', 0) }); }

  /* ---- customer portal (login required) ---- */
  if (p.startsWith('/api/me')) {
    const me = customerFrom(req); if (!me) return json(res, 401, { error: 'Please sign in.' });
    if (p === '/api/me/resend-verification' && m === 'POST') {
      if (me.verified) return json(res, 200, { ok: true, already: true });
      if (limited('rvf' + me.id, 3, 3600e3)) return json(res, 429, { error: 'Please wait a while before asking again.' });
      sendVerification(me); return json(res, 200, { ok: true });
    }
    if (p === '/api/me' && m === 'GET') {
      const quotes = db.prepare('SELECT * FROM quotes WHERE customer_id=? ORDER BY id DESC').all(me.id).map(quoteView);
      const conv = db.prepare('SELECT * FROM conversations WHERE customer_id=? ORDER BY id DESC LIMIT 1').get(me.id);
      return json(res, 200, { customer: { ...publicCustomer(me), emailReminders: !optedOut(me.email) }, quotes, chat: conv ? { token: conv.guest_token, unread: conv.unread_customer } : null, googleUrl: GOOGLE_URL() });
    }
    if (p === '/api/me' && m === 'PATCH') {
      const d = await bodyOf();
      db.prepare('UPDATE customers SET name=?,phone=?,address=?,city=?,state=?,door_notes=? WHERE id=?').run(clean(d.name, 100) || me.name, clean(d.phone, 40), clean(d.address, 160), clean(d.city, 80), STATES.includes(d.state) ? d.state : '', clean(d.doorNotes, 600), me.id);
      if (d.emailReminders !== undefined) setOptout(me.email, !d.emailReminders);
      return json(res, 200, { customer: { ...publicCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(me.id)), emailReminders: !optedOut(me.email) } });
    }
    if (p === '/api/me/password' && m === 'POST') {
      const d = await bodyOf(), pw = String(d.newPassword || '');
      if (!same(hashPw(String(d.password || ''), me.pw_salt), me.pw_hash)) return json(res, 401, { error: 'Current password is incorrect.' });
      if (pw.length < 8) return json(res, 422, { error: 'New password must be at least 8 characters.' });
      const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE customers SET pw_salt=?,pw_hash=? WHERE id=?').run(salt, hashPw(pw, salt), me.id);
      db.prepare('DELETE FROM sessions WHERE customer_id=? AND token_hash!=?').run(me.id, sha(cookies(req).xp_session || '')); // other devices are signed out
      return json(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/me\/quotes\/(XG-[A-F0-9]+)\/review$/);
    if (mm && m === 'POST') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=? AND customer_id=?').get(mm[1], me.id); if (!q) return json(res, 404, { error: 'Not found' });
      if (q.status !== 'completed') return json(res, 422, { error: 'You can rate a job once it is completed.' });
      const d = await bodyOf(), rating = parseRating(d.rating); if (!rating) return json(res, 422, { error: 'Please choose 1 to 5 stars.' });
      saveRating(q.id, rating, clean(d.comment, 1000), 'account', !!d.publicOk); return json(res, 200, { ok: true, googleUrl: GOOGLE_URL() });
    }
    mm = p.match(/^\/api\/me\/invoices\/(\d+)\/receipt$/);
    if (mm && m === 'GET') {
      const inv = db.prepare('SELECT i.* FROM invoices i JOIN quotes q ON q.id=i.quote_id WHERE i.id=? AND q.customer_id=?').get(+mm[1], me.id); if (!inv) return json(res, 404, { error: 'Not found' });
      return sendHtml(res, receiptHtml(inv, db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id)));
    }
    mm = p.match(/^\/api\/me\/invoices\/(\d+)\/(checkout|sync)$/);
    if (mm && (m === 'POST' || m === 'GET')) {
      const inv = db.prepare('SELECT i.* FROM invoices i JOIN quotes q ON q.id=i.quote_id WHERE i.id=? AND q.customer_id=?').get(+mm[1], me.id); if (!inv) return json(res, 404, { error: 'Not found' });
      const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id);
      if (mm[2] === 'checkout' && m === 'POST') {
        if (inv.status !== 'open') return json(res, 422, { error: inv.status === 'paid' ? 'This is already paid. Thank you!' : 'This payment request is no longer active.' });
        if (!pay.enabled()) return json(res, 503, { error: 'Online payment is not available yet. Please call us to pay, or pay your technician on the day.' });
        if (inv.stripe_session) { // reuse the checkout they already opened so two payments can't happen
          try {
            const prev = await pay.getSession(inv.stripe_session);
            if (prev.payment_status === 'paid' && prev.amount_total === inv.amount_cents) { markPaid(inv.id, 'card', prev.payment_intent); return json(res, 200, { url: `${siteUrl()}/account/?paid=${inv.id}` }); }
            if (prev.status === 'open' && prev.url) return json(res, 200, { url: prev.url });
          } catch (e) { console.error('STRIPE lookup of earlier checkout failed:', e.message); }
        }
        try {
          const sess = await pay.createCheckout({ invoice: inv, quote: q, successUrl: `${siteUrl()}/account/?paid=${inv.id}`, cancelUrl: `${siteUrl()}/account/?canceled=${inv.id}` });
          db.prepare('UPDATE invoices SET stripe_session=? WHERE id=?').run(sess.id, inv.id); return json(res, 200, { url: sess.url });
        } catch (e) { console.error('STRIPE checkout failed:', e.message); return json(res, 502, { error: 'We could not start the payment. Please try again or call us.' }); }
      }
      if (mm[2] === 'sync' && m === 'GET') { // asks Stripe directly, so a customer returning from payment sees "paid" even if the webhook is slow
        if (inv.status === 'open' && inv.stripe_session && pay.enabled()) {
          try { const sess = await pay.getSession(inv.stripe_session); if (sess.payment_status === 'paid' && sess.amount_total === inv.amount_cents && String(sess.currency).toLowerCase() === 'usd') markPaid(inv.id, 'card', sess.payment_intent); } catch (e) { console.error('STRIPE sync failed:', e.message); }
        }
        return json(res, 200, { status: db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status });
      }
    }
    mm = p.match(/^\/api\/me\/quotes\/(XG-[A-F0-9]+)\/photos\/(\d+)$/);
    if (mm && (m === 'GET' || m === 'DELETE')) {
      const ph = db.prepare('SELECT p.* FROM photos p JOIN quotes q ON q.id=p.quote_id WHERE q.ref=? AND q.customer_id=? AND p.id=?').get(mm[1], me.id, +mm[2]); if (!ph) return json(res, 404, { error: 'Not found' });
      if (m === 'GET') return sendPhoto(res, ph);
      db.prepare('DELETE FROM photos WHERE id=?').run(ph.id); try { fs.unlinkSync(path.join(UPLOADS, ph.stored)); } catch { } return json(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/me\/quotes\/(XG-[A-F0-9]+)\/reschedule$/);
    if (mm && m === 'POST') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=? AND customer_id=?').get(mm[1], me.id); if (!q) return json(res, 404, { error: 'Not found' });
      if (['completed', 'cancelled'].includes(q.status)) return json(res, 422, { error: 'This request is already closed.' });
      const d = await bodyOf(), date = clean(d.slotDate, 10), win = clean(d.slotWindow, 20), why = slotOpen(q.state, date, win, q.id);
      if (why) return json(res, 409, { error: why });
      db.prepare("UPDATE quotes SET slot_date=?,slot_window=?,scheduled_for='',status=CASE WHEN status='scheduled' THEN 'reviewing' ELSE status END,reminded=0,updated_at=? WHERE id=?").run(date, win, now(), q.id);
      addEvent(q.id, `You requested ${slotLabel(date, win)}`);
      const row = db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id); row.slot_label = slotLabel(date, win); safe(alerts.rescheduled(row));
      return json(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/me\/quotes\/(XG-[A-F0-9]+)\/calendar\.ics$/);
    if (mm && m === 'GET') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=? AND customer_id=?').get(mm[1], me.id), ics = q && icsFor(q, me);
      if (!ics) return json(res, 404, { error: 'No appointment time on this request yet.' });
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="xpress-${q.ref}.ics"`, ...SEC }); return res.end(ics);
    }
    mm = p.match(/^\/api\/me\/quotes\/(XG-[A-F0-9]+)\/cancel$/);
    if (mm && m === 'POST') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=? AND customer_id=?').get(mm[1], me.id); if (!q) return json(res, 404, { error: 'Not found' });
      if (['completed', 'cancelled'].includes(q.status)) return json(res, 422, { error: 'This request is already closed.' });
      db.prepare("UPDATE quotes SET status='cancelled',updated_at=? WHERE id=?").run(now(), q.id); addEvent(q.id, 'Cancelled by you'); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }

  /* ---- staff sign-in (each person has their own account) ---- */
  if (p === '/api/staff/status' && m === 'GET') return json(res, 200, { needsSetup: db.prepare('SELECT COUNT(*) n FROM staff').get().n === 0 });
  if (p === '/api/staff/setup' && m === 'POST') { // one-time: create the first owner using the server's setup key (ADMIN_PASSWORD)
    if (limited('su' + ip, 8, 900e3)) return json(res, 429, { error: 'Too many attempts.' });
    if (db.prepare('SELECT COUNT(*) n FROM staff').get().n > 0) return json(res, 403, { error: 'Setup is already done. Please sign in.' });
    const d = await bodyOf(), email = clean(d.email, 120).toLowerCase(), name = clean(d.name, 80), pw = String(d.password || '');
    if (!same(String(d.key || ''), ADMIN_PASSWORD)) return json(res, 401, { error: 'That setup key is not correct.' });
    if (name.length < 2 || !validEmail(email)) return json(res, 422, { error: 'Enter your name and a valid email.' });
    if (pw.length < 10) return json(res, 422, { error: 'Password must be at least 10 characters.' });
    const salt = crypto.randomBytes(16).toString('hex'), r = db.prepare("INSERT INTO staff(email,name,role,pw_salt,pw_hash,created_at,last_login) VALUES(?,?,'owner',?,?,?,?)").run(email, name, salt, hashPw(pw, salt), now(), now());
    const st = db.prepare('SELECT * FROM staff WHERE id=?').get(Number(r.lastInsertRowid)); audit(st, 'staff.setup', email, 'first owner created');
    return json(res, 200, { staff: staffView(st) }, { 'set-cookie': startStaffSession(req, st.id) });
  }
  if (p === '/api/staff/login' && m === 'POST') {
    const d = await bodyOf(), email = clean(d.email, 120).toLowerCase();
    if (limited('a' + ip, 20, 900e3) || limited('ae' + email, 8, 900e3)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const st = db.prepare('SELECT * FROM staff WHERE lower(email)=? AND active=1').get(email);
    const ok = st ? same(hashPw(String(d.password || ''), st.pw_salt), st.pw_hash) : (hashPw('x', 'decoy-salt'), false); // same work either way so timing doesn't reveal which emails exist
    if (!ok) return json(res, 401, { error: 'Email or password is incorrect.' });
    db.prepare('UPDATE staff SET last_login=? WHERE id=?').run(now(), st.id); audit(st, 'login');
    return json(res, 200, { staff: staffView(st) }, { 'set-cookie': startStaffSession(req, st.id) });
  }
  if (p === '/api/staff/logout' && m === 'POST') { const t = cookies(req).xp_staff; if (t) db.prepare('DELETE FROM staff_sessions WHERE token_hash=?').run(sha(t)); return json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, 'xp_staff', '', 0, 'Strict') }); }
  if (p.startsWith('/api/staff/')) {
    const sf = staffFrom(req); if (!sf) return json(res, 401, { error: 'Unauthorized' });
    const owner = sf.role === 'owner', needOwner = () => json(res, 403, { error: 'Only an owner can do that.' });
    if (p === '/api/staff/me' && m === 'GET') return json(res, 200, { staff: staffView(sf) });
    if (p === '/api/staff/password' && m === 'POST') {
      const d = await bodyOf(), pw = String(d.newPassword || '');
      if (!same(hashPw(String(d.current || ''), sf.pw_salt), sf.pw_hash)) return json(res, 401, { error: 'Current password is incorrect.' });
      if (pw.length < 10) return json(res, 422, { error: 'New password must be at least 10 characters.' });
      if (pw === String(d.current)) return json(res, 422, { error: 'Choose a different password.' });
      const salt = crypto.randomBytes(16).toString('hex'), mine = sha(cookies(req).xp_staff || '');
      db.prepare('UPDATE staff SET pw_salt=?,pw_hash=?,must_change=0 WHERE id=?').run(salt, hashPw(pw, salt), sf.id);
      db.prepare('DELETE FROM staff_sessions WHERE staff_id=? AND token_hash!=?').run(sf.id, mine); audit(sf, 'password.change');
      return json(res, 200, { ok: true });
    }
    if (sf.must_change) return json(res, 403, { error: 'Please choose a new password first.', code: 'must_change' });
    if (p === '/api/staff/directory' && m === 'GET') return json(res, 200, { staff: db.prepare('SELECT id,name FROM staff WHERE active=1 ORDER BY name').all() });
    if (p === '/api/staff/team' && m === 'GET') { if (!owner) return needOwner(); return json(res, 200, { staff: db.prepare('SELECT * FROM staff ORDER BY active DESC, id').all().map(staffView), audit: db.prepare('SELECT staff_name AS who, action, target, detail, created_at AS at FROM audit ORDER BY id DESC LIMIT 100').all() }); }
    if (p === '/api/staff/team' && m === 'POST') {
      if (!owner) return needOwner();
      const d = await bodyOf(), email = clean(d.email, 120).toLowerCase(), name = clean(d.name, 80), role = d.role === 'owner' ? 'owner' : 'staff';
      if (name.length < 2 || !validEmail(email)) return json(res, 422, { error: 'Enter a name and a valid email.' });
      if (db.prepare('SELECT 1 FROM staff WHERE lower(email)=?').get(email)) return json(res, 409, { error: 'Someone with that email already has an account.' });
      const tmp = tempPassword(), salt = crypto.randomBytes(16).toString('hex');
      const r = db.prepare('INSERT INTO staff(email,name,role,pw_salt,pw_hash,must_change,created_at) VALUES(?,?,?,?,?,1,?)').run(email, name, role, salt, hashPw(tmp, salt), now());
      audit(sf, 'staff.add', email, role); return json(res, 200, { staff: staffView(db.prepare('SELECT * FROM staff WHERE id=?').get(Number(r.lastInsertRowid))), tempPassword: tmp });
    }
    mm = p.match(/^\/api\/staff\/team\/(\d+)$/);
    if (mm && m === 'PATCH') {
      if (!owner) return needOwner();
      const t = db.prepare('SELECT * FROM staff WHERE id=?').get(+mm[1]); if (!t) return json(res, 404, { error: 'Not found' });
      const d = await bodyOf(); let out = {};
      if (t.id === sf.id && (d.role !== undefined || d.active !== undefined)) return json(res, 422, { error: 'You can’t change your own role or deactivate yourself. Ask another owner.' });
      if (d.role === 'owner' || d.role === 'staff') { db.prepare('UPDATE staff SET role=? WHERE id=?').run(d.role, t.id); audit(sf, 'staff.role', t.email, d.role); }
      if (d.active !== undefined) { db.prepare('UPDATE staff SET active=? WHERE id=?').run(d.active ? 1 : 0, t.id); if (!d.active) db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(t.id); audit(sf, d.active ? 'staff.activate' : 'staff.deactivate', t.email); }
      if (d.resetPassword) { const tmp = tempPassword(), salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE staff SET pw_salt=?,pw_hash=?,must_change=1 WHERE id=?').run(salt, hashPw(tmp, salt), t.id); db.prepare('DELETE FROM staff_sessions WHERE staff_id=?').run(t.id); audit(sf, 'staff.password_reset', t.email); out.tempPassword = tmp; }
      return json(res, 200, { staff: staffView(db.prepare('SELECT * FROM staff WHERE id=?').get(t.id)), ...out });
    }
    if (p === '/api/staff/summary') {
      const c = (sql) => db.prepare(sql).get().n;
      return json(res, 200, { newQuotes: c("SELECT COUNT(*) n FROM quotes WHERE status='new'"), openChats: c("SELECT COUNT(*) n FROM conversations WHERE status='open'"), unreadChats: c('SELECT COUNT(*) n FROM conversations WHERE unread_staff>0'), customers: c('SELECT COUNT(*) n FROM customers'), scheduled: c("SELECT COUNT(*) n FROM quotes WHERE status='scheduled'"), available: staffAvailable, chat: chatState() });
    }
    if (p === '/api/staff/availability' && m === 'POST') { const d = await bodyOf(); staffAvailable = !!d.available; return json(res, 200, { available: staffAvailable }); }
    if (p === '/api/staff/quotes' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM quotes ORDER BY urgent DESC, id DESC LIMIT 500').all().map(q => ({ ...quoteView(q), name: q.name, email: q.email, phone: q.phone, staffNote: q.staff_note, assignedTo: q.assigned_to || '', assignedName: stName(q.assigned_to), hasAccount: !!q.customer_id })));
    mm = p.match(/^\/api\/staff\/quotes\/(XG-[A-F0-9]+)$/);
    if (mm && m === 'PATCH') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=?').get(mm[1]); if (!q) return json(res, 404, { error: 'Not found' });
      const d = await bodyOf(); const status = STATUSES.includes(d.status) ? d.status : q.status;
      const amount = d.quoteAmount !== undefined ? clean(d.quoteAmount, 40) : q.quote_amount; let sched = d.scheduledFor !== undefined ? clean(d.scheduledFor, 60) : q.scheduled_for, note = d.staffNote !== undefined ? clean(d.staffNote, 1000) : q.staff_note;
      let slotD = q.slot_date, slotW = q.slot_window;
      if (d.slotDate !== undefined) { // staff may override capacity; '' clears the slot
        if (d.slotDate === '') { slotD = ''; slotW = ''; }
        else if (parseYmd(clean(d.slotDate, 10)) && WINDOWS.some(w => w.id === d.slotWindow)) { slotD = clean(d.slotDate, 10); slotW = d.slotWindow; }
        else return json(res, 422, { error: 'Choose a valid date and window.' });
      }
      if ((slotD !== q.slot_date || slotW !== q.slot_window) && d.scheduledFor === undefined) sched = slotLabel(slotD, slotW);
      if (status === 'scheduled' && !sched && slotD) sched = slotLabel(slotD, slotW);
      db.prepare('UPDATE quotes SET status=?,quote_amount=?,scheduled_for=?,staff_note=?,slot_date=?,slot_window=?,reminded=CASE WHEN slot_date!=? OR slot_window!=? THEN 0 ELSE reminded END,updated_at=? WHERE id=?').run(status, amount, sched, note, slotD, slotW, slotD, slotW, now(), q.id);
      if (d.assignedTo !== undefined) { const who = +d.assignedTo ? db.prepare('SELECT id FROM staff WHERE id=? AND active=1').get(+d.assignedTo) : null; db.prepare('UPDATE quotes SET assigned_to=? WHERE id=?').run(who ? who.id : null, q.id); }
      audit(sf, 'quote.update', q.ref, `${q.status}${status !== q.status ? ' -> ' + status : ''}${amount !== q.quote_amount ? ' quote ' + amount : ''}`);
      if (status === 'completed' && q.status !== 'completed') scheduleFollowUps(q);
      if (status !== q.status) addEvent(q.id, STATUS_TEXT[status]);
      if (amount !== q.quote_amount && amount) addEvent(q.id, `Quote: ${amount}`);
      if (sched !== q.scheduled_for && sched) addEvent(q.id, `Appointment: ${sched}`);
      const changed = status !== q.status || (amount !== q.quote_amount && amount) || (sched !== q.scheduled_for && sched);
      if (changed && d.notify !== false) safe(alerts.quoteUpdated(db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id), STATUS_TEXT[status]));
      return json(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/staff\/quotes\/(XG-[A-F0-9]+)\/invoices$/);
    if (mm && m === 'POST') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=?').get(mm[1]); if (!q) return json(res, 404, { error: 'Not found' });
      const d = await bodyOf(), cents = parseDollars(d.amount), kind = d.kind === 'deposit' ? 'deposit' : 'payment', desc = clean(d.description, 120);
      const dueBase = clean(d.dueDate, 10), n = Math.floor(+d.installments) || 1, every = [7, 14, 30].includes(+d.everyDays) ? +d.everyDays : 30;
      if (!cents) return json(res, 422, { error: 'Enter an amount between $1.00 and $50,000.' });
      if (dueBase && !parseYmd(dueBase)) return json(res, 422, { error: 'Choose a valid due date.' });
      if (n < 1 || n > 6) return json(res, 422, { error: 'Installments: 1 to 6.' });
      const each = Math.floor(cents / n); if (n > 1 && each < 100) return json(res, 422, { error: 'Each installment must be at least $1.00.' });
      const made = [];
      for (let i = 0; i < n; i++) {
        const amt = i === n - 1 ? cents - each * (n - 1) : each, base = dueBase ? parseYmd(dueBase) : (n > 1 ? wallNow(q.state) : null);
        const due = base ? ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * every)) : '';
        const r = db.prepare('INSERT INTO invoices(quote_id,kind,description,amount_cents,due_date,created_at) VALUES(?,?,?,?,?,?)').run(q.id, n > 1 ? 'installment' : kind, n > 1 ? `${desc ? desc + ' · ' : ''}installment ${i + 1} of ${n}` : desc, amt, due, now());
        made.push(invView(db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(r.lastInsertRowid))));
      }
      audit(sf, 'invoice.create', q.ref, `${money(cents)}${n > 1 ? ' x' + n : ''}`);
      addEvent(q.id, n > 1 ? `Payment plan set up: ${n} × about ${money(each)}` : `Payment requested: ${money(cents)} (${kind})`);
      if (d.notify !== false) safe(n > 1 ? alerts.planCreated(q, made) : alerts.invoiceCreated(q, made[0]));
      return json(res, 200, { invoices: made });
    }
    mm = p.match(/^\/api\/staff\/invoices\/(\d+)\/receipt$/);
    if (mm && m === 'GET') { const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(+mm[1]); return inv ? sendHtml(res, receiptHtml(inv, db.prepare('SELECT * FROM quotes WHERE id=?').get(inv.quote_id))) : json(res, 404, { error: 'Not found' }); }
    mm = p.match(/^\/api\/staff\/invoices\/(\d+)$/);
    if (mm && m === 'PATCH') {
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(+mm[1]); if (!inv) return json(res, 404, { error: 'Not found' });
      const d = await bodyOf();
      if (d.action === 'void') { if (inv.status !== 'open') return json(res, 422, { error: 'Only unpaid requests can be voided.' }); audit(sf, 'invoice.void', `#${inv.id}`, money(inv.amount_cents)); db.prepare("UPDATE invoices SET status='void' WHERE id=?").run(inv.id); addEvent(inv.quote_id, `Payment request cancelled: ${money(inv.amount_cents)}`); return json(res, 200, { ok: true }); }
      if (d.action === 'mark_paid') { const method = ['cash', 'check', 'card-in-person', 'other'].includes(d.method) ? d.method : 'other'; if (inv.status !== 'open') return json(res, 422, { error: 'This request is not open.' }); audit(sf, 'invoice.mark_paid', `#${inv.id}`, `${money(inv.amount_cents)} ${method}`); markPaid(inv.id, method); return json(res, 200, { ok: true }); }
      if (d.action === 'refund') {
        if (!owner) return needOwner();
        if (!['paid'].includes(inv.status)) return json(res, 422, { error: 'Only paid invoices can be refunded.' });
        const left = inv.amount_cents - inv.refunded_cents, cents = d.amount === undefined || String(d.amount).trim() === '' ? left : parseDollars(d.amount);
        if (!cents || cents > left) return json(res, 422, { error: `Enter a refund between $1.00 and ${money(left)}.` });
        if (inv.method === 'card') {
          if (!inv.stripe_pi || !pay.enabled()) return json(res, 422, { error: 'This card payment can only be refunded from your Stripe dashboard.' });
          try { await pay.refund(inv.stripe_pi, cents, `xpress-refund-${inv.id}-${inv.refunded_cents}-${cents}`); } catch (e) { console.error('STRIPE refund failed:', e.message); return json(res, 502, { error: 'Stripe could not issue the refund: ' + e.message }); }
        }
        setRefundTotal(inv.id, inv.refunded_cents + cents); audit(sf, 'invoice.refund', `#${inv.id}`, money(cents)); return json(res, 200, { ok: true });
      }
      return json(res, 422, { error: 'Unknown action' });
    }
    if (p === '/api/staff/reviews' && m === 'GET') {
      const rows = db.prepare("SELECT rr.*, q.ref, q.name, q.service, q.city, q.state FROM review_requests rr JOIN quotes q ON q.id=rr.quote_id ORDER BY (rr.responded_at='') , rr.responded_at DESC, rr.id DESC LIMIT 300").all();
      const rated = rows.filter(r => r.rating), sent = rows.filter(r => r.sent_at || r.rating).length;
      return json(res, 200, { stats: { sent, responded: rated.length, avg: rated.length ? Math.round(rated.reduce((a, r) => a + r.rating, 0) / rated.length * 10) / 10 : 0, low: rated.filter(r => r.rating <= 3).length, publicClicks: rows.filter(r => r.clicked_public).length, googleLink: !!GOOGLE_URL() },
        onSite: rows.filter(r => r.featured).length, list: rows.map(r => ({ publicOk: !!r.public_ok, featured: !!r.featured, ref: r.ref, name: r.name, service: r.service, city: r.city, state: r.state, rating: r.rating, comment: r.comment, via: r.via, sentAt: r.sent_at, respondedAt: r.responded_at, clickedPublic: !!r.clicked_public })) });
    }
    mm = p.match(/^\/api\/staff\/reviews\/(XG-[A-F0-9]+)$/);
    if (mm && m === 'PATCH') {
      const row = db.prepare('SELECT rr.*, q.ref FROM review_requests rr JOIN quotes q ON q.id=rr.quote_id WHERE q.ref=?').get(mm[1]); if (!row) return json(res, 404, { error: 'Not found' });
      const d = await bodyOf(), on = !!d.featured;
      if (on) {
        if (!row.rating) return json(res, 422, { error: 'This customer has not left a rating.' });
        if (!row.public_ok) return json(res, 422, { error: 'This customer did not agree to show their review publicly. Ask them first (they can tick the box when they update their review in their account).' });
        if (String(row.comment || '').trim().length < 10) return json(res, 422, { error: 'Only reviews with a written comment can be shown.' });
      }
      db.prepare('UPDATE review_requests SET featured=? WHERE id=?').run(on ? 1 : 0, row.id); audit(sf, on ? 'review.publish' : 'review.unpublish', row.ref); return json(res, 200, { ok: true });
    }
    mm = p.match(/^\/api\/staff\/quotes\/(XG-[A-F0-9]+)\/review$/);
    if (mm && m === 'POST') {
      const q = db.prepare('SELECT * FROM quotes WHERE ref=?').get(mm[1]); if (!q) return json(res, 404, { error: 'Not found' });
      if (q.status !== 'completed') return json(res, 422, { error: 'Mark the job completed first.' });
      const d = await bodyOf(); db.prepare('INSERT OR IGNORE INTO review_requests(quote_id,send_at) VALUES(?,?)').run(q.id, now());
      const rr = db.prepare('SELECT * FROM review_requests WHERE quote_id=?').get(q.id), link = newReviewLink(rr.id);
      if (d.action === 'send') {
        if (optedOut(q.email)) return json(res, 422, { error: 'This customer unsubscribed from emails.' });
        db.prepare('UPDATE review_requests SET sent_at=? WHERE id=?').run(now(), rr.id); addEvent(q.id, 'Review request sent'); audit(sf, 'review.send', q.ref); safe(alerts.reviewRequest(q, link, false, unsubUrl(q.email)));
      }
      return json(res, 200, { link, emailSent: d.action === 'send' && alerts.channels().customerEmail });
    }
    mm = p.match(/^\/api\/staff\/photos\/(\d+)$/);
    if (mm && m === 'GET') { const ph = db.prepare('SELECT * FROM photos WHERE id=?').get(+mm[1]); return ph ? sendPhoto(res, ph) : json(res, 404, { error: 'Not found' }); }
    if (p === '/api/staff/schedule' && m === 'GET') {
      const from = parseYmd(url.searchParams.get('from')) || wallNow('PA'), days = Math.min(60, +url.searchParams.get('days') || 14), a = ymd(from), b = ymd(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
      return json(res, 200, { settings: getSchedule(), windows: WINDOWS.map(w => w.id), bookings: db.prepare("SELECT ref,name,phone,service,city,state,status,slot_date AS date,slot_window AS win FROM quotes WHERE slot_date>=? AND slot_date<? AND status!='cancelled' ORDER BY slot_date,slot_window,id").all(a, b) });
    }
    if (p === '/api/staff/schedule/settings' && m === 'PUT') {
      if (!owner) return needOwner();
      const d = await bodyOf(), cur = getSchedule(), next = { ...cur };
      if (d.capacity) for (const st of STATES) if (d.capacity[st] !== undefined) next.capacity[st] = Math.max(0, Math.min(20, Math.floor(+d.capacity[st]) || 0));
      if (Array.isArray(d.openDays)) next.openDays = [...new Set(d.openDays.map(Number).filter(n => n >= 0 && n <= 6))];
      if (Array.isArray(d.blackouts)) next.blackouts = [...new Set(d.blackouts.map(String).filter(v => parseYmd(v)))].sort();
      if (d.leadHours !== undefined) next.leadHours = Math.max(0, Math.min(72, +d.leadHours || 0));
      db.prepare("INSERT INTO settings(key,value) VALUES('schedule',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
      audit(sf, 'schedule.settings', '', JSON.stringify({ cap: next.capacity, days: next.openDays, off: next.blackouts.length }));
      return json(res, 200, { settings: next });
    }
    if (p === '/api/staff/customers' && m === 'GET') return json(res, 200, db.prepare('SELECT c.id,c.name,c.email,c.phone,c.city,c.state,c.created_at,(SELECT COUNT(*) FROM quotes q WHERE q.customer_id=c.id) AS quotes,(SELECT COUNT(*) FROM quotes q WHERE q.customer_id=c.id AND q.status=\'completed\') AS jobs FROM customers c ORDER BY c.id DESC LIMIT 500').all());
    mm = p.match(/^\/api\/staff\/customers\/(\d+)$/);
    if (mm && m === 'GET') {
      const c = db.prepare('SELECT * FROM customers WHERE id=?').get(+mm[1]); if (!c) return json(res, 404, { error: 'Not found' });
      return json(res, 200, { customer: { ...publicCustomer(c) }, quotes: db.prepare('SELECT * FROM quotes WHERE customer_id=? ORDER BY id DESC').all(c.id).map(quoteView), notes: db.prepare('SELECT id,body,created_at AS at FROM customer_notes WHERE customer_id=? ORDER BY id DESC').all(c.id) });
    }
    mm = p.match(/^\/api\/staff\/customers\/(\d+)\/notes$/);
    if (mm && m === 'POST') { const d = await bodyOf(), t = clean(d.body, 1000); if (!t) return json(res, 422, { error: 'Empty note' }); db.prepare('INSERT INTO customer_notes(customer_id,body,created_at) VALUES(?,?,?)').run(+mm[1], t, now()); return json(res, 200, { ok: true }); }
    if (p === '/api/staff/chats' && m === 'GET') return json(res, 200, db.prepare("SELECT c.id,c.name,c.email,c.topic,c.status,c.unread_staff,c.customer_id,c.last_at,(SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last FROM conversations c ORDER BY (c.unread_staff>0) DESC, c.last_at DESC LIMIT 200").all());
    mm = p.match(/^\/api\/staff\/chats\/(\d+)$/);
    if (mm) {
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(+mm[1]); if (!conv) return json(res, 404, { error: 'Not found' });
      if (m === 'GET') { db.prepare('UPDATE conversations SET unread_staff=0 WHERE id=?').run(conv.id); return json(res, 200, { ...convoView(conv, +url.searchParams.get('after') || 0), email: conv.email, customerId: conv.customer_id }); }
      if (m === 'POST') { const d = await bodyOf(), t = clean(d.message, 2000); if (!t) return json(res, 422, { error: 'Empty message' }); postMessage(conv.id, 'staff', t, sf.name.split(' ')[0]); safe(alerts.staffReplied(conv, t)); return json(res, 200, { ok: true }); }
      if (m === 'PATCH') { const d = await bodyOf(); db.prepare('UPDATE conversations SET status=? WHERE id=?').run(d.status === 'closed' ? 'closed' : 'open', conv.id); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { error: 'Not found' });
  }
  json(res, 404, { error: 'Not found' });
}

function serve(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const isPrivate = p.startsWith('/admin') || p.startsWith('/account');
  for (const base of [PUB, DIST]) {
    let f = path.normalize(path.join(base, p));
    if (f !== base && !f.startsWith(base + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) continue;
    const ext = path.extname(f);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ['.html', '.js', '.css'].includes(ext) || base === PUB ? 'no-cache' : 'public, max-age=86400', ...SEC, ...(isPrivate ? { 'x-robots-tag': 'noindex' } : {}) });
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404, { 'content-type': TYPES['.html'], ...SEC });
  res.end(fs.existsSync(path.join(DIST, '404.html')) ? fs.readFileSync(path.join(DIST, '404.html')) : 'Not found');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { try { db.prepare('SELECT 1').get(); res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('ok'); } catch { res.writeHead(503); return res.end('database error'); } }
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => json(res, e.code === 400 ? 400 : 500, { error: e.code === 400 ? 'Invalid request' : 'Server error' }) || (e.code === 400 || console.error(e)));
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serve(req, res, url);
});
server.listen(PORT, HOST, () => console.log(`${db.prepare('SELECT COUNT(*) n FROM staff').get().n ? '' : 'No staff accounts yet: open /admin/ and create the owner account (setup key = ADMIN_PASSWORD).\n'}Alerts: ${alerts.describe()}\nPayments: ${pay.describe()}\nXpress running on http://localhost:${PORT}  (staff: /admin/, customers: /account/)`));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException', e => { console.error('Uncaught exception:', e); process.exit(1); }); // the service manager restarts us
if (TRUST_PROXY && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) console.warn('WARNING: TRUST_PROXY is on but HOST is not 127.0.0.1, so visitors could fake their address. Set HOST=127.0.0.1 behind Caddy.');
if (AUTO_VERIFY) console.warn('WARNING: AUTO_VERIFY is on: customer emails are NOT checked. Use only for local testing.');
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`${sig}: shutting down`); server.close(() => { try { db.close(); } catch { } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });
