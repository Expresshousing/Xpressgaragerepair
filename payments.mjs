// Card payments through Stripe Checkout (Stripe's own hosted page: card numbers never touch this server).
// Switches on when STRIPE_SECRET_KEY is set. STRIPE_WEBHOOK_SECRET lets Stripe confirm payments even if the customer closes the tab.
import crypto from 'node:crypto';
const E = process.env;
const BASE = (E.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
export const enabled = () => !!E.STRIPE_SECRET_KEY;
export const webhookEnabled = () => !!E.STRIPE_WEBHOOK_SECRET;
export const describe = () => `stripe ${enabled() ? 'ON' : 'off'}, webhook ${webhookEnabled() ? 'ON' : 'off'}`;

async function call(method, path, params, idem) {
  const res = await fetch(BASE + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${E.STRIPE_SECRET_KEY}`, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Stripe responded ${res.status}`);
  return j;
}

export function createCheckout({ invoice, quote, successUrl, cancelUrl }) {
  return call('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(invoice.amount_cents),
    'line_items[0][price_data][product_data][name]': `${invoice.kind === 'deposit' ? 'Deposit' : 'Payment'}: ${invoice.description || quote.service}`.slice(0, 120),
    'line_items[0][price_data][product_data][description]': `Xpress Garage Doors · request ${quote.ref}`,
    customer_email: quote.email,
    client_reference_id: String(invoice.id),
    'metadata[invoice_id]': String(invoice.id),
    'metadata[quote_ref]': quote.ref,
    'payment_intent_data[description]': `Xpress ${quote.ref} invoice ${invoice.id}`,
    success_url: successUrl, cancel_url: cancelUrl,
  }, `xpress-inv-${invoice.id}-${Date.now()}`);
}
export const getSession = id => call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);

/* Verify a Stripe webhook: header "t=...,v1=..." signs `${t}.${rawBody}` with the webhook secret. */
export function verifyWebhook(raw, header, toleranceSec = 300) {
  if (!E.STRIPE_WEBHOOK_SECRET) throw new Error('Webhook secret not configured');
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
  const t = +parts.t; if (!t || !sigs.length) throw new Error('Bad signature header');
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error('Signature too old');
  const expected = crypto.createHmac('sha256', E.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  if (!sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)))) throw new Error('Signature mismatch');
  return JSON.parse(raw);
}

export const refund = (paymentIntent, cents, idem) => call('POST', '/v1/refunds', { payment_intent: paymentIntent, amount: String(cents) }, idem);
