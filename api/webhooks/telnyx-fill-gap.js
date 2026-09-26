// POST or GET /api/webhooks/telnyx-fill-gap
// Telnyx TeXML application hits this when the client answers. We return
// TeXML that plays Lola's pitch (ElevenLabs voice via api/speak-lola if
// available, otherwise a <Say>) and gathers a yes/no response.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const attemptId = q.attempt_id || '';
    const tenantId  = q.tenant_id || '';
    const name      = firstName(q.name || 'there');
    const service   = String(q.service || '').trim();
    const gapTime   = fmtHumanTime(q.gap_time || '');
    const salon     = String(q.salon || 'the salon').trim();

    const base = process.env.APP_URL || 'https://www.loladesk.com';
    const responseUrl = `${base}/api/webhooks/telnyx-fill-gap-response?attempt_id=${encodeURIComponent(attemptId)}&tenant_id=${encodeURIComponent(tenantId)}&name=${encodeURIComponent(q.name || '')}&gap_date=${encodeURIComponent(q.gap_date || '')}&gap_time=${encodeURIComponent(q.gap_time || '')}`;

    const svcLine = service ? ` for ${service}` : '';
    const pitch = `Hi ${name}, it's Lola from ${salon}. A ${gapTime} spot just opened up today${svcLine}. If you'd like it, say yes after the beep. Otherwise, just say no problem and we'll catch you next time.`;

    // Prefer ElevenLabs playback if we can generate a Play URL; fall back to Polly.Joanna if not.
    let playUrl = null;
    try {
      const speakUrl = `${base}/api/speak-lola?text=${encodeURIComponent(pitch)}`;
      // Just point Telnyx at the URL — Telnyx will fetch and stream it.
      playUrl = speakUrl;
    } catch (_) { playUrl = null; }

    // Rolling attempt log — the caller picked up
    try {
      const { db: dbFn } = await import('../lib/db.js');
      if (attemptId) await dbFn().from('fill_gap_attempts').update({ status: 'answered', answered_at: new Date().toISOString() }).eq('id', attemptId);
    } catch (_) {}

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : `<Say voice="Polly.Joanna">${escapeXml(pitch)}</Say>`}
  <Gather input="speech dtmf" numDigits="1" timeout="6" speechTimeout="auto" action="${escapeXml(responseUrl)}" method="POST" hints="yes,yeah,sure,ok,book,book me,no,pass,not today,nope">
    ${playUrl ? '' : `<Say voice="Polly.Joanna">Say yes or press one to grab it, or say no to skip.</Say>`}
  </Gather>
  <Say voice="Polly.Joanna">Didn't catch that — no worries, I'll try again next time. Bye for now.</Say>
</Response>`;

    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(xml);
  } catch (e) {
    console.error('[fill-gap webhook]', e?.message);
    const fallback = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Goodbye.</Say></Response>`;
    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(fallback);
  }
}

function firstName(s) { return String(s || '').trim().split(/\s+/)[0] || 'there'; }
function fmtHumanTime(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return String(hhmm || '');
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}
function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
}
