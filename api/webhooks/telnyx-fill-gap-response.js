// POST /api/webhooks/telnyx-fill-gap-response
// Telnyx hits this after <Gather>. We parse the caller's answer, book /
// decline accordingly, and return a final TeXML message.
export const config = { api: { bodyParser: false } };
import { fillGapKeyOk } from '../lib/callback-sign.js';
import { verifyTelnyxSignature } from '../lib/telnyx-webhook-verify.js';

// Statuses an attempt can still be answered from. Every outcome below CLAIMS the attempt with a
// conditional update (status still open → new status) first, so a replayed or doubled Gather
// callback can never book the same gap twice.
const OPEN = ['pending', 'ringing', 'answered'];
const hangup = (res) => { res.setHeader('Content-Type', 'application/xml'); return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'); };

/**
 * Is this callback from a call LolaDesk placed? The per-attempt k=… (api/lib/callback-sign.js), or a
 * valid Telnyx signature. Until the TeXML script forwards k= on its Gather action
 * (api/webhooks/telnyx-fill-gap.js), an unsigned callback is still accepted unless
 * FILL_GAP_REQUIRE_SIG=1 — it can only act once per attempt (OPEN claim below).
 */
export function fillGapCallbackAllowed(req, attemptId, rawBody) {
  const q = req.query || {};
  if (q.k) return fillGapKeyOk(attemptId, q.k);
  const h = req.headers || {};
  if (h['telnyx-signature-ed25519'] && process.env.TELNYX_PUBLIC_KEY) return verifyTelnyxSignature(req, rawBody);
  return process.env.FILL_GAP_REQUIRE_SIG !== '1';
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function parseForm(body) {
  const out = {};
  for (const pair of String(body || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const attemptId = q.attempt_id || '';
    const tenantId  = q.tenant_id || '';
    const clientName = String(q.name || '').trim();
    const gapDate   = q.gap_date || '';
    const gapTime   = q.gap_time || '';

    let body = '';
    try { body = await readBody(req); } catch (_) {}
    if (!attemptId || !fillGapCallbackAllowed(req, attemptId, body)) return hangup(res);
    const form = parseForm(body);
    const speech = String(form.SpeechResult || '').toLowerCase().trim();
    const digits = String(form.Digits || '').trim();

    const yes = /^\s*(y|yes|yeah|yep|sure|ok(ay)?|book( me)?|i'?ll take it|please|absolutely)\b/i.test(speech) || digits === '1';
    const no  = /^\s*(n|no|nope|not|pass|maybe next time|another time)\b/i.test(speech) || digits === '2';

    // Log outcome
    let farewell = `Thanks for picking up, ${firstName(clientName) || 'there'}. Have a great day.`;
    let bookedText = '';
    try {
      const { db: dbFn } = await import('../lib/db.js');
      const c = dbFn();
      // Claim the attempt (one outcome per call). Already handled → just say goodbye, do nothing.
      const claimStatus = yes ? 'accepted' : no ? 'declined' : 'unclear';
      const { data: claimed } = await c.from('fill_gap_attempts')
        .update({ status: claimStatus, outcome: yes ? 'yes' : no ? 'no' : 'unclear', responded_at: new Date().toISOString(), gather_response: speech || digits || '(none)' })
        .eq('id', attemptId).in('status', OPEN).select('id');
      if (!Array.isArray(claimed) || !claimed.length) return hangup(res);
      if (yes) {
        farewell = `Amazing — I'll lock in ${gapTime ? 'the ' + fmtHumanTime(gapTime) + ' spot' : 'your spot'} for you and send a text confirmation. See you soon.`;
        bookedText = 'accepted';

        // Book it through the canonical engine (same path as every booking):
        // createCanonicalBooking writes `bookings`, logs history, and sends
        // the salon's standard confirmation text + deposit request.
        let booked = false;
        try {
          const { data: attempt } = await c.from('fill_gap_attempts').select('*').eq('id', attemptId).maybeSingle();
          if (attempt && attempt.client_phone) {
            const { getBookingSettings } = await import('../lib/booking-repository.js');
            const { bookGapFillSlot } = await import('../lib/gap-fill-booking.js');
            const { zonedLocalToUtc } = await import('../lib/timezone.js');
            const { upsertClient, e164 } = await import('../lib/db.js');
            const settings = await getBookingSettings(attempt.tenant_id);
            const tz = settings?.timezone || 'America/New_York';
            const hhmm = String(attempt.gap_start_time || '').slice(0, 5);
            const startIso = zonedLocalToUtc(String(attempt.gap_date).slice(0, 10), `${hhmm}:00`, tz);
            let clientId = attempt.client_id || null;
            if (!clientId) {
              // Find the existing client by phone first — never rename a known client.
              const { data: ex } = await c.from('clients').select('id')
                .eq('tenant_id', attempt.tenant_id).eq('phone', e164(attempt.client_phone)).maybeSingle();
              clientId = ex?.id || null;
            }
            if (!clientId) {
              const cl = await upsertClient(attempt.tenant_id, { phone: attempt.client_phone, name: attempt.client_name || 'Client' });
              clientId = cl?.id || null;
            }
            if (clientId) {
              // Several clients may say yes to the same gap: the atomic hold lets exactly one win.
              const got = await bookGapFillSlot({
                tenantId: attempt.tenant_id, clientId, startsAt: startIso,
                durationMin: attempt.gap_duration_minutes || 60, stylist: attempt.gap_stylist || null,
                source: 'lola_gap_fill',
                notes: `Booked by Lola on an outbound gap-fill call${attempt.gap_stylist ? ' · requested ' + attempt.gap_stylist : ''}`,
              });
              if (!got.ok && got.taken) {
                booked = true; // nothing to text: they're told on the call
                farewell = `Oh — someone just grabbed that spot a moment ago, I'm so sorry. I'll put you first in line for the next opening.`;
                await c.from('fill_gap_attempts').update({ status: 'taken', outcome: 'taken' }).eq('id', attemptId);
                try { const { addToWaitlist } = await import('../lib/booking-repository.js'); await addToWaitlist?.({ tenantId: attempt.tenant_id, clientId, preferredDate: String(attempt.gap_date).slice(0, 10), notes: 'Said yes to a gap that was already taken' }); } catch (_) {}
              }
              if (got.ok) booked = !!got.booking?.id;
              if (got.ok) await c.from('fill_gap_attempts').update({ status: 'booked', outcome: 'booked' }).eq('id', attemptId);
              if (got.ok && attempt.waitlist_id) {
                try { await c.from('booking_waitlist').update({ status: 'fulfilled', updated_at: new Date().toISOString() }).eq('id', attempt.waitlist_id); } catch (_) {}
              }
            }
          }
        } catch (e) { console.warn('[fill-gap-response] auto-book failed', e?.message); }

        // Only text separately if the canonical booking didn't (it sends its own confirmation).
        if (!booked) {
          try {
            const sms = await import('../lib/sms.js').catch(() => null);
            const { data: attempt } = await c.from('fill_gap_attempts').select('client_phone, gap_date, gap_start_time, tenant_id').eq('id', attemptId).maybeSingle();
            const { data: tenant } = attempt ? await c.from('tenants').select('id, name').eq('id', attempt.tenant_id).maybeSingle() : { data: null };
            if (sms?.sendSms && attempt?.client_phone && tenant) {
              await sms.sendSms({
                tenantId: tenant.id,
                to: attempt.client_phone,
                text: `Thanks for saying yes to ${fmtHumanTime(attempt.gap_start_time)} at ${tenant.name}! We're confirming it now and will text you shortly.`
              });
            }
          } catch (_) {}
        }
      } else if (no) {
        farewell = `No problem — thanks anyway. I'll ping you next time something opens up.`;
      } else {
        farewell = `I didn't quite catch that. No worries — I'll text you the details and you can grab it if you want. Talk soon.`;
        // Fallback SMS with the offer since voice was inconclusive
        try {
          const sms = await import('../lib/sms.js').catch(() => null);
          const { data: attempt } = await c.from('fill_gap_attempts').select('*').eq('id', attemptId).maybeSingle();
          const { data: tenant } = attempt ? await c.from('tenants').select('name').eq('id', attempt.tenant_id).maybeSingle() : { data: null };
          if (sms?.sendSms && attempt && tenant) {
            const t = fmtHumanTime(attempt.gap_start_time);
            const base = process.env.APP_URL || 'https://www.loladesk.com';
            const link = `${base}/book?t=${encodeURIComponent(attempt.tenant_id)}&d=${attempt.gap_date}&s=${encodeURIComponent(attempt.gap_start_time)}`;
            await sms.sendSms({
              tenantId: attempt.tenant_id,
              to: attempt.client_phone,
              text: `Just called from ${tenant.name}. A ${t} spot's open — tap to grab it: ${link}`
            });
          }
        } catch (_) {}
      }
    } catch (e) { console.warn('[fill-gap-response] outcome logging failed', e?.message); }

    // Return farewell TeXML — use ElevenLabs playback if reachable
    const base = process.env.APP_URL || 'https://www.loladesk.com';
    const playUrl = `${base}/api/speak-lola?text=${encodeURIComponent(farewell)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(playUrl)}</Play>
  <Hangup/>
</Response>`;
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  } catch (e) {
    console.error('[fill-gap-response]', e?.message);
    const fallback = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(fallback);
  }
}

function firstName(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }
function fmtHumanTime(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return String(hhmm || '');
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}
function escapeXml(s) { return String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
