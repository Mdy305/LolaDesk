/* ═══════════════════════════════════════════════════════════════════
   lola-live.js — the "Lola Live" plug-in: live phone-call state and
   live steering of an active Telnyx AI-Assistant conversation, right
   on the operator dashboard.

     • polls  /api/live-conversations  (GET)  for active calls + the
       assistant's current conversations — no Telnyx key in the browser
     • shows each live call with a ticking duration and its transcript
     • "Whisper to Lola" POSTs a system message into the live
       conversation so the owner can steer Lola mid-call
     • degrades cleanly: without the AI assistant wired it still shows
       live call state and explains why whispering is unavailable
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const POLL_MS = 8000;

  let auth = null;
  let state = { calls: [], conversations: [], whisper: null, ready: false, tenant: '', paused: false, signedOut: false, note: null };
  let focused = null;   // focused call id
  let ticker = null;
  let pendingTakeover = null; // call id awaiting a confirm click

  function el(id) { return document.getElementById(id); }
  function fmtDuration(sec) {
    if (sec == null || Number.isNaN(sec)) return '—';
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function liveSecs(call) {
    if (!call.startedAt) return Number(call.durationSec || 0);
    return Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000);
  }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function panel() { return el('lolaLivePanel'); }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (auth?.token) headers.Authorization = 'Bearer ' + auth.token;
    const r = await fetch(path, { ...opts, headers });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  function setPill(text, tone) {
    const pill = el('liveStatePill');
    if (!pill) return;
    pill.textContent = text;
    pill.dataset.tone = tone || 'idle';
  }

  function renderCalls() {
    const box = el('liveCalls');
    const empty = el('liveEmpty');
    if (!box) return;
    if (!state.calls.length) {
      box.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    box.innerHTML = state.calls.map((call) => {
      const active = focused === call.id;
      const who = call.from || 'Unknown caller';
      return '<div class="live-call' + (active ? ' active' : '') + '" data-call="' + esc(call.id) + '" onclick="window.lolaLive && lolaLive.focusCall(\'' + esc(call.id) + '\')">' +
        '<span class="live-call-dir ' + esc(call.direction) + '">' + (call.direction === 'outbound' ? '→' : '←') + '</span>' +
        '<span class="live-call-who">' + esc(who) + '</span>' +
        '<span class="live-call-dur" data-dur="' + esc(call.id) + '">' + fmtDuration(liveSecs(call)) + '</span>' +
        '<span class="live-call-status">' + esc(call.status) + '</span>' +
        '<button class="live-takeover' + (pendingTakeover === call.id ? ' armed' : '') + '" data-call="' + esc(call.id) + '" onclick="event.stopPropagation(); window.lolaLive && lolaLive.takeOver(\'' + esc(call.id) + '\')">' + (pendingTakeover === call.id ? 'Confirm?' : 'Take over') + '</button>' +
        '</div>';
    }).join('');
  }

  function bubble(role, content, meta) {
    const side = role === 'client' || role === 'user' ? 'client' : 'lola';
    const who = meta?.who || (side === 'client' ? 'Client' : 'Lola');
    return '<div class="live-msg ' + side + '">' +
      '<div class="live-msg-who">' + esc(who) + '</div>' +
      '<div class="live-msg-body">' + esc(content) + '</div>' +
      '</div>';
  }

  function renderTranscript() {
    const feed = el('liveTranscript');
    if (!feed) return;
    const call = state.calls.find((c) => c.id === focused) || null;
    const t = call?.transcript;
    const msgs = Array.isArray(t) ? t : [];
    const ownerNotes = window.__lolaLiveOwnerNotes || [];
    const all = [
      ...msgs.map((m) => ({ role: String(m.role || m.speaker || 'client').toLowerCase(), content: m.content || m.text || '' })),
      ...ownerNotes.map((n) => ({ role: 'owner', content: n.text }))
    ];
    if (!all.length) {
      feed.innerHTML = '<div class="live-feed-silent">' +
        (call ? 'Call in progress — the transcript will stream here as Lola talks.' : 'Select a live call to read the conversation.') +
        '</div>';
      return;
    }
    feed.innerHTML = all.map((m) => bubble(m.role, m.content)).join('');
    feed.scrollTop = feed.scrollHeight;
  }

  function renderWhisper() {
    const input = el('whisperInput');
    const btn = el('whisperBtn');
    const hint = el('whisperHint');
    if (!input) return;
    const canWhisper = state.ready && state.whisper && !!state.whisper.conversationId;
    input.disabled = !canWhisper;
    btn.disabled = !canWhisper;
    if (hint) {
      // Transient feedback (takeover / whisper result) outlives one render
      // tick; the 8s poll must never clobber it while it is still fresh.
      if (state.note && Date.now() < state.note.until) {
        hint.style.display = '';
        hint.textContent = state.note.text;
        return;
      }
      state.note = null;
      const activeCall = state.calls.length > 0;
      hint.style.display = canWhisper ? 'none' : '';
      hint.textContent = state.ready
        ? (activeCall ? 'A call is live but no AI conversation is attached yet — call state still streams.' : 'No live conversation right now — whisper unlocks the moment Lola answers.')
        : 'Whisper needs the Telnyx AI assistant wired (TELNYX_API_KEY + TELNYX_ASSISTANT_ID). Live call state still streams below.';
    }
  }

  function render() {
    setPill(state.signedOut ? 'Sign in to view live calls'
      : state.paused ? 'Live feed paused'
      : state.calls.length
        ? (state.calls.length + (state.calls.length === 1 ? ' call live' : ' calls live'))
        : (state.whisper ? 'Whisper ready' : 'Standing by'),
      state.calls.length ? 'live' : (state.whisper ? 'ready' : 'idle'));
    if (!focused && state.calls.length) focused = state.calls[0].id;
    renderCalls();
    renderTranscript();
    renderWhisper();
    const meta = el('liveMeta');
    if (meta) {
      meta.innerHTML = state.tenant
        ? (state.ready ? 'Telnyx assistant connected' : 'Assistant not connected') + ' · ' + state.calls.length + ' call(s) live'
        : 'Live call state';
    }
  }

  async function refresh() {
    try {
      const { status, data } = await api('/api/live-conversations');
      if (status === 401 || status === 403) {
        state.calls = []; state.whisper = null; state.ready = false; state.tenant = '';
        state.paused = false; state.signedOut = true;
        render();
        return;
      }
      if (!data.ok) {
        // Endpoint unreachable (e.g. not deployed yet) — degrade the whole
        // panel, not just the pill: whisper must stay disabled + explained.
        state.calls = []; state.whisper = null; state.ready = false; state.tenant = '';
        state.signedOut = false; state.paused = true;
        render();
        return;
      }
      state.calls = data.active_calls || [];
      state.conversations = data.conversations || [];
      state.whisper = data.whisper_target || null;
      state.ready = !!data.telnyx_ready;
      state.tenant = data.tenant || '';
      state.paused = false; state.signedOut = false;
      if (focused && !state.calls.some((c) => c.id === focused)) focused = state.calls[0]?.id || null;
      render();
    } catch (e) {
      setPill('Live feed unavailable', 'idle');
    }
  }

  function startTicker() {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      const rows = document.querySelectorAll('.live-call-dur[data-dur]');
      rows.forEach((row) => {
        const call = state.calls.find((c) => c.id === row.dataset.dur);
        if (call) row.textContent = fmtDuration(liveSecs(call));
      });
    }, 1000);
  }

  async function whisper() {
    const input = el('whisperInput');
    const hint = el('whisperHint');
    const text = (input?.value || '').trim();
    if (!text) return;
    if (!state.whisper?.conversationId) {
      if (input) input.disabled = true;
      if (hint) { hint.style.display = ''; hint.textContent = 'No live conversation to whisper into yet — try again in a few seconds.'; }
      setTimeout(() => { if (input) input.disabled = false; }, 1200);
      return;
    }
    const { status, data } = await api('/api/live-conversations', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: state.whisper.conversationId, text })
    });
    if (status === 200 && data.ok) {
      window.__lolaLiveOwnerNotes = window.__lolaLiveOwnerNotes || [];
      window.__lolaLiveOwnerNotes.push({ text: 'Owner note · ' + text });
      if (window.__lolaLiveOwnerNotes.length > 40) window.__lolaLiveOwnerNotes.shift();
      if (input) input.value = '';
      state.note = { text: 'Whispered — Lola will act on it in her next turn.', until: Date.now() + 4000 };
      renderTranscript();
      renderWhisper();
    } else {
      state.note = { text: data?.error === 'whisper_failed' ? ('Whisper rejected by Telnyx: ' + (data.detail || 'unknown')) : (data?.error || 'Whisper failed'), until: Date.now() + 6000 };
      renderWhisper();
    }
  }

  async function takeOver(id) {
    // First click arms a two-step confirm so a stray tap can't yank a live
    // call off Lola; second click fires the Telnyx transfer.
    if (pendingTakeover !== id) {
      pendingTakeover = id;
      renderCalls();
      setTimeout(() => { if (pendingTakeover === id) { pendingTakeover = null; renderCalls(); } }, 6000);
      return;
    }
    pendingTakeover = null;
    renderCalls();
    const { status, data } = await api('/api/live-conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'takeover', call_id: id })
    });
    state.note = status === 200 && data.ok
      ? { text: 'Transferring to ' + (data.transferred?.to || 'your phone') + ' — answer when it rings.', until: Date.now() + 8000 }
      : { text: data?.detail || data?.error || 'Takeover failed', until: Date.now() + 6000 };
    renderWhisper();
  }

  function focusCall(id) {
    focused = id;
    renderCalls();
    renderTranscript();
  }

  async function init() {
    try {
      if (window.LolaAuth?.ready) auth = await window.LolaAuth.ready;
    } catch { auth = null; }
    if (!auth?.token) {
      setPill('Sign in to view live calls', 'idle');
      if (el('liveEmpty')) el('liveEmpty').textContent = 'Sign in to see live calls and steer Lola.';
      return;
    }
    window.lolaLive = { focusCall, whisper, takeOver, refresh };
    refresh();
    setInterval(refresh, POLL_MS);
    startTicker();
    // Re-resolve auth after refresh (token may be renewed); LolaAuth updates in place.
    if (window.LolaAuth?.ready) window.LolaAuth.ready.then((a) => { auth = a; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
