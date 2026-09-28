/* ============================================================
   CALL CENTER — LolaDesk (inside the app)
   Who needs you first · the conversation as a thread · hear it ·
   call back (Lola dials) · text · take over a live call ·
   waitlist · mark handled · ask Lola about the call.
   Endpoints: /api/call-center/{calls,call,callback,sms,handled,waitlist,take-over}
   ============================================================ */
(function () {
  'use strict';
  const S = { filter: 'needs', q: '', calls: [], sel: null, timer: null, liveTimer: null };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => (window.LolaAuth && window.LolaAuth.token) || localStorage.getItem('loladesk_token') || '';
  const hdr = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() });
  const phoneFmt = (p) => { const d = String(p || '').replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(p || ''); };
  const when = (ts) => { if (!ts) return ''; const d = new Date(ts), now = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((day(now) - day(d)) / 864e5); const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return diff === 0 ? t : diff === 1 ? 'Yesterday ' + t : diff < 7 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  const dur = (s) => { s = Number(s) || 0; const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`; };

  // ── what each call is ──
  const LIVE = new Set(['ringing', 'in_progress', 'in-progress', 'live', 'active', 'answered', 'initiated', 'bridging']);
  const MISSED = new Set(['no-answer', 'no_answer', 'busy', 'failed', 'canceled', 'cancelled', 'missed', 'abandoned', 'unanswered']);
  const ESCALATE = /\b(manager|the owner|speak (to|with) (a |the )?(person|human|someone|owner|manager)|real person|complain\w*|refund|upset|angry|terrible|lawyer|call me back|callback)\b/i;
  const UNHAPPY = /refund|complain|upset|angry|terrible|lawyer/i;
  const callerWords = (t) => String(t || '').split(/\n+/).filter(l => /^\s*(caller|client|customer|user)\s*:/i.test(l)).join('\n') || String(t || '');
  const lolaWords = (t) => String(t || '').split(/\n+/).filter(l => /^\s*(lola|assistant|agent)\s*:/i.test(l)).join('\n');
  const isLive = (c) => LIVE.has(c.status) && (!c.started_at || Date.now() - Date.parse(c.started_at) < 2 * 3600e3);
  const isVm = (c) => !!c.is_voicemail;
  const isBooked = (c) => /book/i.test(c.outcome || '') || /\b(you(?:'re| are) (all )?(set|booked|confirmed)|booked you|i'?ve booked|confirmation (code|number))\b/i.test(lolaWords(c.transcript));
  function needsWhy(c) {
    if (c.handled || c.direction !== 'inbound' || isLive(c)) return null;
    const w = callerWords(c.transcript);
    if (ESCALATE.test(w)) return UNHAPPY.test(w) ? 'Sounded unhappy — call them personally.' : 'Asked for you or for a call back.';
    if (isVm(c)) return 'Left a voicemail.';
    if (MISSED.has(c.status)) return "Didn't get through to Lola.";
    return null;
  }
  const kind = (c) => isLive(c) ? 'live' : needsWhy(c) ? 'need' : isBooked(c) ? 'booked' : isVm(c) ? 'vm' : '';

  // ── data ──
  async function load() {
    try {
      const r = await fetch('/api/call-center/calls?limit=200', { headers: hdr() });
      if (r.status === 401) { location.href = '/login?next=%2Fcalls'; return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || ('calls ' + r.status));
      S.calls = (d.calls || []).map(x => ({ ...x, status: String(x.status || '').toLowerCase(), direction: String(x.direction || 'inbound').toLowerCase() }));
    } catch (e) {
      if (!S.calls.length) $('list').innerHTML = `<li class="empty">Couldn't load calls: ${esc(e.message)}</li>`;
      return;
    }
    counts(); renderList();
    if (S.sel) { const u = S.calls.find(x => x.id === S.sel.id); if (u) { S.sel = u; renderDetail(); } }
  }
  function counts() {
    const c = { needs: 0, live: 0, booked: 0, vm: 0, all: S.calls.length };
    for (const x of S.calls) { if (needsWhy(x)) c.needs++; if (isLive(x)) c.live++; if (isBooked(x)) c.booked++; if (isVm(x)) c.vm++; }
    $('nNeeds').textContent = c.needs; $('nLive').textContent = c.live; $('nBooked').textContent = c.booked; $('nVm').textContent = c.vm; $('nAll').textContent = c.all;
    const week = S.calls.filter(x => x.direction === 'inbound' && Date.now() - Date.parse(x.started_at || 0) < 7 * 864e5);
    const wb = week.filter(isBooked).length;
    $('narrative').textContent = week.length
      ? `Lola answered ${week.length} call${week.length === 1 ? '' : 's'} this week${wb ? ` and booked ${wb}` : ''}. ${c.needs ? `${c.needs} need${c.needs === 1 ? 's' : ''} you.` : 'Nothing needs you.'}`
      : 'Every call Lola takes shows up here — who needs you, what was said, and one tap to call back.';
    document.querySelector('.chip[data-f="needs"]').classList.toggle('alert', c.needs > 0);
  }
  function visible() {
    const q = S.q.toLowerCase();
    return S.calls.filter(c => {
      if (S.filter === 'needs' && !needsWhy(c)) return false;
      if (S.filter === 'live' && !isLive(c)) return false;
      if (S.filter === 'booked' && !isBooked(c)) return false;
      if (S.filter === 'vm' && !isVm(c)) return false;
      if (q && !`${c.client_name} ${c.phone} ${phoneFmt(c.phone)} ${c.transcript}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0));
  }
  function renderList() {
    const list = visible();
    const el = $('list');
    if (!list.length) {
      el.innerHTML = `<li class="empty">${S.filter === 'needs' ? 'Nothing needs you. Lola has it covered.' : S.q ? 'No calls match that search.' : 'No calls here yet.'}</li>`;
      return;
    }
    el.innerHTML = list.map(c => {
      const k = kind(c);
      const icon = k === 'live' ? '●' : k === 'need' ? '!' : k === 'booked' ? '✓' : k === 'vm' ? '✉' : c.direction === 'outbound' ? '↗' : '↙';
      const name = c.client_name || phoneFmt(c.phone) || 'Unknown caller';
      const last = String(c.transcript || '').split(/\n+/).map(l => l.replace(/^\s*\w+\s*:\s*/, '')).filter(Boolean);
      const snip = last.length ? last[0] : '';
      return `<li class="row ${S.sel && S.sel.id === c.id ? 'sel' : ''}" data-id="${esc(c.id)}" tabindex="0">
        <div class="ic ${k}">${icon}</div>
        <div style="min-width:0"><div class="nm">${esc(name)}</div>
          <div class="ph">${c.client_name ? esc(phoneFmt(c.phone)) + ' · ' : ''}${c.direction === 'outbound' ? 'Outgoing' : 'Incoming'}${c.duration_sec ? ' · ' + dur(c.duration_sec) : ''}</div>
          ${snip ? `<div class="sn">${esc(snip)}</div>` : ''}
          ${k === 'need' ? '<span class="tag need">Needs you</span>' : ''}${k === 'booked' ? '<span class="tag booked">Booked</span>' : ''}${isVm(c) ? '<span class="tag vm">Voicemail</span>' : ''}${c.handled ? '<span class="tag">Handled</span>' : ''}
        </div>
        <div class="tm">${esc(when(c.started_at))}</div></li>`;
    }).join('');
    el.querySelectorAll('.row').forEach(r => { r.onclick = () => select(r.dataset.id); r.onkeydown = (e) => { if (e.key === 'Enter') select(r.dataset.id); }; });
  }
  function select(id) {
    const c = S.calls.find(x => String(x.id) === String(id)); if (!c) return;
    S.sel = c; renderList(); renderDetail();
    clearInterval(S.liveTimer);
    if (isLive(c)) S.liveTimer = setInterval(refreshSelected, 3000);
  }
  async function refreshSelected() {
    if (!S.sel) return;
    try {
      const r = await fetch('/api/call-center/call?id=' + encodeURIComponent(S.sel.id), { headers: hdr() });
      const d = await r.json().catch(() => ({}));
      const row = d.call || d.data || null;
      if (row) { S.sel = { ...S.sel, ...row, status: String(row.status || S.sel.status).toLowerCase() }; renderDetail(true); if (!isLive(S.sel)) clearInterval(S.liveTimer); }
    } catch (_) {}
  }
  function thread(text, name) {
    const who = String(name || '').split(' ')[0] || 'Caller';
    const out = [];
    for (const line of String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean)) {
      const m = /^(caller|client|customer|user|lola|assistant|agent)\s*:\s*(.*)$/i.exec(line);
      if (m) out.push({ lola: /^(lola|assistant|agent)$/i.test(m[1]), text: m[2] });
      else if (out.length) out[out.length - 1].text += ' ' + line;
      else out.push({ lola: false, text: line });
    }
    return out.map(b => `<div class="msg ${b.lola ? 'lola' : 'caller'}"><div class="who">${b.lola ? 'Lola' : esc(who)}</div><div class="bub">${esc(b.text)}</div></div>`).join('');
  }
  function renderDetail(keepCompose) {
    const c = S.sel, el = $('detail');
    if (!c) { el.innerHTML = '<div class="empty">Select a call to see the conversation, hear it, and act.</div>'; return; }
    const draft = keepCompose && $('smsText') ? $('smsText').value : null;
    const live = isLive(c), why = needsWhy(c);
    const name = c.client_name || phoneFmt(c.phone) || 'Unknown caller';
    const first = (c.client_name || '').split(' ')[0];
    el.innerHTML = `
      <div class="eyebrow">${live ? '<span style="color:var(--accent)">● Live now</span>' : c.direction === 'outbound' ? 'Outgoing call' : 'Incoming call'} · ${esc(when(c.started_at))}${c.duration_sec ? ' · ' + dur(c.duration_sec) : ''}</div>
      <h2>${c.client_id ? `<a href="/client.html?id=${encodeURIComponent(c.client_id)}">${esc(name)}</a>` : esc(name)}</h2>
      <div class="sub">${esc(phoneFmt(c.phone))}${c.client_id ? '' : ' · not a client yet'}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : ''}
      <div class="acts">
        ${live ? '<button class="btn primary" id="aTake">Take over the call</button>' : `<button class="btn primary" id="aCall" ${c.phone ? '' : 'disabled'}>Lola, call ${esc(first || 'them')} back</button>`}
        <button class="btn" id="aText" ${c.phone ? '' : 'disabled'}>Text</button>
        <button class="btn" id="aAsk">Ask Lola</button>
        ${!c.handled && !live ? '<button class="btn" id="aDone">Mark handled</button>' : ''}
        ${!live && why ? '<button class="btn" id="aWait">Add to waitlist</button>' : ''}
      </div>
      <div id="composeHost"></div>
      <div class="status" id="st"></div>
      ${c.recording_url ? `<div class="lbl">Recording</div><audio controls preload="metadata" src="${esc(c.recording_url)}"></audio>` : ''}
      <div class="lbl">${live ? 'Live conversation' : 'Conversation'}</div>
      <div class="thread" id="thr">${c.transcript ? thread(c.transcript, c.client_name) : '<div class="sub">No conversation recorded for this call.</div>'}</div>`;
    const thr = $('thr'); if (thr) thr.scrollTop = thr.scrollHeight;
    $('aTake') && ($('aTake').onclick = () => takeOver(c));
    $('aCall') && ($('aCall').onclick = () => callBack(c));
    $('aText') && ($('aText').onclick = () => compose(c));
    $('aDone') && ($('aDone').onclick = () => handled(c));
    $('aWait') && ($('aWait').onclick = () => waitlist(c));
    $('aAsk').onclick = () => askLola(c);
    if (draft != null) { compose(c); $('smsText').value = draft; }
  }
  function st(msg, k) { const e = $('st'); if (e) { e.className = 'status ' + (k || 'info'); e.textContent = msg; } }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || ('failed (' + r.status + ')'));
    return d;
  }
  async function callBack(c) {
    const b = $('aCall'); b.disabled = true; st('Lola is dialing…');
    try { await post('/api/call-center/callback', { to: c.phone, call_id: c.id }); st(`Lola is calling ${c.client_name || phoneFmt(c.phone)} now. The call will show up here.`, 'ok'); setTimeout(load, 5000); }
    catch (e) { st("Couldn't place the call: " + e.message, 'err'); b.disabled = false; }
  }
  async function takeOver(c) {
    const b = $('aTake'); b.disabled = true; st('Connecting you…');
    try { await post('/api/call-center/take-over', { call_id: c.id, telnyx_call_id: c.telnyx_call_id }); st('Your phone will ring — answer to take the call from Lola.', 'ok'); }
    catch (e) { st("Couldn't take over: " + e.message + (/owner_phone|operator/i.test(e.message) ? ' Set your mobile in Settings → Call handling.' : ''), 'err'); b.disabled = false; }
  }
  function compose(c) {
    const host = $('composeHost'); if (!host || $('smsText')) { $('smsText') && $('smsText').focus(); return; }
    const first = (c.client_name || '').split(' ')[0];
    const hi = first ? `Hi ${first}, ` : 'Hi, ';
    const why = needsWhy(c) || '';
    const quick = [
      /unhappy/i.test(why) ? [`Personal apology`, `${hi}I'm so sorry about your experience. I want to make it right — I'll call you personally today.`]
        : /voicemail|through/i.test(why) ? [`Sorry we missed you`, `${hi}sorry we missed your call! How can we help? You can reply here to book.`]
        : [`Following up`, `${hi}following up on your call — how can I help?`],
      [`Call you soon`, `${hi}thanks for calling — I'll call you back shortly.`],
      [`Book online`, `${hi}you can grab any open time here and we'll see you soon!`],
    ];
    host.innerHTML = `<div class="compose"><div class="quick">${quick.map((q, i) => `<button type="button" data-q="${i}">${esc(q[0])}</button>`).join('')}</div>
      <textarea id="smsText" placeholder="Write a text…"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn" id="smsCancel">Cancel</button><button class="btn primary" id="smsSend">Send text</button></div></div>`;
    host.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { $('smsText').value = quick[+b.dataset.q][1]; $('smsText').focus(); });
    $('smsCancel').onclick = () => { host.innerHTML = ''; };
    $('smsSend').onclick = async () => {
      const text = $('smsText').value.trim(); if (!text) return;
      $('smsSend').disabled = true; st('Sending…');
      try { await post('/api/call-center/sms', { to: c.phone, text }); host.innerHTML = ''; st('Text sent.', 'ok'); }
      catch (e) { st("Couldn't send: " + e.message, 'err'); $('smsSend').disabled = false; }
    };
    $('smsText').focus();
  }
  async function handled(c) {
    try { await post('/api/call-center/handled', { id: c.id, handled: true }); c.handled = true; counts(); renderList(); renderDetail(); st('Marked handled.', 'ok'); }
    catch (e) { st("Couldn't update: " + e.message, 'err'); }
  }
  async function waitlist(c) {
    try { await post('/api/call-center/waitlist', { phone: c.phone, client_name: c.client_name || '' }); st('On the waitlist — Lola will offer them the next opening.', 'ok'); }
    catch (e) { st("Couldn't add: " + e.message, 'err'); }
  }
  function askLola(c) {
    const L = window.LolaEverywhere; if (!L) return;
    const name = c.client_name || phoneFmt(c.phone);
    L.setContext({ 'Call the owner is looking at': `${c.direction} call ${c.client_name ? 'with ' + c.client_name + ' ' : ''}(${c.phone}) ${when(c.started_at)}. Conversation:\n${String(c.transcript || '(none)').slice(0, 2500)}` });
    if (L.ask) L.ask(`What happened on the call with ${name}, and what should I do?`); else L.open();
  }

  // ── wiring ──
  document.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    document.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); b.classList.add('on');
    S.filter = b.dataset.f; renderList(); schedule();
  });
  $('q').addEventListener('input', (e) => { S.q = e.target.value.trim(); renderList(); });
  $('auto').addEventListener('change', schedule);
  function schedule() { clearInterval(S.timer); if ($('auto').checked) S.timer = setInterval(() => { if (!document.hidden) load(); }, S.filter === 'live' ? 5000 : 15000); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  (async () => { try { await window.LolaAuth.ready; } catch (_) { return; } await load(); schedule(); const deep = new URLSearchParams(location.search).get('call'); if (deep) select(deep); })();
})();
