import crypto from 'node:crypto';
import { readRawBody } from './lib/telnyx-webhook-verify.js';

// Signatures cover the exact bytes: read them raw.
export const config = { api: { bodyParser: false } };

function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body || {});
}

function verifyTelnyxSignature(req, payload) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) return process.env.NODE_ENV !== 'production';

  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!signature || !timestamp) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const message = Buffer.from(`${timestamp}|${payload}`);
  const signatureBytes = Buffer.from(String(signature), 'base64');
  const key = publicKey.includes('BEGIN PUBLIC KEY')
    ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;

  try {
    return crypto.verify(null, message, key, signatureBytes);
  } catch {
    return false;
  }
}

function summarize(event) {
  const data = event?.data || {};
  const payload = data.payload || {};
  return {
    event_id: data.id || null,
    event_type: data.event_type || null,
    occurred_at: data.occurred_at || null,
    record_type: data.record_type || null,
    customer_reference: payload.customer_reference || null,
    porting_order_id: payload.porting_order_id || payload.id || null,
    status: payload.status || payload.new_status || null,
    phone_numbers: payload.phone_numbers || null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const payload = await readRawBody(req);
  if (!verifyTelnyxSignature(req, payload)) {
    return res.status(401).json({ error: 'Invalid Telnyx webhook signature' });
  }

  let event;
  try { event = JSON.parse(payload); }
  catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }

  const summary = summarize(event);
  console.log('[TELNYX_WEBHOOK]', JSON.stringify(summary));

  // Porting (porting_order.*) and 10DLC brand/campaign events move the salon's setup forward
  // (lib/setup/telecom.js re-reads the order/campaign from Telnyx; the payload only names it).
  // Telnyx wants a 2xx within ~2s: wait briefly, then acknowledge — the work finishes in the
  // background and the telecom-sync cron catches anything missed.
  const work = import('./lib/setup/telecom.js').then((m) => m.handleTelecomEvent(event)).catch((e) => ({ handled: false, error: String(e?.message || e).slice(0, 160) }));
  let timer = null;
  const outcome = await Promise.race([work, new Promise((r) => { timer = setTimeout(() => r({ handled: 'pending' }), Number(process.env.TELECOM_WEBHOOK_WAIT_MS ?? 1500)); })]);
  clearTimeout(timer);

  return res.status(200).json({ received: true, event_id: summary.event_id, event_type: summary.event_type, handled: outcome?.handled ?? false });
}
