/**
 * POST /api/square-webhook — Square tells LolaDesk the moment something changes in a salon's Square:
 * a booking made, moved or cancelled; a salon disconnecting LolaDesk; the menu or team changing.
 *
 * Every request must carry Square's signature (x-square-hmacsha256-signature): base64 HMAC-SHA256 of
 * the notification URL + the exact raw body, keyed with the subscription's signature key
 * (SQUARE_WEBHOOK_SIGNATURE_KEY; the URL is SQUARE_WEBHOOK_URL or APP_URL/api/square-webhook).
 * Unsigned or wrongly signed → 403, nothing done. Signed → 200 at once, the work right after.
 */
import { db } from './lib/db.js';

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (!req || typeof req.on !== 'function' || req.readableEnded) return typeof req.body === 'string' ? req.body : null;
  return new Promise((resolve) => {
    const chunks = []; let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', finish); req.on('error', finish);
  });
}

export const webhookUrl = () => process.env.SQUARE_WEBHOOK_URL || `${(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, '')}/api/square-webhook`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'SQUARE_WEBHOOK_SIGNATURE_KEY is not set' });
  const raw = await readRaw(req);
  const sig = req.headers?.['x-square-hmacsha256-signature'] || req.headers?.['X-Square-HmacSha256-Signature'];
  const { verifyWebhook } = await import('./lib/connectors/square.js');
  if (raw == null || !(await verifyWebhook(raw, sig, { url: webhookUrl(), key }))) return res.status(403).json({ ok: false, error: 'invalid signature' });
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch (_) { return res.status(400).json({ ok: false, error: 'bad json' }); }
  // Answer Square right away (it retries slow answers); do the work after.
  res.status(200).json({ ok: true });
  const work = (async () => { const { handleSquareEvent } = await import('./lib/square-care.js'); return handleSquareEvent(db(), ev); })().catch((e) => console.error('[square-webhook]', e?.message || e));
  try { const { afterResponse } = await import('./lib/booking-outbox.js'); afterResponse(work); } catch (_) {}
  await work;
}
