// POST /api/webhooks/telnyx-fill-gap-response
// Telnyx hits this after <Gather>. We parse the caller's answer, book /
// decline accordingly, and return a final TeXML message.
export const config = { api: { bodyParser: false } };

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
      if (yes) {
        farewell = `Amazing — I'll lock in ${gapTime ? 'the ' + fmtHumanTime(gapTime) + ' spot' : 'your spot'} for you and send a text confirmation. See you soon.`;
        bookedText = 'accepted';
        if (attemptId) await c.from('fill_gap_attempts').update({ status: 'accepted', outcome: 'yes', responded_at: new Date().toISOString(), gather_response: speech || digits }).eq('id', attemptId);

        // Attempt to actually book — best-effort. If your booking pipeline
        // accepts a shape like below, this books; otherwise the attempt row
        // is still marked accepted and a human can finish it from the calendar.
        try {
          const { data: attempt } = await c.from('fill_gap_attempts').select('*').eq('id', attemptId).maybeSingle();
          if (attempt && attempt.client_phone) {
            await c.from('appointments').insert({
              tenant_id: attempt.tenant_id,
              start_time: `${attempt.gap_date}T${attempt.gap_start_time}:00`,
              duration_minutes: attempt.gap_duration_minutes,
              status: 'confirmed',
              source: 'lola_voice_fill_gap',
              client_id: attempt.client_id,
              client_name: attempt.client_name,
              client_phone: attempt.client_phone,
              stylist_name: attempt.gap_stylist,
              notes: `Booked via Lola outbound gap-fill call (attempt ${attempt.id})`
            });
            await c.from('fill_gap_attempts').update({ status: 'booked', outcome: 'booked' }).eq('id', attemptId);
          }
        } catch (e) { console.warn('[fill-gap-response] auto-book failed', e?.message); }

        // Fire an SMS confirmation, best-effort
        try {
          const sms = await import('../lib/sms.js').catch(() => null);
          const { data: attempt } = await c.from('fill_gap_attempts').select('client_phone, gap_date, gap_start_time, tenant_id').eq('id', attemptId).maybeSingle();
          const { data: tenant } = attempt ? await c.from('tenants').select('name').eq('id', attempt.tenant_id).maybeSingle() : { data: null };
          if (sms?.sendSms && attempt?.client_phone && tenant) {
            const t = fmtHumanTime(attempt.gap_start_time);
            await sms.sendSms({
              tenant: { id: attempt.tenant_id, name: tenant.name },
              to: attempt.client_phone,
              body: `Confirmed at ${tenant.name}: ${t} today. See you soon!`
            });
          }
        } catch (_) {}
      } else if (no) {
        farewell = `No problem — thanks anyway. I'll ping you next time something opens up.`;
        if (attemptId) await c.from('fill_gap_attempts').update({ status: 'declined', outcome: 'no', responded_at: new Date().toISOString(), gather_response: speech || digits }).eq('id', attemptId);
      } else {
        farewell = `I didn't quite catch that. No worries — I'll text you the details and you can grab it if you want. Talk soon.`;
        if (attemptId) await c.from('fill_gap_attempts').update({ status: 'unclear', outcome: 'unclear', responded_at: new Date().toISOString(), gather_response: speech || digits || '(none)' }).eq('id', attemptId);
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
              tenant: { id: attempt.tenant_id, name: tenant.name },
              to: attempt.client_phone,
              body: `Just called from ${tenant.name}. A ${t} spot's open today — tap to grab it: ${link}`
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
    const fallback = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks. Goodbye.</Say><Hangup/></Response>`;
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
