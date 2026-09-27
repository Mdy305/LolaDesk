/* Services page — CRUD service menu grouped by category. */
(function () {
  const wait = () => new Promise(r => { if (window.LolaShell) return r(); window.addEventListener('lola:shell-ready', r, { once: true }); });
  wait().then(main);

  async function main() {
    const S = window.LolaShell;
    S.initPage();
    let services = [];
    await load();

    document.getElementById('btn-new').onclick = () => openEdit(null);
    document.getElementById('btn-first').onclick = () => openEdit(null);
    document.getElementById('btn-import').onclick = () => S.toast('Booksy/Vagaro import coming soon', 'info');

    async function load() {
      const r = await S.fetchJson('/api/services');
      services = r.ok ? (r.data?.services || r.data || []) : [];
      render();
    }

    function render() {
      const empty = document.getElementById('empty');
      const cats = document.getElementById('cats');
      cats.innerHTML = '';
      if (!services.length) { empty.hidden = false; return; }
      empty.hidden = true;
      const byCat = {};
      for (const s of services) { const c = s.category || 'Services'; (byCat[c] ||= []).push(s); }
      Object.keys(byCat).sort().forEach(cat => {
        const wrap = S.el('div', 'svc-cat');
        const head = S.html('div', 'svc-cat-head', `<div class="svc-cat-title">${escHtml(cat)} <small>${byCat[cat].length}</small></div>`);
        const grid = S.el('div', 'svc-grid');
        byCat[cat].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).forEach(s => grid.append(card(s)));
        wrap.append(head, grid);
        cats.append(wrap);
      });
    }

    function card(s) {
      const c = S.el('div', 'svc-card' + (s.active === false ? ' inactive' : ''));
      const mins = s.duration_minutes || s.duration_min || 60;
      c.innerHTML = `
        <div class="svc-price">${S.fmtMoney(s.price_cents || 0)}</div>
        <h3 class="svc-name">${escHtml(s.name)}</h3>
        <div class="svc-meta">
          <span>${mins} min</span>
          ${s.deposit_cents ? `<span class="dot">·</span><span>Deposit ${S.fmtMoney(s.deposit_cents)}</span>` : ''}
          ${s.buffer_minutes ? `<span class="dot">·</span><span>+${s.buffer_minutes}m buffer</span>` : ''}
        </div>
        ${s.description ? `<p class="svc-desc">${escHtml(s.description)}</p>` : ''}
        <div class="svc-badges">
          ${s.active === false ? '<span class="ld-chip">Paused</span>' : '<span class="ld-chip ok">Active</span>'}
          ${s.online_bookable === false ? '<span class="ld-chip">In-salon only</span>' : ''}
          ${s.staff_only ? '<span class="ld-chip warn">Staff-only</span>' : ''}
        </div>
      `;
      c.onclick = () => openEdit(s);
      return c;
    }

    async function openEdit(svc) {
      const isNew = !svc;
      const s = svc || { name: '', category: '', duration_minutes: 60, price_cents: 0, deposit_cents: 0, buffer_minutes: 0, description: '', active: true, online_bookable: true };
      const form = S.el('div');
      form.innerHTML = `
        <label class="ld-label">Name</label>
        <input class="ld-input" id="f-name" value="${escAttr(s.name || '')}" placeholder="Balayage, Deep tissue, Signature facial…">
        <div class="svc-form-row">
          <div>
            <label class="ld-label">Category</label>
            <input class="ld-input" id="f-cat" value="${escAttr(s.category || '')}" placeholder="Hair · Nails · Skin">
          </div>
          <div>
            <label class="ld-label">Duration (min)</label>
            <input class="ld-input" type="number" id="f-dur" value="${s.duration_minutes || s.duration_min || 60}" min="5" step="5">
          </div>
        </div>
        <div class="svc-form-row">
          <div>
            <label class="ld-label">Price</label>
            <input class="ld-input" type="number" id="f-price" value="${((s.price_cents||0)/100).toFixed(2)}" step="0.01" min="0">
          </div>
          <div>
            <label class="ld-label">Deposit</label>
            <input class="ld-input" type="number" id="f-dep" value="${((s.deposit_cents||0)/100).toFixed(2)}" step="0.01" min="0">
          </div>
        </div>
        <label class="ld-label">Buffer after (min)</label>
        <input class="ld-input" type="number" id="f-buf" value="${s.buffer_minutes || 0}" min="0" step="5">
        <label class="ld-label">Description (optional)</label>
        <textarea class="ld-textarea" id="f-desc" placeholder="What clients get. Lola may read this on calls.">${escHtml(s.description || '')}</textarea>
        <div style="margin-top:14px;display:flex;gap:16px;align-items:center;justify-content:space-between">
          <div>
            <div style="font:500 15px -apple-system,sans-serif">Active</div>
            <div style="font:400 13px -apple-system,sans-serif;color:var(--text2)">Lola books this service</div>
          </div>
          <div class="ld-toggle${s.active !== false ? ' on' : ''}" id="f-active"></div>
        </div>
        <div style="margin-top:6px;display:flex;gap:16px;align-items:center;justify-content:space-between">
          <div>
            <div style="font:500 15px -apple-system,sans-serif">Bookable online</div>
            <div style="font:400 13px -apple-system,sans-serif;color:var(--text2)">Show on public booking widget</div>
          </div>
          <div class="ld-toggle${s.online_bookable !== false ? ' on' : ''}" id="f-online"></div>
        </div>
      `;
      form.querySelectorAll('.ld-toggle').forEach(t => t.onclick = () => t.classList.toggle('on'));

      const actions = [
        { label: 'Cancel', value: null },
      ];
      if (!isNew) actions.push({ label: 'Delete', danger: true, onClick: async () => {
        if (!await S.confirm('Delete this service? Bookings already using it will still work.', { danger: true, confirmLabel: 'Delete' })) return;
        const r = await S.api(`/api/services/${s.id}`, {}, 'DELETE');
        if (!r.ok) { S.toast('Delete failed: ' + r.error, 'dan'); return; }
        S.toast('Service deleted'); await load(); return null;
      }});
      actions.push({ label: isNew ? 'Create' : 'Save', primary: true, onClick: async () => {
        const payload = {
          name: form.querySelector('#f-name').value.trim(),
          category: form.querySelector('#f-cat').value.trim() || null,
          duration_minutes: parseInt(form.querySelector('#f-dur').value, 10) || 60,
          price_cents: Math.round(parseFloat(form.querySelector('#f-price').value || '0') * 100),
          deposit_cents: Math.round(parseFloat(form.querySelector('#f-dep').value || '0') * 100),
          buffer_minutes: parseInt(form.querySelector('#f-buf').value, 10) || 0,
          description: form.querySelector('#f-desc').value.trim() || null,
          active: form.querySelector('#f-active').classList.contains('on'),
          online_bookable: form.querySelector('#f-online').classList.contains('on'),
        };
        if (!payload.name) { S.toast('Name is required', 'dan'); return; }
        const r = isNew
          ? await S.api('/api/services', payload)
          : await S.api(`/api/services/${s.id}`, payload, 'PATCH');
        if (!r.ok) { S.toast('Save failed: ' + r.error, 'dan'); return; }
        S.toast(isNew ? 'Service created' : 'Saved');
        await load(); return null;
      }});

      S.dialog({ title: isNew ? 'New service' : 'Edit service', body: form, actions });
    }
  }

  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escAttr(s) { return escHtml(s); }
})();
