/* ============================================================
   CLIENT PROFILE — LolaDesk
   Reads /client.html?id=<uuid> and renders one client.
   Tolerant of many endpoint shapes; degrades to empty state.
   ============================================================ */

(function () {
  'use strict';

  const clientId = new URLSearchParams(location.search).get('id') || '';
  if (!clientId) {
    // A client page with no client: go to the client list instead of a dead end.
    location.replace('/clients');
    return;
  }

  const state = {
    tab: 'overview',
    client: null,
    appointments: [],
    formulas: [],
    notes: [],
    conversations: [],
    photos: [],
    payments: [],
    tenant: null,
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt$ = c => `$${(Math.max(0, +c || 0) / 100).toFixed(2)}`;
  const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); };
  const fmtDT   = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); };
  const daysAgo = d => { if (!d) return null; return Math.round((Date.now() - new Date(d).getTime()) / 86400000); };
  const initials = name => String(name || '?').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase() || '?';

  // ── Boot ────────────────────────────────────────────────
  async function boot() {
    await Promise.all([loadClient(), loadAppointments(), loadFormulas(), loadNotes(), loadConversations(), loadPhotos(), loadPayments(), loadTenant()]);
    renderHead();
    renderTab();
    wireEvents();
  }

  async function loadTenant() {
    try {
      const r = await fetch('/api/settings', { credentials: 'include' });
      if (r.ok) state.tenant = await r.json();
    } catch {}
  }

  async function loadClient() {
    const endpoints = [
      `/api/clients/${encodeURIComponent(clientId)}`,
      `/api/clients?id=${encodeURIComponent(clientId)}`,
      `/api/crm?client_id=${encodeURIComponent(clientId)}`
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (r.status === 401) { location.href = '/login?next=/client.html?id=' + clientId; return; }
        if (!r.ok) continue;
        const d = await r.json();
        const row = d.client || d.data || (Array.isArray(d) ? d[0] : d);
        if (row && (row.id || row.name || row.phone)) { state.client = normalizeClient(row); return; }
      } catch (_) {}
    }
  }

  function normalizeClient(row) {
    return {
      id: row.id || clientId,
      name: row.name || row.full_name || row.client_name || 'Client',
      first_name: row.first_name || null,
      last_name: row.last_name || null,
      phone: row.phone || row.mobile || row.client_phone || '',
      email: row.email || '',
      birthday: row.birthday || row.date_of_birth || null,
      address: row.address || '',
      preferred_stylist: row.preferred_stylist || row.stylist || '',
      preferred_service: row.preferred_service || '',
      tags: Array.isArray(row.tags) ? row.tags : (row.tags ? String(row.tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      vip: !!(row.vip || row.is_vip),
      visit_count: parseInt(row.visit_count || row.total_visits || 0, 10) || 0,
      lifetime_cents: parseInt(row.lifetime_cents || row.lifetime_value || row.ltv_cents || 0, 10) || 0,
      last_visit_at: row.last_visit_at || row.last_visit || null,
      next_visit_at: row.next_visit_at || row.next_appointment || null,
      cadence_days: parseInt(row.cadence_days || row.avg_days_between_visits || 0, 10) || 0,
      avatar_url: row.avatar_url || row.photo_url || null,
      created_at: row.created_at || null,
      notes: row.notes || '',
      raw: row,
    };
  }

  async function loadAppointments() {
    for (const ep of [
      `/api/appointments?client_id=${encodeURIComponent(clientId)}&limit=50`,
      `/api/calendar?client_id=${encodeURIComponent(clientId)}&limit=50`,
      `/api/clients/${encodeURIComponent(clientId)}/appointments`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.appointments || d.rows || d.data || []);
        if (rows.length) { state.appointments = rows; return; }
      } catch (_) {}
    }
  }

  async function loadFormulas() {
    for (const ep of [
      `/api/clients/${encodeURIComponent(clientId)}/formulas`,
      `/api/crm/formulas?client_id=${encodeURIComponent(clientId)}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.formulas || d.rows || d.data || []);
        if (rows.length) { state.formulas = rows; return; }
      } catch (_) {}
    }
  }

  async function loadNotes() {
    for (const ep of [
      `/api/clients/${encodeURIComponent(clientId)}/notes`,
      `/api/crm/notes?client_id=${encodeURIComponent(clientId)}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.notes || d.rows || d.data || []);
        if (rows.length) { state.notes = rows; return; }
      } catch (_) {}
    }
  }

  async function loadConversations() {
    for (const ep of [
      `/api/inbox/threads?client_id=${encodeURIComponent(clientId)}`,
      `/api/inbox/messages?client_id=${encodeURIComponent(clientId)}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.threads || d.messages || d.rows || d.data || []);
        if (rows.length) { state.conversations = rows; return; }
      } catch (_) {}
    }
  }

  async function loadPhotos() {
    for (const ep of [
      `/api/clients/${encodeURIComponent(clientId)}/photos`,
      `/api/client-photo?client_id=${encodeURIComponent(clientId)}`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.photos || d.rows || d.data || []);
        if (rows.length) { state.photos = rows; return; }
      } catch (_) {}
    }
  }

  async function loadPayments() {
    for (const ep of [
      `/api/stripe/payments?client_id=${encodeURIComponent(clientId)}&limit=50`,
      `/api/clients/${encodeURIComponent(clientId)}/payments`
    ]) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.payments || d.rows || d.data || []);
        if (rows.length) { state.payments = rows; return; }
      } catch (_) {}
    }
  }

  // ── Head ─────────────────────────────────────────────────
  function renderHead() {
    const c = state.client;
    if (!c) {
      document.getElementById('cpName').textContent = 'Client not found';
      return;
    }
    document.getElementById('cpName').textContent = c.name;
    const parts = [];
    if (c.phone) parts.push(c.phone);
    if (c.email) parts.push(c.email);
    if (c.birthday) parts.push('Birthday ' + fmtDate(c.birthday));
    document.getElementById('cpSub').textContent = parts.join(' · ');

    // Tags
    const tagsEl = document.getElementById('cpTags');
    const tagsOut = [];
    if (c.vip) tagsOut.push('<span class="tag vip">VIP</span>');
    if (c.visit_count >= 10) tagsOut.push('<span class="tag regular">Regular</span>');
    if (c.visit_count === 0 || c.visit_count === 1) tagsOut.push('<span class="tag new">New</span>');
    const d = daysAgo(c.last_visit_at);
    if (d !== null && d > 90) tagsOut.push('<span class="tag risk">Lapsed ' + d + 'd</span>');
    (c.tags || []).forEach(t => tagsOut.push(`<span class="tag">${esc(t)}</span>`));
    tagsEl.innerHTML = tagsOut.join('');

    // Avatar
    const av = document.getElementById('cpAvatar');
    if (c.avatar_url) av.innerHTML = `<img src="${esc(c.avatar_url)}" alt="">`;
    else av.textContent = initials(c.name);

    // Stats
    document.getElementById('statLifetime').textContent = c.lifetime_cents ? fmt$(c.lifetime_cents) : '$0';
    document.getElementById('statVisits').textContent   = c.visit_count || (state.appointments.filter(a => (a.status || 'confirmed') !== 'cancelled').length);
    document.getElementById('statLast').textContent     = c.last_visit_at ? (daysAgo(c.last_visit_at) + 'd ago') : '—';
    document.getElementById('statDue').textContent      = c.next_visit_at ? fmtDate(c.next_visit_at) : (c.cadence_days && c.last_visit_at ? nextDue(c) : '—');
  }
  function nextDue(c) {
    const last = new Date(c.last_visit_at);
    const due = new Date(last.getTime() + c.cadence_days * 86400000);
    const overdue = due < new Date();
    return (overdue ? 'Overdue · ' : '') + fmtDate(due);
  }

  // ── Tabs ─────────────────────────────────────────────────
  function wireEvents() {
    document.querySelectorAll('.cp-tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.cp-tab').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        state.tab = b.dataset.tab;
        renderTab();
      });
    });
    document.getElementById('btnBook').addEventListener('click', bookAppt);
    document.getElementById('btnText').addEventListener('click', sendText);
    document.getElementById('btnCall').addEventListener('click', callBack);
    document.getElementById('btnDeposit').addEventListener('click', sendDeposit);
  }

  function renderTab() {
    document.querySelectorAll('.cp-pane').forEach(p => p.classList.remove('on'));
    const paneId = 'pane' + state.tab[0].toUpperCase() + state.tab.slice(1);
    const pane = document.getElementById(paneId);
    if (!pane) return;
    pane.classList.add('on');

    if (state.tab === 'overview')      renderOverview(pane);
    if (state.tab === 'history')       renderHistory(pane);
    if (state.tab === 'formulas')      renderFormulas(pane);
    if (state.tab === 'notes')         renderNotes(pane);
    if (state.tab === 'conversations') renderConversations(pane);
    if (state.tab === 'photos')        renderPhotos(pane);
    if (state.tab === 'payments')      renderPayments(pane);
  }

  // ── Overview ─────────────────────────────────────────────
  function renderOverview(el) {
    const c = state.client || {};
    const recent = state.appointments.slice(0, 3);
    const latestFormula = state.formulas[0];
    const latestNote = state.notes[0];

    el.innerHTML = `
      <div class="cp-grid">
        <div>
          <div class="card">
            <div class="card-head">Details</div>
            <div>
              <div class="field"><span class="field-label">Phone</span><span class="field-value">${esc(c.phone || '—')}</span></div>
              <div class="field"><span class="field-label">Email</span><span class="field-value">${esc(c.email || '—')}</span></div>
              <div class="field"><span class="field-label">Birthday</span><span class="field-value">${esc(c.birthday ? fmtDate(c.birthday) : '—')}</span></div>
              <div class="field"><span class="field-label">Address</span><span class="field-value">${esc(c.address || '—')}</span></div>
              <div class="field"><span class="field-label">Preferred stylist</span><span class="field-value">${esc(c.preferred_stylist || '—')}</span></div>
              <div class="field"><span class="field-label">Preferred service</span><span class="field-value">${esc(c.preferred_service || '—')}</span></div>
              <div class="field"><span class="field-label">Client since</span><span class="field-value">${esc(c.created_at ? fmtDate(c.created_at) : '—')}</span></div>
            </div>
          </div>

          ${recent.length ? `
            <div class="card">
              <div class="card-head">Recent visits</div>
              <div>${recent.map(apptRow).join('')}</div>
            </div>
          ` : ''}
        </div>

        <div>
          ${latestFormula ? `
            <div class="card">
              <div class="card-head">Latest formula</div>
              <div class="formula-when">${esc(fmtDate(latestFormula.created_at || latestFormula.date))}</div>
              <div class="formula-body">${esc(latestFormula.formula || latestFormula.text || latestFormula.body || '')}</div>
            </div>
          ` : ''}

          ${latestNote ? `
            <div class="card">
              <div class="card-head">Latest note</div>
              <div class="note-when">${esc(fmtDT(latestNote.created_at))}</div>
              <div>${esc(latestNote.body || latestNote.text || latestNote.note || '')}</div>
            </div>
          ` : ''}

          ${c.notes ? `
            <div class="card">
              <div class="card-head">On file</div>
              <div class="card-body">${esc(c.notes)}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  function apptRow(a) {
    const when = fmtDT(a.start_time || a.starts_at || a.created_at);
    const service = a.service || a.service_name || a.service_title || '';
    const stylist = a.stylist_name || a.stylist || '';
    const status = (a.status || 'confirmed').toLowerCase();
    const amt = parseInt(a.price_cents || a.total_cents || 0, 10) || 0;
    const statusCls = status === 'cancelled' ? 'cancelled' : status === 'no_show' || status === 'no-show' ? 'no-show' : '';
    return `
      <div class="appt-row">
        <div class="appt-when">${esc(when)}</div>
        <div>
          <div class="appt-svc-name">${esc(service)}${status !== 'confirmed' ? '<span class="appt-status ' + statusCls + '">' + esc(status) + '</span>' : ''}</div>
          <div class="appt-svc-sub">${esc(stylist)}</div>
        </div>
        <div class="appt-amt">${amt ? fmt$(amt) : ''}</div>
      </div>
    `;
  }

  // ── History / Formulas / Notes / Conversations / Photos / Payments ─
  function renderHistory(el) {
    if (!state.appointments.length) { el.innerHTML = `<div class="card"><div class="empty">No visits yet.</div></div>`; return; }
    el.innerHTML = `<div class="card"><div class="card-head">All visits (${state.appointments.length})</div>${state.appointments.map(apptRow).join('')}</div>`;
  }

  function renderFormulas(el) {
    if (!state.formulas.length) {
      el.innerHTML = `<div class="card"><div class="empty">No formulas recorded yet. Add one from an appointment.</div></div>`;
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-head">Formulas (${state.formulas.length})</div>${
      state.formulas.map(f => `
        <div class="formula-row">
          <div class="formula-when">${esc(fmtDate(f.created_at || f.date))}${f.stylist ? ' · ' + esc(f.stylist) : ''}${f.service ? ' · ' + esc(f.service) : ''}</div>
          <div class="formula-body">${esc(f.formula || f.text || f.body || '')}</div>
        </div>
      `).join('')
    }</div>`;
  }

  function renderNotes(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-head">Notes</div>
        <div class="note-add">
          <textarea id="noteText" class="note-input" placeholder="Add a note about ${esc(state.client?.name || 'this client')}…"></textarea>
          <button id="btnAddNote">Save</button>
        </div>
        ${state.notes.length ? state.notes.map(n => `
          <div class="note-row">
            <div class="note-when">${esc(fmtDT(n.created_at))}${n.author ? ' · ' + esc(n.author) : ''}</div>
            <div>${esc(n.body || n.text || n.note || '')}</div>
          </div>
        `).join('') : '<div class="empty">No notes yet.</div>'}
      </div>
    `;
    document.getElementById('btnAddNote').addEventListener('click', addNote);
  }

  function renderConversations(el) {
    if (!state.conversations.length) {
      el.innerHTML = `<div class="card"><div class="empty">No Lola conversations yet.</div></div>`;
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-head">Conversations with Lola</div>${
      state.conversations.map(c2 => `
        <div class="conv-row">
          <div class="conv-when">${esc(fmtDT(c2.created_at || c2.updated_at))}<span class="conv-channel">${esc((c2.channel || 'chat').slice(0, 8))}</span></div>
          <div class="conv-text">${esc((c2.snippet || c2.last_message || c2.body || c2.text || '').slice(0, 400))}</div>
        </div>
      `).join('')
    }</div>`;
  }

  function renderPhotos(el) {
    if (!state.photos.length) {
      el.innerHTML = `<div class="card"><div class="empty">No photos yet.</div></div>`;
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-head">Photos (${state.photos.length})</div><div class="photo-grid">${
      state.photos.map(p => `
        <a class="photo-cell" href="${esc(p.url || p.photo_url)}" target="_blank" rel="noopener">
          <img src="${esc(p.url || p.photo_url)}" alt="">
          ${p.created_at ? `<div class="photo-when">${esc(fmtDate(p.created_at))}</div>` : ''}
        </a>
      `).join('')
    }</div></div>`;
  }

  function renderPayments(el) {
    if (!state.payments.length) {
      el.innerHTML = `<div class="card"><div class="empty">No payments recorded.</div></div>`;
      return;
    }
    const total = state.payments.reduce((s, p) => s + (parseInt(p.amount || p.amount_cents || 0, 10) || 0), 0);
    el.innerHTML = `<div class="card"><div class="card-head">Payments · Total ${fmt$(total)}</div>${
      state.payments.map(p => `
        <div class="pay-row">
          <div>
            <div>${esc(p.description || p.service || 'Payment')}</div>
            <div class="pay-when">${esc(fmtDate(p.created * 1000 || p.created_at))}</div>
          </div>
          <div class="pay-amt">${fmt$(p.amount || p.amount_cents || 0)}</div>
          <div class="pay-status ${(p.status || 'paid').includes('refund') ? 'refunded' : 'paid'}">${esc(p.status || 'paid')}</div>
        </div>
      `).join('')
    }</div>`;
  }

  // ── Actions ──────────────────────────────────────────────
  async function bookAppt() {
    // Just jump to calendar with client preselected
    location.href = `/calendar.html?book_client=${encodeURIComponent(clientId)}`;
  }

  async function sendText() {
    if (!state.client?.phone) { alert('No phone on file.'); return; }
    const text = prompt('Text to send:', state.client.first_name ? `Hi ${state.client.first_name}, ` : '');
    if (!text) return;
    try {
      const r = await fetch('/api/inbox/send', {
        method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({ to: state.client.phone, body: text, client_id: clientId })
      });
      if (r.ok) alert('Sent.');
      else alert('Failed: ' + r.status);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function callBack() {
    if (!state.client?.phone) { alert('No phone on file.'); return; }
    try {
      const r = await fetch('/api/call-center/callback', {
        method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({ phone: state.client.phone, client_id: clientId, client_name: state.client.name, reason: 'manual' })
      });
      if (r.ok) alert('Callback started. Your phone will ring.');
      else alert('Failed: ' + r.status);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function sendDeposit() {
    if (!state.client?.phone && !state.client?.email) { alert('No phone or email on file.'); return; }
    const amt = prompt('Deposit amount ($):', '25');
    if (!amt) return;
    const cents = Math.round(parseFloat(amt) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { alert('Bad amount.'); return; }
    try {
      const r = await fetch('/api/pos/charge', {
        method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
        body: JSON.stringify({
          items: [{ id:'dep', name:'Deposit', qty:1, price_cents: cents }],
          subtotal_cents: cents, tax_cents: 0, tip_cents: 0, total_cents: cents,
          payment_method: 'link',
          client: { id: clientId, name: state.client.name, phone: state.client.phone, email: state.client.email },
          delivery: { phone: state.client.phone, email: state.client.email }
        })
      });
      const d = await r.json();
      if (r.ok && d.ok !== false) alert('Deposit link sent.');
      else alert('Failed: ' + (d.error || r.status));
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function addNote() {
    const text = document.getElementById('noteText').value.trim();
    if (!text) return;
    for (const ep of [
      `/api/clients/${encodeURIComponent(clientId)}/notes`,
      `/api/crm/notes`
    ]) {
      try {
        const r = await fetch(ep, {
          method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include',
          body: JSON.stringify({ client_id: clientId, body: text, text })
        });
        if (r.ok) {
          document.getElementById('noteText').value = '';
          state.notes.unshift({ body: text, created_at: new Date().toISOString(), author: 'You' });
          renderNotes(document.getElementById('paneNotes'));
          return;
        }
      } catch (_) {}
    }
    // Local fallback
    state.notes.unshift({ body: text, created_at: new Date().toISOString(), author: 'You (local only)' });
    document.getElementById('noteText').value = '';
    renderNotes(document.getElementById('paneNotes'));
  }

  boot();
  console.info('[client-profile] ready');
})();
