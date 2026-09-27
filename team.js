(function () {
  const wait = () => new Promise(r => window.LolaShell ? r() : window.addEventListener('lola:shell-ready', r, { once: true }));
  wait().then(main);

  const DOWS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  async function main() {
    const S = window.LolaShell;
    S.initPage();
    let team = [];
    await load();
    document.getElementById('btn-new').onclick = () => openEdit(null);
    document.getElementById('btn-first').onclick = () => openEdit(null);

    async function load() {
      const r = await S.fetchJson('/api/team');
      team = r.ok ? (r.data?.members || r.data || []) : [];
      render();
    }

    function render() {
      const grid = document.getElementById('grid');
      const empty = document.getElementById('empty');
      grid.innerHTML = '';
      if (!team.length) { empty.hidden = false; return; }
      empty.hidden = true;
      team.forEach(m => grid.append(card(m)));
    }

    function card(m) {
      const c = S.el('div', 'ld-card tm-card');
      c.onclick = () => openEdit(m);
      const initials = (m.name || '?').split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase()).join('');
      const days = Array.isArray(m.working_days) ? m.working_days : [];
      c.innerHTML = `
        <div class="tm-avatar">${initials}</div>
        <div class="tm-body">
          <div class="tm-name">${esc(m.name)}</div>
          <div class="tm-role">${esc(m.role || 'Stylist')} ${m.commission_pct != null ? `· ${m.commission_pct}% commission` : ''}</div>
          <div class="tm-stats">
            <div class="tm-stat"><div class="v">${m.upcoming_appts || 0}</div><div class="k">Upcoming</div></div>
            <div class="tm-stat"><div class="v">${S.fmtMoney(m.revenue_month_cents || 0)}</div><div class="k">This month</div></div>
            <div class="tm-stat"><div class="v">${m.rating ? m.rating.toFixed(1) + '★' : '—'}</div><div class="k">Rating</div></div>
          </div>
          <div class="tm-avail">
            ${DOWS.map((d, i) => `<div class="tm-day${days.includes(i) ? ' on' : ''}">${d}</div>`).join('')}
          </div>
        </div>
      `;
      return c;
    }

    async function openEdit(m) {
      const isNew = !m;
      const cur = m || { name: '', role: 'Stylist', phone: '', email: '', commission_pct: 50, working_days: [1,2,3,4,5], active: true };
      const form = S.el('div');
      form.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label class="ld-label">Name</label>
            <input class="ld-input" id="f-name" value="${escAttr(cur.name || '')}">
          </div>
          <div>
            <label class="ld-label">Role</label>
            <input class="ld-input" id="f-role" value="${escAttr(cur.role || 'Stylist')}">
          </div>
          <div>
            <label class="ld-label">Phone</label>
            <input class="ld-input" id="f-phone" value="${escAttr(cur.phone || '')}" placeholder="+1 305 555 …">
          </div>
          <div>
            <label class="ld-label">Email</label>
            <input class="ld-input" id="f-email" value="${escAttr(cur.email || '')}">
          </div>
          <div>
            <label class="ld-label">Commission %</label>
            <input class="ld-input" type="number" id="f-comm" value="${cur.commission_pct ?? 50}" min="0" max="100" step="1">
          </div>
          <div>
            <label class="ld-label">Booking color</label>
            <input class="ld-input" type="color" id="f-color" value="${cur.color || '#ccff00'}">
          </div>
        </div>
        <label class="ld-label">Working days</label>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px" id="f-days">
          ${DOWS.map((d, i) => `<button type="button" class="ld-btn ${cur.working_days?.includes(i) ? 'pri' : ''}" data-day="${i}" style="padding:8px 0">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i]}</button>`).join('')}
        </div>
        <div style="margin-top:14px;display:flex;gap:16px;align-items:center;justify-content:space-between">
          <div>
            <div style="font:500 15px -apple-system,sans-serif">Active</div>
            <div style="font:400 13px -apple-system,sans-serif;color:var(--text2)">Show in booking</div>
          </div>
          <div class="ld-toggle${cur.active !== false ? ' on' : ''}" id="f-active"></div>
        </div>
      `;
      form.querySelectorAll('[data-day]').forEach(b => b.onclick = (e) => { e.preventDefault(); b.classList.toggle('pri'); });
      form.querySelector('#f-active').onclick = (e) => { e.currentTarget.classList.toggle('on'); };

      const actions = [{ label: 'Cancel', value: null }];
      if (!isNew) actions.push({ label: 'Delete', danger: true, onClick: async () => {
        if (!await S.confirm('Remove this staff member? Their past appointments stay.', { danger: true, confirmLabel: 'Remove' })) return;
        const r = await S.api(`/api/team/${m.id}`, {}, 'DELETE');
        if (!r.ok) return S.toast('Delete failed: ' + r.error, 'dan');
        S.toast('Removed'); await load(); return null;
      }});
      actions.push({ label: isNew ? 'Add' : 'Save', primary: true, onClick: async () => {
        const payload = {
          name: form.querySelector('#f-name').value.trim(),
          role: form.querySelector('#f-role').value.trim() || 'Stylist',
          phone: form.querySelector('#f-phone').value.trim() || null,
          email: form.querySelector('#f-email').value.trim() || null,
          commission_pct: parseInt(form.querySelector('#f-comm').value, 10) || 0,
          color: form.querySelector('#f-color').value,
          working_days: [...form.querySelectorAll('[data-day].pri')].map(b => parseInt(b.dataset.day, 10)),
          active: form.querySelector('#f-active').classList.contains('on'),
        };
        if (!payload.name) return S.toast('Name required', 'dan');
        const r = isNew ? await S.api('/api/team', payload) : await S.api(`/api/team/${m.id}`, payload, 'PATCH');
        if (!r.ok) return S.toast('Save failed: ' + r.error, 'dan');
        S.toast(isNew ? 'Added' : 'Saved'); await load(); return null;
      }});
      S.dialog({ title: isNew ? 'Add staff' : 'Edit ' + cur.name, body: form, actions });
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escAttr(s) { return esc(s); }
})();
