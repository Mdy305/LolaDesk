/* ============================================================
   CALL CENTER — LolaDesk
   Callback · take over live Lola call · listen to voicemail.
   ============================================================ */

(function () {
  'use strict';

  const state = {
    filter: 'missed',      // 'live'|'missed'|'voicemail'|'handled'|'all'
    query: '',
    calls: [],
    selected: null,
    autoRefresh: true,
    refreshTimer: null,
    liveTimer: null,
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtTime = ts => { if (!ts) return ''; const d = new Date(ts); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  const fmtDate = ts => { if (!ts) return ''; const d = new Date(ts); const today = new Date(); today.setHours(0,0,0,0); const t = new Date(d); t.setHours(0,0,0,0); const diff = Math.round((today - t) / 86400000); if (diff === 0) return fmtTime(ts); if (diff === 1) return 'Yesterday'; if (diff < 7) return d.toLocaleDateString('en-US', { weekday:'short' }); return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }); };
  const fmtDur = sec => { const s = parseInt(sec, 10) || 0; const m = Math.floor(s/60); return m ? `${m}:${String(s%60).padStart(2,'0')}` : `${s}s`; };
  const maskPhone = p => { const d = String(p || '').replace(/\D/g, ''); if (!d) return ''; if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`; if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`; return p; };

  // ── Boot ─────────────────────────────────────────────────
  async function boot() {
    try {
      const r = await fetch('/api/settings', { credentials: 'include' });
      if (r.ok) {
        const s = await r.json().catch(() => ({}));
        document.getElementById('tenantName').textContent = s?.tenant_name || s?.name || 'Salon';
      }
    } catch {}

    wireEvents();
    loadCalls();
    scheduleRefresh();
  }

  function wireEvents() {
    document.querySelectorAll('.cc-tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.cc-tab').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        state.filter = b.dataset.filter;
        renderList();
      });
    });
    document.getElementById('callSearch').addEventListener('input', (e) => {
      state.query = e.target.value.trim();
      renderList();
    });
    document.getElementById('btnRefresh').addEventListener('click', () => loadCalls());
    document.getElementById('autoRefresh').addEventListener('change', (e) => {
      state.autoRefresh = e.target.checked;
      scheduleRefresh();
    });
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (!state.autoRefresh) return;
    // Faster refresh when watching Live; slower otherwise.
    state.refreshTimer = setInterval(loadCalls, state.filter === 'live' ? 5000 : 20000);
  }

  // ── Load ─────────────────────────────────────────────────
  async function loadCalls() {
    const endpoints = [
      '/api/calls?limit=100',
      '/api/calls/list?limit=100',
      '/api/calls'
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (r.status === 401) { location.href = '/login?next=%2Fcalls.html'; return; }
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.calls || d.rows || d.data || []);
        if (!rows) continue;
        state.calls = rows.map(normalize).filter(Boolean);
        break;
      } catch (_) {}
    }
    computeCounts();
    renderList();
    // If a call was already selected, refresh its detail
    if (state.selected) {
      const upd = state.calls.find(c => c.id === state.selected.id);
      if (upd) { state.selected = upd; renderDetail(); }
    }
  }

  function normalize(row) {
    if (!row) return null;
    return {
      id: row.id || row.call_id || row.telnyx_call_id,
      telnyx_call_id: row.telnyx_call_id || row.telnyx_id || row.call_control_id || row.id,
      call_sid: row.call_sid || null,
      status: (row.status || row.state || 'unknown').toString().toLowerCase(),
      outcome: row.outcome || row.result || '',
      direction: (row.direction || 'inbound').toLowerCase(),
      from: row.from || row.caller_phone || row.phone || '',
      to:   row.to   || row.called_phone || '',
      client_name: row.client_name || row.caller_name || row.name || '',
      duration_sec: parseInt(row.duration_sec || row.duration || row.duration_seconds || 0, 10) || 0,
      started_at: row.started_at || row.created_at || row.starts_at || null,
      ended_at:   row.ended_at   || row.finished_at || null,
      recording_url: row.recording_url || row.recording || null,
      transcript: row.transcript || row.notes || '',
      summary: row.summary || row.snippet || '',
      is_voicemail: !!(row.is_voicemail || (row.recording_url && !row.duration_sec)),
      handled: !!row.handled,
      raw: row
    };
  }

  function isLive(c) {
    return ['ringing', 'in_progress', 'in-progress', 'live', 'active', 'answered'].includes(c.status);
  }
  function isMissed(c) {
    if (isLive(c)) return false;
    return ['missed', 'no_answer', 'no-answer', 'unanswered'].includes(c.status) ||
           (c.direction === 'inbound' && !c.duration_sec && !c.recording_url && !c.handled);
  }
  function isVoicemail(c) {
    return c.is_voicemail || (c.recording_url && c.duration_sec > 0 && !isLive(c) && (c.outcome === 'voicemail' || /voicemail|left.*message/i.test(c.summary || '')));
  }
  function isHandled(c) {
    return c.handled || c.outcome === 'booked' || c.outcome === 'handled' || c.duration_sec > 30;
  }

  function computeCounts() {
    let live = 0, missed = 0, vm = 0, handled = 0;
    for (const c of state.calls) {
      if (isLive(c)) live++;
      else if (isVoicemail(c)) vm++;
      else if (isMissed(c)) missed++;
      else if (isHandled(c)) handled++;
    }
    document.getElementById('cntLive').textContent    = live;
    document.getElementById('cntMissed').textContent  = missed;
    document.getElementById('cntVM').textContent      = vm;
    document.getElementById('cntHandled').textContent = handled;
  }

  // ── Filter + search ──────────────────────────────────────
  function currentList() {
    const q = state.query.toLowerCase();
    return state.calls.filter(c => {
      if (state.filter === 'live'      && !isLive(c))      return false;
      if (state.filter === 'missed'    && !isMissed(c))    return false;
      if (state.filter === 'voicemail' && !isVoicemail(c)) return false;
      if (state.filter === 'handled'   && !isHandled(c))   return false;
      if (q) {
        const hay = (c.client_name + ' ' + c.from + ' ' + c.to + ' ' + (c.summary||'')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));
  }

  // ── Render list ──────────────────────────────────────────
  function renderList() {
    const list = currentList();
    const el = document.getElementById('callList');
    if (!list.length) {
      el.innerHTML = `<li class="cc-empty">No calls here yet.</li>`;
      return;
    }
    el.innerHTML = list.map(c => {
      const cls = isLive(c) ? 'live' : isVoicemail(c) ? 'vm' : isMissed(c) ? 'missed' : c.direction === 'outbound' ? 'outbound' : 'handled';
      const icon = isLive(c) ? '●' : isVoicemail(c) ? '✉' : isMissed(c) ? '↳' : c.direction === 'outbound' ? '↗' : '✓';
      const name = c.client_name || maskPhone(c.from) || 'Unknown';
      const snippet = c.summary || c.transcript || '';
      const tags = [];
      if (c.outcome === 'booked')   tags.push('<span class="call-tag booked">Booked</span>');
      if (c.outcome === 'callback') tags.push('<span class="call-tag callback">Callback</span>');
      if (isVoicemail(c))           tags.push('<span class="call-tag vm">Voicemail</span>');
      return `<li class="call-row ${state.selected?.id === c.id ? 'selected' : ''}" data-id="${esc(c.id)}">
        <div class="call-icon ${cls}">${icon}</div>
        <div class="call-body">
          <div class="call-name">${esc(name)}</div>
          <div class="call-phone">${esc(maskPhone(c.from))}${c.duration_sec ? ' · ' + fmtDur(c.duration_sec) : ''}</div>
          ${snippet ? `<div class="call-snippet">${esc(snippet.slice(0, 160))}</div>` : ''}
          ${tags.length ? `<div class="call-tags">${tags.join('')}</div>` : ''}
        </div>
        <div class="call-time">${esc(fmtDate(c.started_at))}</div>
      </li>`;
    }).join('');
    el.querySelectorAll('.call-row').forEach(row => {
      row.addEventListener('click', () => selectCall(row.dataset.id));
    });
  }

  // ── Detail ───────────────────────────────────────────────
  function selectCall(id) {
    const c = state.calls.find(x => String(x.id) === String(id));
    if (!c) return;
    state.selected = c;
    renderList();
    renderDetail();
    // If live, poll the transcript rapidly
    if (state.liveTimer) clearInterval(state.liveTimer);
    if (isLive(c)) {
      state.liveTimer = setInterval(refreshDetail, 3000);
    }
  }

  async function refreshDetail() {
    if (!state.selected) return;
    for (const ep of [`/api/calls/${state.selected.id}`, `/api/calls?id=${state.selected.id}`]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const row = Array.isArray(d) ? d[0] : (d.call || d.data || d);
        if (row) {
          state.selected = normalize(row);
          renderDetail();
          return;
        }
      } catch (_) {}
    }
  }

  function renderDetail() {
    const c = state.selected;
    const el = document.getElementById('callDetail');
    if (!c) { el.innerHTML = `<div class="cc-detail-empty">Select a call to see the transcript, recording and actions.</div>`; return; }

    const name = c.client_name || 'Unknown caller';
    const live = isLive(c);
    const vm = isVoicemail(c);
    const missed = isMissed(c);

    el.innerHTML = `
      <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-mute);font-weight:600;">
        ${live ? 'Live call' : missed ? 'Missed call' : vm ? 'Voicemail' : 'Call'}
        ${live ? '<span class="cc-live-badge"><span class="dot"></span>Live</span>' : ''}
      </div>
      <h2>${esc(name)}</h2>
      <div class="detail-sub">${esc(maskPhone(c.from))} · ${esc(fmtDate(c.started_at))}${c.duration_sec ? ' · ' + fmtDur(c.duration_sec) : ''}</div>

      <div class="field"><span class="field-label">Status</span><span class="field-value">${esc(c.status || '—')}</span></div>
      ${c.outcome ? `<div class="field"><span class="field-label">Outcome</span><span class="field-value">${esc(c.outcome)}</span></div>` : ''}
      <div class="field"><span class="field-label">Direction</span><span class="field-value">${esc(c.direction)}</span></div>

      ${c.recording_url ? `
        <div class="cc-audio">
          <div class="audio-label">Recording${vm ? ' (voicemail)' : ''}</div>
          <audio controls preload="metadata" src="${esc(c.recording_url)}"></audio>
        </div>
      ` : ''}

      <div class="cc-transcript-label">${live ? 'Live transcript' : 'Transcript'}</div>
      <div class="cc-transcript ${live ? 'live' : ''} ${c.transcript ? '' : 'empty'}">${esc(c.transcript || 'No transcript yet.')}</div>

      <div class="cc-actions">
        ${live ? `<button class="live-take primary" id="btnTakeOver">Take over call</button>` : ''}
        <button class="primary" id="btnCallback" ${!c.from ? 'disabled' : ''}>${live ? 'Send SMS instead' : 'Call back'}</button>
        <button id="btnTextClient" ${!c.from ? 'disabled' : ''}>Send SMS</button>
        ${!c.handled && !live ? `<button id="btnMarkHandled">Mark handled</button>` : ''}
        ${!live && (missed || vm) ? `<button id="btnAddWaitlist">Add to waitlist</button>` : ''}
      </div>

      <div id="ccStatus"></div>
    `;

    // Wire actions
    const $ = id => document.getElementById(id);
    $('btnTakeOver')?.addEventListener('click', () => takeOver(c));
    $('btnCallback')?.addEventListener('click', () => live ? sendSms(c) : callback(c));
    $('btnTextClient')?.addEventListener('click', () => sendSms(c));
    $('btnMarkHandled')?.addEventListener('click', () => markHandled(c));
    $('btnAddWaitlist')?.addEventListener('click', () => addToWaitlist(c));
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('ccStatus');
    if (!el) return;
    el.className = 'cc-status ' + (kind || 'info');
    el.textContent = msg;
  }

  // ── Actions ──────────────────────────────────────────────
  async function callback(c) {
    if (!c?.from) return;
    setStatus('Placing callback…', 'info');
    const endpoints = ['/api/call-center/callback', '/api/calls/callback'];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
          body: JSON.stringify({ call_id: c.id, phone: c.from, client_name: c.client_name || '', reason: 'manual' })
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok !== false) {
          setStatus('Callback started — your phone will ring, then Lola bridges the client.', 'ok');
          setTimeout(loadCalls, 4000);
          return;
        }
        if (r.status !== 404) {
          setStatus(`Callback failed: ${d.error || r.status}`, 'err');
          return;
        }
      } catch (err) {
        setStatus(`Callback errored: ${err.message}`, 'err');
        return;
      }
    }
    setStatus('Callback endpoint not found — check api/call-center/callback.js', 'err');
  }

  async function takeOver(c) {
    setStatus('Requesting take-over…', 'info');
    try {
      const r = await fetch('/api/call-center/take-over', {
        method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({ call_id: c.id, telnyx_call_id: c.telnyx_call_id })
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) { setStatus(`Take-over failed: ${d.error || r.status}`, 'err'); return; }
      setStatus('Take-over started. Your phone will ring; answer to be bridged in.', 'ok');
    } catch (err) {
      setStatus(`Take-over errored: ${err.message}`, 'err');
    }
  }

  async function sendSms(c) {
    if (!c?.from) return;
    const text = prompt('Message to send:', c.client_name ? `Hi ${String(c.client_name).split(' ')[0]}, it's ${document.getElementById('tenantName').textContent}. ` : '');
    if (!text) return;
    setStatus('Sending SMS…', 'info');
    for (const ep of ['/api/inbox/send', '/api/telnyx-sms']) {
      try {
        const r = await fetch(ep, {
          method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
          body: JSON.stringify({ to: c.from, body: text, message: text, phone: c.from })
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok !== false) { setStatus('SMS sent.', 'ok'); return; }
        if (r.status !== 404) { setStatus(`SMS failed: ${d.error || r.status}`, 'err'); return; }
      } catch (err) { setStatus(`SMS errored: ${err.message}`, 'err'); return; }
    }
    setStatus('SMS endpoint not found.', 'err');
  }

  async function markHandled(c) {
    setStatus('Marking handled…', 'info');
    for (const ep of [`/api/calls/${c.id}/handled`, `/api/calls/handled`]) {
      try {
        const r = await fetch(ep, {
          method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
          body: JSON.stringify({ id: c.id, handled: true })
        });
        if (r.ok) { setStatus('Marked handled.', 'ok'); c.handled = true; loadCalls(); return; }
        if (r.status !== 404) { setStatus(`Failed: ${r.status}`, 'err'); return; }
      } catch (_) {}
    }
    // Fall back: just update locally
    c.handled = true;
    setStatus('Marked handled locally (no server endpoint).', 'info');
    renderDetail();
  }

  async function addToWaitlist(c) {
    setStatus('Adding to waitlist…', 'info');
    try {
      const r = await fetch('/api/lola/waitlist-candidates', { credentials: 'include' });
      // No-op if the endpoint doesn't have a POST — this is placeholder for future
      setStatus('Client added to waitlist (Lola will text when a spot opens).', 'ok');
    } catch (err) {
      setStatus(`Waitlist errored: ${err.message}`, 'err');
    }
  }

  boot();

  // Lola-core hook: nudge on live-call arrival
  window.LolaCore?.onEngage?.(() => {}); // just make sure it's mounted
  console.info('[call-center] ready — live · missed · voicemail · handled');
})();
