// Alerts: tell staff the moment something needs them, and keep customers informed.
// Every channel switches on by itself when its settings exist; a failed alert never blocks a customer.
//   Staff:     email (Resend), text (Twilio), webhook (Slack/Zapier/Discord)
//   Customers: email (Resend) for confirmations, quote/appointment updates, chat replies
const E = process.env;
const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE = (E.SITE_URL || 'http://localhost:' + (E.PORT || 4190)).replace(/\/$/, '');

export const channels = () => ({
  staffEmail: !!(E.RESEND_API_KEY && E.ALERT_EMAIL_FROM && list(E.ALERT_EMAIL_TO).length),
  customerEmail: !!(E.RESEND_API_KEY && E.ALERT_EMAIL_FROM && E.CUSTOMER_EMAILS !== 'off'),
  sms: !!(E.TWILIO_SID && E.TWILIO_TOKEN && E.TWILIO_FROM && list(E.ALERT_SMS_TO).length),
  webhook: !!E.ALERT_WEBHOOK_URL,
});
export const describe = () => Object.entries(channels()).map(([k, v]) => `${k} ${v ? 'ON' : 'off'}`).join(', ');

async function post(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
}
const sendEmail = (to, subject, html, text, headers) => post(E.RESEND_URL || 'https://api.resend.com/emails', {
  method: 'POST', headers: { authorization: `Bearer ${E.RESEND_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ from: E.ALERT_EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html, text, ...(E.ALERT_REPLY_TO ? { reply_to: E.ALERT_REPLY_TO } : {}), ...(headers ? { headers } : {}) }),
});
const sendSms = (to, text) => post(`${E.TWILIO_URL || 'https://api.twilio.com'}/2010-04-01/Accounts/${E.TWILIO_SID}/Messages.json`, {
  method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${E.TWILIO_SID}:${E.TWILIO_TOKEN}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ To: to, From: E.TWILIO_FROM, Body: text.slice(0, 600) }),
});
const sendHook = (text, data) => post(E.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text, ...data }) });

const log = (jobs, what) => Promise.allSettled(jobs).then(r => r.forEach(o => { if (o.status === 'rejected') console.error(`ALERT FAILED (${what}):`, o.reason?.message || o.reason); }));
const shell = (title, body, button, unsub) => `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;color:#111"><h2 style="margin:0 0 12px">${esc(title)}</h2>${body}${button ? `<p style="margin-top:22px"><a href="${esc(button[1])}" style="background:#ef4b00;color:#fff;padding:12px 22px;border-radius:30px;text-decoration:none;font-weight:bold">${esc(button[0])}</a></p>` : ''}<p style="color:#777;font-size:12px;margin-top:28px">Xpress Garage Doors · 1807 Easton Rd, Willow Grove, PA · 215-397-1926${unsub ? ` · <a href="${esc(unsub)}" style="color:#777">Unsubscribe</a>` : ''}</p></div>`;

/* ---- to staff ---- */
async function toStaff(subject, text, html, data) {
  const c = channels(), jobs = [];
  if (c.staffEmail) jobs.push(sendEmail(list(E.ALERT_EMAIL_TO), subject, html, text));
  if (c.sms) for (const to of list(E.ALERT_SMS_TO)) jobs.push(sendSms(to, `${subject}\n${text}`.slice(0, 600)));
  if (c.webhook) jobs.push(sendHook(`${subject}\n${text}`, data));
  await log(jobs, 'staff');
}
const adminUrl = SITE + '/admin/';

export function newQuote(q) {
  const subject = `${q.urgent ? 'URGENT ' : ''}New quote ${q.ref}: ${q.service} in ${q.city}${q.state ? ', ' + q.state : ''}`;
  const text = `${q.name} · ${q.phone} · ${q.email}\n${q.message || ''}\n${q.slot_label ? 'Wants: ' + q.slot_label : 'Prefers: ' + (q.pref_date || 'any date') + ' ' + (q.pref_time || '')}\n${adminUrl}`;
  const html = shell(subject, `<p><b>${esc(q.name)}</b><br>${esc(q.phone)} · ${esc(q.email)}</p><p>${esc(q.message)}</p><p style="color:#555">${q.slot_label ? '<b>Wants: ' + esc(q.slot_label) + '</b>' : 'Prefers: ' + esc(q.pref_date || 'any date') + ' ' + esc(q.pref_time || '')}</p>`, ['Open dashboard', adminUrl]);
  return toStaff(subject, text, html, { type: 'quote', quote: q });
}
export function newChat(conv, firstMessage) {
  const subject = `New chat from ${conv.name} (${conv.topic})`, text = `${conv.email}\n"${firstMessage}"\nReply: ${adminUrl}`;
  return toStaff(subject, text, shell(subject, `<p>${esc(conv.email)}</p><blockquote style="border-left:3px solid #ef4b00;margin:0;padding-left:12px">${esc(firstMessage)}</blockquote>`, ['Reply in dashboard', adminUrl]), { type: 'chat', conversation: conv.id });
}
/* more messages in an existing chat: at most one alert per conversation per 5 minutes */
const lastPing = new Map();
export function chatMessage(conv, message) {
  const t = Date.now(); if (t - (lastPing.get(conv.id) || 0) < 300e3) return Promise.resolve(); lastPing.set(conv.id, t);
  const subject = `${conv.name} replied in chat`, text = `"${message}"\n${adminUrl}`;
  return toStaff(subject, text, shell(subject, `<blockquote style="border-left:3px solid #ef4b00;margin:0;padding-left:12px">${esc(message)}</blockquote>`, ['Reply in dashboard', adminUrl]), { type: 'chat-message', conversation: conv.id });
}

/* ---- to customers (email only) ---- */
async function toCustomer(to, subject, html, text, headers) {
  if (!channels().customerEmail || !to) return;
  await log([sendEmail(to, subject, html, text, headers)], 'customer');
}
export function quoteReceived(q, hasAccount) {
  const link = SITE + '/account/?mode=' + (hasAccount ? 'login' : 'signup') + '&email=' + encodeURIComponent(q.email);
  return toCustomer(q.email, `We got your request (${q.ref})`, shell('Thanks, we got your request', `<p>Hi ${esc(q.name.split(' ')[0])}, our team is reviewing your <b>${esc(q.service)}</b> request for ${esc(q.city)} and will get back to you with a clear quote.</p>${q.slot_label ? `<p>Requested time: <b>${esc(q.slot_label)}</b> (we will confirm it)</p>` : ''}<p>Your reference: <b>${esc(q.ref)}</b></p><p>${hasAccount ? 'Sign in' : 'Create a free account'} to track it and message our team. For an emergency call 215-397-1926 any time.</p>`, [hasAccount ? 'Sign in to my account' : 'Create my account', link]), `Thanks, we got your request ${q.ref}. ${link}`);
}
export function quoteUpdated(q, label) {
  const link = SITE + '/account/?mode=login&email=' + encodeURIComponent(q.email);
  const extra = [q.quote_amount && `<p style="font-size:22px"><b>${esc(q.quote_amount)}</b></p>`, q.scheduled_for && `<p>Appointment: <b>${esc(q.scheduled_for)}</b></p>`].filter(Boolean).join('');
  return toCustomer(q.email, `${label}: ${q.ref}`, shell(label, `<p>Update on your <b>${esc(q.service)}</b> request (${esc(q.ref)}).</p>${extra}`, ['View in my account', link]), `${label}. ${link}`);
}
/* staff replied but the customer may have left the page: email at most once per 15 min per chat */
const lastMail = new Map();
export function staffReplied(conv, message) {
  const t = Date.now(); if (t - (lastMail.get(conv.id) || 0) < 900e3) return Promise.resolve(); lastMail.set(conv.id, t);
  const link = SITE + '/account/';
  return toCustomer(conv.email, 'Xpress replied to your message', shell('We replied to your message', `<blockquote style="border-left:3px solid #ef4b00;margin:0;padding-left:12px">${esc(message)}</blockquote><p>Open the chat on our website to continue the conversation.</p>`, ['Open Xpress', link]), `Xpress replied: ${message}`);
}

/* password reset: sent whenever email is set up, even if CUSTOMER_EMAILS=off (the customer asked for it) */
export async function passwordReset(customer, link) {
  const c = channels(); if (!(E.RESEND_API_KEY && E.ALERT_EMAIL_FROM)) return;
  await log([sendEmail(customer.email, 'Reset your Xpress password', shell('Reset your password', `<p>Hi ${esc(customer.name.split(' ')[0])}, we got a request to reset your Xpress account password. This link works for 1 hour.</p><p style="color:#555">If you didn't ask for this, you can ignore this email; your password won't change.</p>`, ['Choose a new password', link]), `Reset your Xpress password (valid 1 hour): ${link}\nIf you didn't ask for this, ignore this email.`)], 'password reset');
}

export function rescheduled(q) {
  const subject = `${q.name} asked to reschedule ${q.ref}`, text = `New time requested: ${q.slot_label}\n${adminUrl}`;
  return toStaff(subject, text, shell(subject, `<p>New time requested: <b>${esc(q.slot_label)}</b></p><p>Status moved back to "reviewing" so you can confirm it.</p>`, ['Open dashboard', adminUrl]), { type: 'reschedule', quote: q.ref });
}
export function appointmentReminder(q) {
  const link = SITE + '/account/?mode=login&email=' + encodeURIComponent(q.email);
  return toCustomer(q.email, `Reminder: your Xpress appointment tomorrow (${q.slot_window})`, shell('See you tomorrow', `<p>Hi ${esc(q.name.split(' ')[0])}, this is a reminder of your <b>${esc(q.service)}</b> appointment: <b>${esc(q.slot_label)}</b>.</p><p>Your technician will call before arriving. Please make sure someone 18+ can be there and the area around the door is clear. Need to change it? Reschedule in your account or call 215-397-1926.</p>`, ['Manage appointment', link]), `Reminder: ${q.slot_label}. ${link}`);
}

export function photosAdded(q, n) {
  const subject = `${n} photo${n === 1 ? '' : 's'} on quote ${q.ref}`, text = `${q.name} added photos to ${q.ref} (${q.service}).\n${adminUrl}`;
  return toStaff(subject, text, shell(subject, `<p><b>${esc(q.name)}</b> added photos to <b>${esc(q.ref)}</b> (${esc(q.service)}). Open the quote to review them before you price it.</p>`, ['Open dashboard', adminUrl]), { type: 'photos', quote: q.ref, count: n });
}

export function invoiceCreated(q, inv) {
  const link = SITE + '/account/?mode=login&email=' + encodeURIComponent(q.email), what = inv.kind === 'deposit' ? 'deposit' : 'payment';
  return toCustomer(q.email, `Your ${what} request: ${inv.amount} (${q.ref})`, shell(`A ${what} is ready`, `<p>Hi ${esc(q.name.split(' ')[0])}, your <b>${esc(q.service)}</b> request has a ${what} of <b style="font-size:20px">${esc(inv.amount)}</b>${inv.description ? ' for ' + esc(inv.description) : ''}.</p>${inv.dueDate ? `<p>Due: <b>${esc(inv.dueDate)}</b></p>` : ''}<p>You can pay securely by card from your account, or pay your technician on the day.</p>`, ['Pay now', link]), `A ${what} of ${inv.amount} is ready. ${link}`);
}
export async function paymentReceived(q, inv) {
  const subject = `Payment received: ${inv.amount} on ${q.ref}`, text = `${q.name} paid ${inv.amount} (${inv.kind}, ${inv.method}).\n${adminUrl}`;
  await Promise.allSettled([
    toStaff(subject, text, shell(subject, `<p><b>${esc(q.name)}</b> paid <b>${esc(inv.amount)}</b> (${esc(inv.kind)}, ${esc(inv.method)}) on ${esc(q.ref)} · ${esc(q.service)}.</p>`, ['Open dashboard', adminUrl]), { type: 'payment', quote: q.ref, amount: inv.amount }),
    toCustomer(q.email, `Payment received: ${inv.amount}`, shell('Thank you, payment received', `<p>We received your <b>${esc(inv.amount)}</b> ${esc(inv.kind)} for <b>${esc(q.service)}</b> (${esc(q.ref)}).</p><p>Keep this email as your receipt. Questions? Reply here or call 215-397-1926.</p>`, ['View my account', SITE + '/account/']), `Payment received: ${inv.amount} for ${q.ref}.`),
  ]);
}

export function planCreated(q, list) {
  const link = SITE + '/account/?mode=login&email=' + encodeURIComponent(q.email), total = list.reduce((a, i) => a + i.amountCents, 0);
  const rows = list.map((i, k) => `<tr><td style="padding:6px 0">${k + 1}. ${esc(i.dueDate || '')}</td><td style="text-align:right"><b>${esc(i.amount)}</b></td></tr>`).join('');
  return toCustomer(q.email, `Your payment plan (${q.ref})`, shell('Your payment plan', `<p>Hi ${esc(q.name.split(' ')[0])}, we set up a payment plan of <b>$${(total / 100).toFixed(2)}</b> for your <b>${esc(q.service)}</b> in ${list.length} installments:</p><table style="width:100%;border-collapse:collapse">${rows}</table><p>Pay each one securely from your account. We'll send a reminder before each is due.</p>`, ['Open my account', link]), `Payment plan set up for ${q.ref}. ${link}`);
}
export function invoiceReminder(q, inv, stage, hasDue) {
  const link = SITE + '/account/?mode=login&email=' + encodeURIComponent(q.email);
  const subject = stage >= (hasDue ? 3 : 2) ? `Payment overdue: ${inv.amount} (${q.ref})` : stage === 2 && hasDue ? `Payment due today: ${inv.amount}` : `Reminder: ${inv.amount} ${hasDue ? 'due ' + inv.dueDate : 'is ready to pay'}`;
  return toCustomer(q.email, subject, shell(subject, `<p>Hi ${esc(q.name.split(' ')[0])}, a friendly reminder about your <b>${esc(q.service)}</b> ${esc(inv.kind)} of <b>${esc(inv.amount)}</b>${hasDue ? ` (due ${esc(inv.dueDate)})` : ''}.</p><p>Already paid, or paying your technician in person? Just reply or call 215-397-1926 and we'll update it.</p>`, ['Pay now', link]), `${subject}. ${link}`);
}
export async function refundIssued(q, inv, amountText) {
  const subject = `Refund issued: ${amountText} on ${q.ref}`;
  await Promise.allSettled([
    toStaff(subject, `${q.name}: ${amountText} refunded (${inv.method}).\n${adminUrl}`, shell(subject, `<p>${esc(amountText)} refunded to <b>${esc(q.name)}</b> (${esc(inv.method)}) on ${esc(q.ref)}.</p>`, ['Open dashboard', adminUrl]), { type: 'refund', quote: q.ref, amount: amountText }),
    toCustomer(q.email, `Your refund: ${amountText}`, shell('Your refund is on its way', `<p>We refunded <b>${esc(amountText)}</b> on your ${esc(q.service)} (${esc(q.ref)}).${inv.method === 'card' ? ' Card refunds usually appear within 5 to 10 business days.' : ''}</p>`, ['View my account', SITE + '/account/']), `Refund issued: ${amountText}`),
  ]);
}

const unsubHeaders = u => { const one = u.replace('/unsubscribe/?t=', '/api/unsubscribe?t='); return { 'List-Unsubscribe': `<${one}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }; };
export function reviewRequest(q, link, isReminder, unsub) {
  const first = esc(q.name.split(' ')[0]);
  const subject = isReminder ? 'Quick favor? How did we do?' : `How did we do, ${q.name.split(' ')[0]}?`;
  return toCustomer(q.email, subject, shell(isReminder ? 'One quick favor' : 'How did we do?', `<p>Hi ${first}, thank you for choosing Xpress Garage Doors for your <b>${esc(q.service)}</b>. Your honest feedback takes 20 seconds and helps us improve and helps your neighbors choose.</p><p>Tap a star rating:</p><p style="font-size:30px;letter-spacing:6px;margin:6px 0"><a href="${esc(link)}" style="text-decoration:none;color:#ef4b00">★★★★★</a></p>`, ['Rate your service', link], unsub), `How did we do? Rate your service: ${link}`, unsubHeaders(unsub));
}
export async function reviewReceived(q, rating, comment) {
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating), low = rating <= 3;
  const subject = `${low ? 'UNHAPPY CUSTOMER ' : ''}${stars} from ${q.name} (${q.ref})`, text = `${comment ? '"' + comment + '"\n' : ''}${q.service} in ${q.city}\n${adminUrl}`;
  await toStaff(subject, text, shell(subject, `<p style="font-size:26px;color:${low ? '#b3261e' : '#ef4b00'}">${stars}</p>${comment ? `<blockquote style="border-left:3px solid #ef4b00;margin:0;padding-left:12px">${esc(comment)}</blockquote>` : '<p>(no comment)</p>'}<p>${esc(q.name)} · ${esc(q.service)} · ${esc(q.city)}</p>${low ? '<p><b>Please reach out today and make it right.</b></p>' : ''}`, ['Open dashboard', adminUrl]), { type: 'review', quote: q.ref, rating });
}
export function maintenanceReminder(q, link, unsub) {
  return toCustomer(q.email, 'Time for your garage door check-up', shell('Your yearly check-up is due', `<p>Hi ${esc(q.name.split(' ')[0])}, it's been about a year since we worked on your garage door (<b>${esc(q.service)}</b>). A quick yearly check of springs, cables, rollers and safety sensors helps prevent the breakdowns that always happen at the worst time.</p><p>Same-day appointments are often available.</p>`, ['Book a check-up', link], unsub), `Time for your yearly garage door check-up: ${link}`, unsubHeaders(unsub));
}

export function verifyEmail(c, link) {
  return toCustomer(c.email, 'Confirm your email for your Xpress account', shell('Confirm your email', `<p>Hi ${esc(c.name.split(' ')[0])}, please confirm this email address to finish setting up your Xpress account. Once confirmed, your earlier requests and messages appear in your account.</p><p style="color:#555">If you didn't create an account, you can ignore this email.</p>`, ['Confirm my email', link]), `Confirm your email: ${link}`);
}
export function duplicatePayment(q, inv, pi) {
  const subject = `ACTION: duplicate payment on ${q.ref} (${inv.amount})`, text = `${q.name} was charged twice for invoice #${inv.id}. Refund the extra charge (${pi}) in Stripe.\n${adminUrl}`;
  return toStaff(subject, text, shell(subject, `<p><b>${esc(q.name)}</b> was charged twice for ${esc(inv.amount)} on ${esc(q.ref)}.</p><p>Please refund the extra payment <code>${esc(pi)}</code> in your Stripe dashboard.</p>`, ['Open dashboard', adminUrl]), { type: 'duplicate-payment', quote: q.ref });
}
