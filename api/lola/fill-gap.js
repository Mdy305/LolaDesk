// POST /api/lola/fill-gap
// Body: { date: 'YYYY-MM-DD', start_time: 'HH:MM', duration_minutes: N, stylist?: string, service_hint?: string, max_candidates?: 3 }
// Response: { ok, data: { attempts: [{ client_id, name, phone, status, message_id? }], sent_count } }
// Uses the tenant's SMS number (api/lib/sms.js → Telnyx) to text ranked waitlist clients.
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn, sms;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
    sms = await import('../lib/sms.js').catch(() => null);
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
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

    // ── Rank candidates ────────────────────────────────
    // Strategy: pull recent waitlist entries + lapsed regulars.
    // Any query that fails is treated as an empty pool (best-effort).
    let candidates = [];

    // Waitlist first
    try {
      const { data: wait } = await c.from('booking_waitlist')
        .select('id, tenant_id, client_id, client_name, phone, service, stylist_hint, preferred_time, created_at, status')
        .eq('tenant_id', tenant.id)
        .in('status', ['open', 'active', null])
        .order('created_at', { ascending: true })
        .limit(50);
      if (Array.isArray(wait)) {
        for (const w of wait) {
          if (!w.phone) continue;
          const fitScore = scoreFit(w, { startTime, serviceHint, stylist });
          candidates.push({
            source: 'waitlist',
            client_id: w.client_id || null,
            waitlist_id: w.id,
            name: w.client_name || 'Client',
            phone: w.phone,
            service: w.service || serviceHint || '',
            fit_score: fitScore
          });
        }
      }
    } catch (_) {}

    // Fall back to lapsed regulars (haven't booked in 45+ days) if we don't have enough
    if (candidates.length < maxCand) {
      try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 45);
        const { data: lapsed } = await c.from('clients')
          .select('id, name, phone, last_visit_at, preferred_service, preferred_stylist')
          .eq('tenant_id', tenant.id)
          .not('phone', 'is', null)
          .lt('last_visit_at', cutoff.toISOString())
          .order('last_visit_at', { ascending: false })
          .limit(20);
        if (Array.isArray(lapsed)) {
          for (const l of lapsed) {
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
        }
      } catch (_) {}
    }

    // Dedupe by phone, sort by fit
    const seen = new Set();
    candidates = candidates
      .filter(c2 => { const key = c2.phone.replace(/\D/g,''); if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, maxCand);

    if (!candidates.length) {
      return res.json({ ok: true, data: { attempts: [], sent_count: 0, reason: 'no_candidates' } });
    }

    // Guard: skip candidates we've already texted for this same gap in the last 24h
    let alreadyTexted = new Set();
    try {
      const cutoff = new Date(); cutoff.setHours(cutoff.getHours() - 24);
      const { data: prior } = await c.from('fill_gap_attempts')
        .select('client_phone')
        .eq('tenant_id', tenant.id)
        .eq('gap_date', date)
        .eq('gap_start_time', startTime)
        .gte('created_at', cutoff.toISOString());
      for (const p of (prior || [])) alreadyTexted.add(String(p.client_phone || '').replace(/\D/g,''));
    } catch (_) {}
    candidates = candidates.filter(c2 => !alreadyTexted.has(c2.phone.replace(/\D/g,'')));

    if (!candidates.length) {
      return res.json({ ok: true, data: { attempts: [], sent_count: 0, reason: 'already_texted_recently' } });
    }

    // ── Build message + send ─────────────────────────
    const salonName = tenant.name || 'the salon';
    const humanTime = fmtHumanTime(startTime);
    const bookLink = `${(process.env.APP_URL || 'https://www.loladesk.com')}/book?t=${encodeURIComponent(tenant.slug || tenant.id)}&d=${date}&s=${encodeURIComponent(startTime)}`;

    const attempts = [];
    for (const cand of candidates) {
      const svcLine = cand.service ? ` for ${cand.service}` : '';
      const msg = `Hi ${firstName(cand.name)} — it's Lola from ${salonName}. A ${humanTime} spot just opened up today${svcLine}. Want it? Tap: ${bookLink}`;

      let messageId = null;
      let ok = false;
      let errMsg = null;
      try {
        if (sms?.sendSms) {
          const r = await sms.sendSms({ tenant, to: cand.phone, body: msg });
          messageId = r?.id || r?.message_id || null;
          ok = true;
        } else {
          errMsg = 'sms_lib_missing';
        }
      } catch (e) {
        errMsg = e?.message || String(e);
      }

      // Record every attempt (success or fail)
      try {
        await c.from('fill_gap_attempts').insert({
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
          message: msg,
          telnyx_message_id: messageId,
          status: ok ? 'sent' : 'failed',
          error: errMsg,
          created_by: user.id || null
        });
      } catch (_) {}

      attempts.push({
        client_id: cand.client_id,
        name: cand.name,
        phone: maskPhone(cand.phone),
        source: cand.source,
        status: ok ? 'sent' : 'failed',
        message_id: messageId,
        error: errMsg
      });
    }

    const sentCount = attempts.filter(a => a.status === 'sent').length;
    return res.json({ ok: true, data: { attempts, sent_count: sentCount, gap: { date, start_time: startTime, duration_minutes: durationMin, stylist } } });
  } catch (e) {
    console.error('[fill-gap]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ── helpers ──────────────────────────────────────────────
function scoreFit(w, gap) {
  let s = 50;
  // preferred_time closeness
  if (w.preferred_time && gap.startTime) {
    const [ph, pm] = String(w.preferred_time).split(':').map(n => parseInt(n, 10));
    const [gh, gm] = gap.startTime.split(':').map(n => parseInt(n, 10));
    if (Number.isFinite(ph) && Number.isFinite(gh)) {
      const deltaMin = Math.abs((ph * 60 + (pm || 0)) - (gh * 60 + (gm || 0)));
      s += Math.max(0, 40 - Math.floor(deltaMin / 15) * 6);
    }
  }
  // stylist match
  if (w.stylist_hint && gap.stylist && String(w.stylist_hint).toLowerCase() === String(gap.stylist).toLowerCase()) s += 20;
  // service match
  if (w.service && gap.serviceHint && String(w.service).toLowerCase().includes(String(gap.serviceHint).toLowerCase())) s += 10;
  return s;
}
function firstName(name) { return String(name || 'there').trim().split(/\s+/)[0]; }
function fmtHumanTime(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 4 ? `···${d.slice(-4)}` : '···';
}
