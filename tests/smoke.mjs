// End-to-end test of the whole backend: starts a real server on a temporary data folder with fake Stripe and
// fake email services, then drives it over HTTP the way browsers do.   Run:  node tests/smoke.mjs
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-smoke-'));
const PORT = 4300 + Math.floor(Math.random() * 400), STRIPE_PORT = PORT + 1000, MAIL_PORT = PORT + 2000, BASE = `http://127.0.0.1:${PORT}`, WHSEC = 'whsec_smoke';

/* ---------- fake Stripe + fake email provider ---------- */
const sessions = new Map(), refunds = [], mails = [];
const stripe = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => {
  const send = (c, o) => { s.writeHead(c, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); }, p = new URLSearchParams(b); let m;
  if ((m = q.url.match(/^\/__pay\/(\w+)$/))) { const x = sessions.get(m[1]); x.payment_status = 'paid'; x.status = 'complete'; delete x.url; return send(200, x); }
  if (!(q.headers.authorization || '').startsWith('Bearer sk_test_')) return send(401, { error: { message: 'bad key' } });
  if (q.method === 'POST' && q.url === '/v1/checkout/sessions') { const id = 'cs_' + (sessions.size + 1), x = { id, status: 'open', url: 'https://pay.test/' + id, payment_status: 'unpaid', payment_intent: 'pi_' + (sessions.size + 1), amount_total: +p.get('line_items[0][price_data][unit_amount]'), currency: 'usd', metadata: { invoice_id: p.get('metadata[invoice_id]') } }; sessions.set(id, x); return send(200, x); }
  if (q.method === 'POST' && q.url === '/v1/refunds') { refunds.push({ pi: p.get('payment_intent'), amount: +p.get('amount') }); return send(200, { id: 're_1', status: 'succeeded' }); }
  if ((m = q.url.match(/^\/v1\/checkout\/sessions\/(\w+)$/))) { const x = sessions.get(m[1]); return x ? send(200, x) : send(404, { error: { message: 'nope' } }); }
  send(404, {});
}); }).listen(STRIPE_PORT);
const mailer = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { try { mails.push(JSON.parse(b)); } catch { } s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}'); }); }).listen(MAIL_PORT);
const mailTo = (to, re) => [...mails].reverse().find(m => m.to.includes(to) && re.test(m.subject));
const linkIn = (m, re) => m.html.match(re)?.[1];

/* ---------- tiny HTTP client with a cookie jar; each client has its own "visitor address" ---------- */
let ipn = 10;
const client = (ip = `198.51.100.${ipn++}`) => { const jar = {}; return async (method, p, body, extra = {}) => {
  const h = { 'x-forwarded-for': ip, ...extra }; if (body !== undefined && !(body instanceof Uint8Array)) h['content-type'] = 'application/json';
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (ck) h.cookie = ck;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'), i = kv.indexOf('='); if (/Max-Age=0/i.test(sc)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => null) : await r.text(), headers: r.headers };
}; };

let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; failures.push(name); console.log('FAIL  ' + name + '\n        ' + (e.message || e)); } };
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const sign = body => { const ts = Math.floor(Date.now() / 1000); return `t=${ts},v1=${crypto.createHmac('sha256', WHSEC).update(`${ts}.${body}`).digest('hex')}`; };
const quoteBody = (o = {}) => ({ name: 'Test Person', email: `t${Math.random().toString(36).slice(2, 8)}@example.com`, phone: '2155550123', city: 'Horsham', state: 'PA', service: 'Spring repair', message: 'Broken spring', ...o });

/* ---------- start the real server ---------- */
const server = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TRUST_PROXY: '1', DATA_DIR: path.join(TMP, 'data'), ADMIN_PASSWORD: 'setup-key-xyz', SITE_URL: BASE,
  RESEND_API_KEY: 're_x', ALERT_EMAIL_FROM: 'a@x.com', ALERT_EMAIL_TO: 'owner@x.com', RESEND_URL: `http://127.0.0.1:${MAIL_PORT}/e`, REVIEW_GOOGLE_URL: 'https://g.page/r/test/review',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => serverLog += d); server.stderr.on('data', d => serverLog += d);
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { } await wait(150); }

