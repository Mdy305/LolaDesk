import crypto from 'node:crypto';

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

  const payload = rawBody(req);
  if (!verifyTelnyxSignature(req, payload)) {
    return res.status(401).json({ error: 'Invalid Telnyx webhook signature' });
  }

  let event;
  try { event = JSON.parse(payload); }
  catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }

  const summary = summarize(event);
  console.log('[TELNYX_WEBHOOK]', JSON.stringify(summary));

  // Acknowledge immediately. Durable persistence can subscribe to this stable
  // summary contract without coupling the webhook to a specific DB schema.
  return res.status(200).json({ received: true, event_id: summary.event_id, event_type: summary.event_type });
}
