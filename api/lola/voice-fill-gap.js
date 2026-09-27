// POST /api/lola/voice-fill-gap
// Body: { date, start_time, duration_minutes, stylist, service_hint?, max_candidates? }
// Same waitlist/lapsed ranking as fill-gap.js, but instead of SMS, Lola
// originates outbound Telnyx TeXML calls to each candidate. On answer,
// Telnyx hits /api/webhooks/telnyx-fill-gap to fetch the TeXML script.
//
// Requires env:
//   TELNYX_API_KEY               — same one used by /api/telnyx-voice.js
//   TELNYX_VOICE_APP_ID (or TELNYX_TEXML_APP_ID) — the TeXML Application id
//   APP_URL                       — public base for webhook (default loladesk.com)
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const TELNYX_KEY = process.env.TELNYX_API_KEY;
  const VOICE_APP_ID = process.env.TELNYX_VOICE_APP_ID || process.env.TELNYX_TEXML_APP_ID;
  if (!TELNYX_KEY)    return res.status(500).json({ ok: false, error: 'telnyx_api_key_missing' });
  if (!VOICE_APP_ID)  return res.status(500).json({ ok: false, error: 'telnyx_voice_app_id_missing', hint: 'Set TELNYX_VOICE_APP_ID env var to your TeXML Application id.' });

  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const date = String(body.date || '').slice(0, 10);
    const startTime = String(body.start_time || '').slice(0, 5);
    const durationMin = parseInt(body.duration_minutes, 10) || 30;
    const stylist = String(body.stylist || '').slice(0, 200);
    const serviceHint = String(body.service_hint || '').slice(0, 200);
    const maxCand = Math.min(parseInt(body.max_candidates || '3', 10) || 3, 5);
    if (!date || !startTime) return res.status(400).json({ ok: false, error: 'date_and_start_time_required' });

    const c = dbFn();

    // ── Candidate ranking (same as SMS fill-gap) ──────
    let candidates = [];
    try {
      const { data: wait } = await c.from('booking_waitlist')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(50);
      for (const w of (wait || [])) {
        const wPhone = w.client_phone || w.phone; if (!wPhone) continue;
        candidates.push({
          source: 'waitlist',
          client_id: w.client_id || null,
          waitlist_id: w.id,
          name: w.client_name || 'Client',
          phone: wPhone,
          service: w.service_name || w.service || serviceHint || '',
          fit_score: scoreFit(w, { startTime, serviceHint, stylist })
        });
      }
    } catch (_) {}

    if (candidates.length < maxCand) {
      try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 45);
        const { data: lapsed } = await c.from('clients')
          .select('*')
          .eq('tenant_id', tenant.id)
          .not('phone', 'is', null)
          .lt('last_visit', cutoff.toISOString())
          .order('last_visit', { ascending: false })
          .limit(20);
        for (const l of (lapsed || [])) {
          if (!l.phone) continue;
          candidates.push({
            source: 'lapsed',
            client_id: l.id,
            waitlist_id: null,
            name: l.name || 'Client',
            phone: l.phone,
            service: l.preferred_service || serviceHint || '',
            fit_score: scoreFit({ stylist_hint: l.preferred_stylist }, { startTime, serviceHint, stylist }) - 10
          });
        }
      } catch (_) {}
    }

    // Dedupe + rank
    const seen = new Set();
    candidates = candidates
      .filter(x => { const k = x.phone.replace(/\D/g,''); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, maxCand);

    if (!candidates.length) return res.json({ ok: true, data: { attempts: [], sent_count: 0, reason: 'no_candidates' } });

    // Dedupe: don't voice-call anyone we've dialled or texted for this same gap in the last 24h
    try {
      const cutoff = new Date(); cutoff.setHours(cutoff.getHours() - 24);
      const { data: prior } = await c.from('fill_gap_attempts')
        .select('client_phone')
        .eq('tenant_id', tenant.id)
        .eq('gap_date', date)
        .eq('gap_start_time', startTime)
        .gte('created_at', cutoff.toISOString());
      const skip = new Set((prior || []).map(p => String(p.client_phone || '').replace(/\D/g,'')));
      candidates = candidates.filter(x => !skip.has(x.phone.replace(/\D/g,'')));
    } catch (_) {}

    if (!candidates.length) return res.json({ ok: true, data: { attempts: [], sent_count: 0, reason: 'already_contacted_recently' } });

    // ── Fire calls ────────────────────────────────────
    const base = process.env.APP_URL || 'https://www.loladesk.com';
    const salonName = tenant.name || 'the salon';
    const fromNumber = tenant.outbound_number || tenant.voice_number || tenant.phone_number || null;

    const attempts = [];
    for (const cand of candidates) {
      // Insert attempt row up front so we have an ID to pass into the webhook URL
      let attemptId = null;
      try {
        const { data: row, error } = await c.from('fill_gap_attempts').insert({
          tenant_id: tenant.id,
          gap_date: date,
          gap_start_time: startTime,
          gap_duration_minutes: durationMin,
          gap_stylist: stylist || null,
          client_id: cand.client_id,
          waitlist_id: cand.waitlist_id,
          client_name: cand.name,
          client_phone: cand.phone,
          source: cand.source,
          fit_score: cand.fit_score,
          message: '(voice)',
          status: 'pending',
          channel: 'voice',
          created_by: user.id || null
        }).select().single();
        if (error) throw error;
        attemptId = row.id;
      } catch (e) {
        console.warn('[voice-fill-gap] insert attempt failed', e?.message);
      }

      // Craft the TeXML webhook URL with everything the script needs
      const params = new URLSearchParams({
        attempt_id: attemptId || '',
        tenant_id: tenant.id,
        name: cand.name,
        service: cand.service || '',
        gap_date: date,
        gap_time: startTime,
        salon: salonName
      });
      const texmlUrl = `${base}/api/webhooks/telnyx-fill-gap?${params.toString()}`;
      const statusUrl = `${base}/api/webhooks/telnyx-fill-gap-status?attempt_id=${attemptId || ''}`;

      // Originate the call — Telnyx TeXML Application flow
      let telnyxJson = null;
      let ok = false;
      let errMsg = null;
      try {
        const originateUrl = `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(VOICE_APP_ID)}`;
        const r = await fetch(originateUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            To: cand.phone,
            From: fromNumber || '',
            Url: texmlUrl,
            StatusCallback: statusUrl,
            StatusCallbackMethod: 'POST',
            Record: 'true',
            MachineDetection: 'Enable',
            Timeout: '30'
          }).toString()
        });
        const raw = await r.text();
        try { telnyxJson = JSON.parse(raw); } catch { telnyxJson = { raw: raw.slice(0, 400) }; }
        if (r.ok) ok = true;
        else errMsg = telnyxJson?.errors?.[0]?.detail || raw.slice(0, 300);
      } catch (e) {
        errMsg = e?.message || String(e);
      }

      const telnyxCallId = telnyxJson?.data?.call_control_id || telnyxJson?.data?.call_sid || telnyxJson?.sid || null;

      // Update attempt with call id + status
      try {
        await c.from('fill_gap_attempts').update({
          status: ok ? 'ringing' : 'failed',
          error: errMsg,
          telnyx_call_id: telnyxCallId
        }).eq('id', attemptId);
      } catch (_) {}

      attempts.push({
        client_name: cand.name,
        phone: maskPhone(cand.phone),
        source: cand.source,
        status: ok ? 'ringing' : 'failed',
        telnyx_call_id: telnyxCallId,
        error: errMsg
      });
    }

    const sent = attempts.filter(a => a.status === 'ringing').length;
    return res.json({
      ok: true,
      data: {
        attempts,
        sent_count: sent,
        gap: { date, start_time: startTime, duration_minutes: durationMin, stylist },
        channel: 'voice'
      }
    });
  } catch (e) {
    console.error('[voice-fill-gap]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ── helpers ──
function scoreFit(w, gap) {
  let s = 50;
  if (w.preferred_time && gap.startTime) {
    const [ph, pm] = String(w.preferred_time).split(':').map(n => parseInt(n, 10));
    const [gh, gm] = gap.startTime.split(':').map(n => parseInt(n, 10));
    if (Number.isFinite(ph) && Number.isFinite(gh)) {
      const d = Math.abs((ph * 60 + (pm || 0)) - (gh * 60 + (gm || 0)));
      s += Math.max(0, 40 - Math.floor(d / 15) * 6);
    }
  }
  if (w.stylist_hint && gap.stylist && String(w.stylist_hint).toLowerCase() === String(gap.stylist).toLowerCase()) s += 20;
  if (w.service && gap.serviceHint && String(w.service).toLowerCase().includes(String(gap.serviceHint).toLowerCase())) s += 10;
  return s;
}
function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? `···${d.slice(-4)}` : '···'; }