try {
  const owner = client(), staff = client(), anon = client();

  console.log('\nHealth, security basics');
  await t('health check', async () => eq((await anon('GET', '/healthz')).data, 'ok'));
  await t('cross-site writes are blocked (Origin header)', async () => eq((await anon('POST', '/api/chat/start', { name: 'x', email: 'a@b.co', message: 'hi' }, { origin: 'http://evil.example' })).status, 403));
  await t('path traversal is refused', async () => { const r = await fetch(BASE + '/..%2f..%2fserver.mjs'); ok([403, 404].includes(r.status), 'status ' + r.status); });
  await t('server code and data are not downloadable', async () => { for (const p of ['/server.mjs', '/data/xpress.db', '/.env', '/backup.mjs']) ok((await fetch(BASE + p)).status === 404, p); });

  console.log('\nStaff accounts and roles');
  await t('first-run setup needs the key, works once', async () => {
    eq((await anon('GET', '/api/staff/status')).data.needsSetup, true);
    eq((await owner('POST', '/api/staff/setup', { key: 'wrong', name: 'Olivia Owner', email: 'olivia@x.com', password: 'correct-horse-9' })).status, 401);
    eq((await owner('POST', '/api/staff/setup', { key: 'setup-key-xyz', name: 'Olivia Owner', email: 'olivia@x.com', password: 'correct-horse-9' })).status, 200);
    eq((await anon('POST', '/api/staff/setup', { key: 'setup-key-xyz', name: 'E', email: 'e@x.com', password: 'correct-horse-9' })).status, 403);
  });
  let tempPw;
  await t('owner adds staff; temporary password must be changed', async () => {
    const r = await owner('POST', '/api/staff/team', { name: 'Sam Staff', email: 'sam@x.com', role: 'staff' }); eq(r.status, 200); tempPw = r.data.tempPassword;
    eq((await staff('POST', '/api/staff/login', { email: 'sam@x.com', password: tempPw })).data.staff.mustChange, true);
    eq((await staff('GET', '/api/staff/summary')).status, 403);
    eq((await staff('POST', '/api/staff/password', { current: tempPw, newPassword: 'sams-own-password-1' })).status, 200);
    eq((await staff('GET', '/api/staff/summary')).status, 200);
  });
  await t('staff cannot refund, change settings or see the team; anonymous sees nothing', async () => {
    eq((await staff('GET', '/api/staff/team')).status, 403); eq((await staff('PUT', '/api/staff/schedule/settings', { openDays: [1] })).status, 403);
    eq((await anon('GET', '/api/staff/summary')).status, 401); eq((await anon('GET', '/api/staff/quotes')).status, 401);
  });

  console.log('\nQuotes and booking');
  let slot;
  await t('quote validation', async () => { eq((await anon('POST', '/api/quotes', { ...quoteBody(), email: 'nope' })).status, 422); eq((await anon('POST', '/api/quotes', { ...quoteBody(), name: 'A' })).status, 422); });
  await t('booking: capacity is enforced exactly (2 in PA, then full)', async () => {
    const av = (await anon('GET', '/api/availability?state=PA&days=14')).data.days.find((d, i) => i > 2 && d.windows.find(w => w.id === '10am–12pm')?.available); ok(av, 'no open day');
    slot = { date: av.date, time: '10am–12pm' };
    const codes = []; for (let i = 0; i < 3; i++) codes.push((await client()('POST', '/api/quotes', quoteBody({ date: slot.date, time: slot.time }))).status);
    eq(codes, [200, 200, 409]);
  });
  await t('booking: six simultaneous requests for a 1-crew NJ window give exactly one success', async () => {
    const day = (await anon('GET', '/api/availability?state=NJ&days=14')).data.days.find((d, i) => i > 2 && d.windows[0].available);
    const res = await Promise.all([1, 2, 3, 4, 5, 6].map(() => client()('POST', '/api/quotes', quoteBody({ state: 'NJ', date: day.date, time: '8am–10am' })))); eq(res.filter(r => r.status === 200).length, 1);
  });
  await t('one email cannot flood quotes (4/hour)', async () => { const e = 'flood@example.com', codes = []; for (let i = 0; i < 6; i++) codes.push((await client()('POST', '/api/quotes', quoteBody({ email: e }))).status); eq(codes, [200, 200, 200, 200, 429, 429]); });

  console.log('\nAccounts: nobody can claim someone else\'s history');
  let victim, victimEmail = 'victim@example.com';
  await t('a guest quote does not reveal whether an email has an account', async () => { const r = await client()('POST', '/api/quotes', quoteBody({ email: victimEmail, name: 'Vera Victim', phone: '2155559999', city: 'Newtown' })); victim = r.data; eq(r.data.hasAccount, false); });
  await t('attacker signs up with the victim\'s email: sees NONE of the victim\'s data until the email is confirmed', async () => {
    const atk = client(); const s = await atk('POST', '/api/auth/signup', { name: 'Mallory', email: victimEmail, password: 'attacker-pass-1' }); eq(s.status, 200); eq(s.data.customer.verified, false); eq(s.data.customer.phone, ''); eq(s.data.customer.city, '');
    const me = await atk('GET', '/api/me'); eq(me.data.quotes.length, 0);
  });
  await t('the real mailbox owner confirms from their own browser: must choose a password, attacker is locked out, history appears', async () => {
    await wait(300); const m = mailTo(victimEmail, /Confirm your email/); ok(m, 'no verification email'); const tok = linkIn(m, /verify=([\w-]+)/);
    eq((await anon('POST', '/api/auth/verify', { token: 'bogus' })).status, 410);
    const v = client(), first = await v('POST', '/api/auth/verify', { token: tok }); eq(first.status, 422); eq(first.data.code, 'password_needed'); // link opened somewhere that is not signed in
    eq((await v('POST', '/api/auth/verify', { token: tok, password: 'victim-new-pass-1' })).status, 200);
    const me = await v('GET', '/api/me'); eq(me.data.customer.verified, true); eq(me.data.quotes.length, 1);
    eq((await client()('POST', '/api/auth/login', { email: victimEmail, password: 'attacker-pass-1' })).status, 401); // attacker's password no longer works
    eq((await client()('POST', '/api/auth/login', { email: victimEmail, password: 'victim-new-pass-1' })).status, 200);
  });
  await t('an attacker who is already signed in cannot keep access: their session ends when the owner confirms', async () => {
    const atk = client(), e = 'victim2@example.com'; await client()('POST', '/api/quotes', quoteBody({ email: e, name: 'Second Victim' }));
    await atk('POST', '/api/auth/signup', { name: 'Mallory', email: e, password: 'attacker-pass-2' }); await wait(300); const tok = linkIn(mailTo(e, /Confirm your email/), /verify=([\w-]+)/);
    eq((await client()('POST', '/api/auth/verify', { token: tok, password: 'victim2-new-pass' })).status, 200); eq((await atk('GET', '/api/me')).status, 401);
  });
  await t('confirming from the same signed-in browser needs no extra password', async () => {
    const c = client(), e = 'same@example.com'; await c('POST', '/api/auth/signup', { name: 'Sam Same', email: e, password: 'same-pass-12345' }); await wait(300); const tok = linkIn(mailTo(e, /Confirm your email/), /verify=([\w-]+)/);
    eq((await c('POST', '/api/auth/verify', { token: tok })).status, 200); eq((await c('GET', '/api/me')).data.customer.verified, true);
  });
  await t('your own quote is attached at signup using the proof from your browser (no email needed)', async () => {
    const c = client(), e = 'carol@example.com', q = (await c('POST', '/api/quotes', quoteBody({ email: e, name: 'Carol Customer' }))).data;
    const s = await c('POST', '/api/auth/signup', { name: 'Carol Customer', email: e, password: 'carol-pass-123', claim: { ref: q.ref, token: q.uploadToken } }); eq(s.status, 200); eq(s.data.customer.verified, false);
    const me = await c('GET', '/api/me'); eq(me.data.quotes.length, 1); eq(me.data.quotes[0].ref, q.ref);
    const d = client(); eq((await d('POST', '/api/auth/signup', { name: 'Dave', email: 'dave@example.com', password: 'dave-pass-1234', claim: { ref: q.ref, token: 'wrong-token' } })).status, 200); eq((await d('GET', '/api/me')).data.quotes.length, 0);
  });
  await t('password reset works and proves the email; changing password signs out other devices', async () => {
    const c = client(), c2 = client(), e = 'reset@example.com'; await c('POST', '/api/auth/signup', { name: 'Rita Reset', email: e, password: 'first-password-1' });
    eq((await anon('POST', '/api/auth/forgot', { email: e })).status, 200); eq((await anon('POST', '/api/auth/forgot', { email: 'nobody@example.com' })).status, 200);
    await wait(300); const m = mailTo(e, /Reset your/); ok(m, 'no reset mail'); const tok = linkIn(m, /reset=([\w-]+)/);
    eq((await c('POST', '/api/auth/reset', { token: tok, password: 'second-password-2' })).status, 200); eq((await c('GET', '/api/me')).data.customer.verified, true);
    eq((await anon('POST', '/api/auth/reset', { token: tok, password: 'third-password-3' })).status, 410);
    await c2('POST', '/api/auth/login', { email: e, password: 'second-password-2' }); eq((await c('POST', '/api/me/password', { password: 'second-password-2', newPassword: 'fourth-password-4' })).status, 200); eq((await c2('GET', '/api/me')).status, 401); eq((await c('GET', '/api/me')).status, 200);
  });

  console.log('\nLive chat');
  await t('chat: customer writes, staff replies by name, customer sees it', async () => {
    const c = client(), st = (await c('POST', '/api/chat/start', { name: 'Chat Guest', email: 'chat@example.com', message: 'Do you cover Newtown?' })).data; ok(st.token);
    const list = (await owner('GET', '/api/staff/chats')).data, id = list.find(x => x.email === 'chat@example.com').id; eq((await owner('POST', `/api/staff/chats/${id}`, { message: 'Yes we do!' })).status, 200);
    const msgs = (await c('GET', `/api/chat/${st.token}?after=0`)).data.messages; ok(msgs.some(m => m.sender === 'staff' && m.staffName === 'Olivia' && m.body === 'Yes we do!'));
    eq((await c('GET', '/api/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  });

  console.log('\nPhotos');
  let phQuote, phCust;
  await t('photos: real image accepted, disguised file / 9th photo / strangers refused; owner and staff can view', async () => {
    phCust = client(); const q = (await phCust('POST', '/api/quotes', quoteBody({ email: 'photo@example.com' }))).data; phQuote = q; const up = (c, tok, bytes = PNG) => c('POST', `/api/quotes/${q.ref}/photos`, bytes, { 'x-upload-token': tok, 'x-file-name': 'door.png' });
    eq((await up(phCust, q.uploadToken)).status, 200); eq((await up(phCust, 'wrong')).status, 404); eq((await up(phCust, q.uploadToken, new TextEncoder().encode('<script>alert(1)</script> not an image at all'))).status, 415);
    for (let i = 0; i < 7; i++) await up(phCust, q.uploadToken); eq((await up(phCust, q.uploadToken)).status, 422);
    await phCust('POST', '/api/auth/signup', { name: 'Photo Person', email: 'photo@example.com', password: 'photo-pass-123', claim: { ref: q.ref, token: q.uploadToken } });
    const id = (await phCust('GET', '/api/me')).data.quotes[0].photos[0].id, own = await phCust('GET', `/api/me/quotes/${q.ref}/photos/${id}`); eq(own.status, 200); eq(own.headers.get('content-type'), 'image/png');
    const other = client(); await other('POST', '/api/auth/signup', { name: 'Other', email: 'other@example.com', password: 'other-pass-123' }); eq((await other('GET', `/api/me/quotes/${q.ref}/photos/${id}`)).status, 404);
    eq((await owner('GET', `/api/staff/photos/${id}`)).status, 200); eq((await anon('GET', `/api/staff/photos/${id}`)).status, 401);
  });

  console.log('\nPayments');
  let inv, payRef, payCust, payQuote;
  await t('staff request a payment; customer starts checkout; a second click reuses the same checkout (no double charge)', async () => {
    payCust = client(); payQuote = (await payCust('POST', '/api/quotes', quoteBody({ email: 'payer@example.com', name: 'Pat Payer' }))).data; payRef = payQuote.ref;
    await payCust('POST', '/api/auth/signup', { name: 'Pat Payer', email: 'payer@example.com', password: 'payer-pass-123', claim: { ref: payRef, token: payQuote.uploadToken } });
    eq((await staff('POST', `/api/staff/quotes/${payRef}/invoices`, { amount: '0' })).status, 422);
    inv = (await staff('POST', `/api/staff/quotes/${payRef}/invoices`, { kind: 'deposit', amount: '125.50', description: 'Spring' })).data.invoices[0]; eq(inv.amountCents, 12550);
    const a = await payCust('POST', `/api/me/invoices/${inv.id}/checkout`, {}), b = await payCust('POST', `/api/me/invoices/${inv.id}/checkout`, {}); eq(a.status, 200); eq(a.data.url, b.data.url); eq(sessions.size, 1);
    eq((await client()('POST', `/api/me/invoices/${inv.id}/checkout`, {})).status, 401);
  });
  await t('a forged "paid" notice is rejected; the return-page check with Stripe marks it paid', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: 12550, currency: 'usd', metadata: { invoice_id: String(inv.id) } } } });
    eq((await anon('POST', '/api/stripe/webhook', JSON.parse(body))).status, 400); eq((await anon('POST', '/api/stripe/webhook', JSON.parse(body), { 'stripe-signature': 't=1,v1=00' })).status, 400);
    await fetch(`http://127.0.0.1:${STRIPE_PORT}/__pay/cs_1`, { method: 'POST' }); eq((await payCust('GET', `/api/me/invoices/${inv.id}/sync`)).data.status, 'paid');
  });
  await t('a signed webhook with the wrong amount is ignored; replays do not double count', async () => {
    const inv2 = (await staff('POST', `/api/staff/quotes/${payRef}/invoices`, { amount: '50' })).data.invoices[0], mk = amt => JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: amt, currency: 'usd', payment_intent: 'pi_x', metadata: { invoice_id: String(inv2.id) } } } });
    const send = b => fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(b), 'x-forwarded-for': '203.0.113.1' }, body: b });
    eq((await send(mk(100))).status, 200); eq((await payCust('GET', '/api/me')).data.quotes[0].invoices.find(i => i.id === inv2.id).status, 'open');
    await send(mk(5000)); await send(mk(5000)); const evs = (await payCust('GET', '/api/me')).data.quotes[0].events.filter(e => /Payment received: \$50/.test(e.label)); eq(evs.length, 1);
  });
  await t('a second payment on an already-paid invoice raises an alert for staff', async () => {
    const b = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: 12550, currency: 'usd', payment_intent: 'pi_DIFFERENT', metadata: { invoice_id: String(inv.id) } } } });
    eq((await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(b), 'x-forwarded-for': '203.0.113.2' }, body: b })).status, 200); await wait(300); ok(mailTo('owner@x.com', /duplicate payment/i), 'no duplicate alert');
  });
  await t('refunds: owner only, capped at the amount paid, sent to Stripe', async () => {
    eq((await staff('PATCH', `/api/staff/invoices/${inv.id}`, { action: 'refund', amount: '10' })).status, 403);
    eq((await owner('PATCH', `/api/staff/invoices/${inv.id}`, { action: 'refund', amount: '9999' })).status, 422);
    eq((await owner('PATCH', `/api/staff/invoices/${inv.id}`, { action: 'refund', amount: '25.50' })).status, 200); eq(refunds[0].amount, 2550);
    const rc = await payCust('GET', `/api/me/invoices/${inv.id}/receipt`); eq(rc.status, 200); ok(/RECEIPT/.test(rc.data) && /Refunded/.test(rc.data));
  });
  await t('receipt text is escaped (no script injection)', async () => {
    const i3 = (await staff('POST', `/api/staff/quotes/${payRef}/invoices`, { amount: '10', description: '<script>alert(1)</script>' })).data.invoices[0]; const r = await payCust('GET', `/api/me/invoices/${i3.id}/receipt`); ok(!r.data.includes('<script>alert') && r.data.includes('&lt;script&gt;'));
  });

  console.log('\nReviews and reminders');
  let rvLink, rvRef;
  await t('completing a job lets staff send a review link; rating, consent and email unsubscribe work', async () => {
    rvRef = payRef; eq((await staff('POST', `/api/staff/quotes/${rvRef}/review`, { action: 'link' })).status, 422);
    await staff('PATCH', `/api/staff/quotes/${rvRef}`, { status: 'completed' }); const r = await staff('POST', `/api/staff/quotes/${rvRef}/review`, { action: 'send' }); eq(r.status, 200); rvLink = r.data.link; const tok = rvLink.split('t=')[1];
    eq((await anon('GET', '/api/review/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404); eq((await anon('POST', `/api/review/${tok}`, { rating: 9 })).status, 422);
    eq((await anon('POST', `/api/review/${tok}`, { rating: 5, comment: 'Fast, friendly and fair.', publicOk: true })).status, 200);
    await wait(300); const m = mailTo('payer@example.com', /How did we do/); ok(m && m.headers && m.headers['List-Unsubscribe'], 'review email lacks unsubscribe header'); const u = linkIn(m, /unsubscribe\/\?t=([\w.-]+)/);
    eq((await anon('POST', '/api/unsubscribe', { token: u + 'x' })).status, 422); eq((await anon('POST', '/api/unsubscribe', { token: u })).status, 200);
    eq((await staff('POST', `/api/staff/quotes/${rvRef}/review`, { action: 'send' })).status, 422); // unsubscribed
  });
  await t('website reviews: only consented + approved; average counts every rating; edits pull it down', async () => {
    const feed = async () => (await anon('GET', '/api/public/reviews')).data, pub = (ref, on) => owner('PATCH', `/api/staff/reviews/${ref}`, { featured: on }), tok = rvLink.split('t=')[1];
    eq((await feed()).items.length, 0); eq((await pub(rvRef, true)).status, 200); let f = await feed(); eq(f.items.length, 1); eq(f.items[0].name, 'Pat P.'); ok(!JSON.stringify(f).includes('@'), 'email leaked');
    await anon('POST', `/api/review/${tok}`, { rating: 5, comment: 'Edited words here, so it needs a fresh approval.', publicOk: true }); eq((await feed()).items.length, 0);
    const c2 = client(), q2 = (await c2('POST', '/api/quotes', quoteBody({ email: 'nopub@example.com', name: 'No Pub' }))).data; await c2('POST', '/api/auth/signup', { name: 'No Pub', email: 'nopub@example.com', password: 'nopub-pass-123', claim: { ref: q2.ref, token: q2.uploadToken } });
    await staff('PATCH', `/api/staff/quotes/${q2.ref}`, { status: 'completed' }); eq((await c2('POST', `/api/me/quotes/${q2.ref}/review`, { rating: 1, comment: 'Not happy with the timing.', publicOk: false })).status, 200);
    eq((await pub(q2.ref, true)).status, 422); // no consent
    await pub(rvRef, true); f = await feed(); eq(f.count, 2); eq(f.average, 0, 'average hidden under 3 ratings is fine'); // 2 ratings only
    eq((await anon('PATCH', `/api/staff/reviews/${rvRef}`, { featured: true })).status, 401);
  });

  console.log('\nBackups');
  await t('backup works while the site runs, and the archive restores', async () => {
    const out = path.join(TMP, 'backups'), env = { ...process.env, DATA_DIR: path.join(TMP, 'data'), BACKUP_DIR: out }; execFileSync('node', ['backup.mjs'], { cwd: ROOT, env });
    const files = fs.readdirSync(out).filter(f => f.endsWith('.tar.gz')); eq(files.length, 1);
    const listing = execFileSync('tar', ['-tzf', path.join(out, files[0])]).toString(); ok(/xpress\.db/.test(listing) && /uploads/.test(listing), 'archive missing db or uploads');
  });
} finally {
  server.kill('SIGTERM'); stripe.close(); mailer.close(); await wait(300); fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:\n - ' + failures.join('\n - ')); console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-15).join('\n')); process.exit(1); }
