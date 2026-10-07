// POST /api/webhooks/telnyx-recording
// Stores the real audio link of a call recording on calls.recording_audio_url.
// Accepts both Telnyx shapes:
//   · TeXML RecordingStatusCallback (form-encoded: CallSid, RecordingUrl, RecordingStatus)
//   · Call Control event `call.recording.saved` (JSON: data.payload.call_control_id, recording_urls.mp3)
import { db } from '../lib/db.js';
import { recordingKeyOk } from '../lib/callback-sign.js';
import { verifyTelnyxSignature } from '../lib/telnyx-webhook-verify.js';

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', ch => { d += ch; }); req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method_not_allowed');
  try {
    const raw = await readRaw(req);
    // Signed only: the k=… LolaDesk puts on this URL (api/lib/callback-sign.js recordingCallbackUrl), or a
    // valid Telnyx ed25519 signature (TELNYX_PUBLIC_KEY; outside production, permissive when unset).
    const q = req.query || {};
    const h = req.headers || {};
    const signed = recordingKeyOk(q.k) || (!q.k && (!!h['telnyx-signature-ed25519'] || !process.env.TELNYX_PUBLIC_KEY) && verifyTelnyxSignature(req, raw));
    if (!signed) return res.status(401).send('unauthorized');
    let callId = null, url = null, status = 'completed';
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) {
      const j = JSON.parse(raw || '{}');
      const p = j?.data?.payload || {};
      if (j?.data?.event_type && j.data.event_type !== 'call.recording.saved') return res.status(200).send('ignored');
      callId = p.call_control_id || null;
      url = p.recording_urls?.mp3 || p.public_recording_urls?.mp3 || p.recording_urls?.wav || null;
    } else {
      const f = new URLSearchParams(raw);
      callId = f.get('CallSid') || f.get('CallControlId') || null;
      url = f.get('RecordingUrl') || null;
      status = (f.get('RecordingStatus') || 'completed').toLowerCase();
    }
    if (!callId || !url || status !== 'completed') return res.status(200).send('ignored');
    // This webhook is unsigned (TeXML callbacks): never store anything but a plain https link, so a
    // forged callback can't plant a javascript:/data: link in a salon's call log.
    try { if (new URL(url).protocol !== 'https:') return res.status(200).send('ignored'); } catch { return res.status(200).send('ignored'); }
    const c = db();
    if (c) {
      // Set once: a later (replayed) callback never replaces a stored recording link.
      const { error } = await c.from('calls').update({ recording_audio_url: url }).eq('telnyx_call_control_id', callId).is('recording_audio_url', null);
      if (error) console.warn('[telnyx-recording] update failed:', error.message);
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error('[telnyx-recording]', e?.message);
    return res.status(200).send('error-logged');
  }
}
