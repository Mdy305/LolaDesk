/* ============================================================
   POS — LolaDesk register
   Card / cash / send payment link · services + products + gift.
   ============================================================ */

(function () {
  'use strict';

  const state = {
    tab: 'services',
    query: '',
    services: [],
    products: [],
    giftCards: [
      { id: 'gc25',  name: 'Gift card', sub: '$25',  price_cents: 2500,  category: 'gift' },
      { id: 'gc50',  name: 'Gift card', sub: '$50',  price_cents: 5000,  category: 'gift' },
      { id: 'gc100', name: 'Gift card', sub: '$100', price_cents: 10000, category: 'gift' },
      { id: 'gc200', name: 'Gift card', sub: '$200', price_cents: 20000, category: 'gift' },
    ],
    cart: [],                            // [{ id, name, sub, price_cents, qty, kind }]
    client: null,                        // {id, name, phone, email}
    tipMode: '20',
    tipCents: 0,
    taxRate: 0,                          // set from /api/settings if available
  };

  // ── Money helpers ────────────────────────────────────────
  const fmt = c => `$${(Math.max(0, c) / 100).toFixed(2)}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ── Boot ─────────────────────────────────────────────────
  async function boot() {
    // Tenant name in header
    try {
      const r = await fetch('/api/settings', { credentials: 'include' });
      if (r.ok) {
        const s = await r.json().catch(() => ({}));
        document.getElementById('posTenant').textContent = s?.tenant_name || s?.name || 'Register';
        state.taxRate = parseFloat(s?.tax_rate || s?.sales_tax || 0) || 0;
      } else {
        document.getElementById('posTenant').textContent = 'Register';
      }
    } catch { document.getElementById('posTenant').textContent = 'Register'; }

    // Catalog
    await Promise.all([loadServices(), loadProducts()]);
    renderCatalog();
  }

  async function loadServices() {
    const endpoints = ['/api/services', '/api/widget/services'];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.services || d.rows || d.data || []);
        if (!rows.length) continue;
        state.services = rows.map(x => ({
          id: 'svc:' + (x.id || x.slug || x.name),
          name: x.name || x.title || 'Service',
          sub: x.duration_minutes ? `${x.duration_minutes} min` : (x.duration || ''),
          // services store price in dollars ($250), price_cents only when the source says so
          price_cents: x.price_cents != null ? Math.round(parseFloat(x.price_cents) || 0) : Math.round((parseFloat(x.price) || 0) * 100),
          kind: 'service',
          category: 'services'
        }));
        return;
      } catch (_) {}
    }
  }

  async function loadProducts() {
    // the real catalog lives at /api/salon?resource=products (same as Inventory)
    const endpoints = ['/api/salon?resource=products'];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, { credentials: 'include' });
        if (!r.ok) continue;
        const d = await r.json();
        const rows = Array.isArray(d) ? d : (d.products || d.items || d.rows || d.data || []);
        if (!rows.length) continue;
        state.products = rows.map(x => ({
          id: 'prd:' + (x.id || x.sku || x.name),
          name: x.name || x.title || 'Product',
          sub: x.sku || x.category || '',
          price_cents: x.price_cents != null ? Math.round(parseFloat(x.price_cents) || 0) : Math.round((parseFloat(x.price) || 0) * 100),
          kind: 'product',
          category: 'products'
        }));
        return;
      } catch (_) {}
    }
  }

  // ── Render catalog ───────────────────────────────────────
  function currentList() {
    if (state.tab === 'services') return state.services;
    if (state.tab === 'products') return state.products;
    if (state.tab === 'gift')     return state.giftCards;
    if (state.tab === 'quick')    return quickTiles();
    return [];
  }
  function quickTiles() {
    return [500, 1000, 1500, 2000, 2500, 3000, 5000, 7500, 10000, 15000].map(c => ({
      id: 'q:' + c,
      name: fmt(c),
      sub: 'Custom amount',
      price_cents: c,
      kind: 'custom',
      category: 'quick'
    }));
  }

  function renderCatalog() {
    const el = document.getElementById('posGrid');
    const list = currentList().filter(it => {
      if (!state.query) return true;
      return (it.name + ' ' + (it.sub || '')).toLowerCase().includes(state.query.toLowerCase());
    });
    if (!list.length) {
      const msg = state.tab === 'services' ? 'No services configured. Add them in Services settings.'
        : state.tab === 'products' ? 'No products in inventory yet.'
        : 'Nothing here.';
      el.innerHTML = `<div class="pos-empty">${msg}</div>`;
      return;
    }
    el.innerHTML = list.map(it => `
      <button class="item" data-id="${esc(it.id)}">
        <div>
          <div class="item-name">${esc(it.name)}</div>
          <div class="item-sub">${esc(it.sub || '')}</div>
        </div>
        <div class="item-price">${fmt(it.price_cents)}</div>
      </button>
    `).join('');
    el.querySelectorAll('.item').forEach(b => {
      b.addEventListener('click', () => {
        const it = list.find(x => x.id === b.dataset.id);
        if (it) addToCart(it);
      });
    });
  }

  // ── Cart ──────────────────────────────────────────────────
  function addToCart(item) {
    const existing = state.cart.find(x => x.id === item.id);
    if (existing) existing.qty += 1;
    else state.cart.push({ ...item, qty: 1 });
    renderCart();
  }
  function changeQty(id, delta) {
    const row = state.cart.find(x => x.id === id);
    if (!row) return;
    row.qty += delta;
    if (row.qty <= 0) state.cart = state.cart.filter(x => x.id !== id);
    renderCart();
  }

  function renderCart() {
    const el = document.getElementById('cartItems');
    if (!state.cart.length) {
      el.innerHTML = `<li class="pos-cart-empty">Add items from the left to start a sale.</li>`;
    } else {
      el.innerHTML = state.cart.map(r => `
        <li class="cart-row" data-id="${esc(r.id)}">
          <div>
            <div class="cart-name">${esc(r.name)}</div>
            <div class="cart-sub">${esc(r.sub || '')}</div>
          </div>
          <div class="cart-qty">
            <button data-op="minus">−</button>
            <span class="n">${r.qty}</span>
            <button data-op="plus">+</button>
          </div>
          <div class="cart-price">${fmt(r.price_cents * r.qty)}</div>
        </li>
      `).join('');
      el.querySelectorAll('.cart-row').forEach(row => {
        row.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => changeQty(row.dataset.id, btn.dataset.op === 'plus' ? +1 : -1));
        });
      });
    }
    updateTotals();
  }

  function updateTotals() {
    const subtotal = state.cart.reduce((s, r) => s + r.price_cents * r.qty, 0);
    const tax = Math.round(subtotal * state.taxRate);
    // Tip is on the pre-tax subtotal, standard salon practice
    let tip = 0;
    if (state.tipMode === 'custom') tip = state.tipCents;
    else if (state.tipMode !== '0')  tip = Math.round(subtotal * (parseInt(state.tipMode, 10) / 100));
    state.tipCents = tip;
    const total = subtotal + tax + tip;

    document.getElementById('sumSubtotal').textContent = fmt(subtotal);
    document.getElementById('sumTax').textContent = fmt(tax);
    document.getElementById('sumTip').textContent = fmt(tip);
    document.getElementById('sumTotal').textContent = fmt(total);

    ['payCard','payCash','payLink'].forEach(id => {
      document.getElementById(id).disabled = subtotal === 0;
      document.getElementById(id).style.opacity = subtotal === 0 ? 0.4 : 1;
    });
  }

  function totalCents() {
    const subtotal = state.cart.reduce((s, r) => s + r.price_cents * r.qty, 0);
    const tax = Math.round(subtotal * state.taxRate);
    return { subtotal, tax, tip: state.tipCents, total: subtotal + tax + state.tipCents };
  }

  // ── Tabs, search ─────────────────────────────────────────
  document.querySelectorAll('.pos-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.pos-tab').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      state.tab = b.dataset.tab;
      renderCatalog();
    });
  });
  document.getElementById('catSearch').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderCatalog();
  });

  // ── Tip controls ─────────────────────────────────────────
  document.querySelectorAll('.tip-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.tip === 'custom') {
        const val = prompt('Custom tip in dollars (e.g. 8.50):');
        if (val === null) return;
        const cents = Math.round(parseFloat(val) * 100);
        if (!Number.isFinite(cents) || cents < 0) return;
        state.tipMode = 'custom';
        state.tipCents = cents;
      } else {
        state.tipMode = b.dataset.tip;
      }
      document.querySelectorAll('.tip-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      updateTotals();
    });
  });

  // ── Client assignment ────────────────────────────────────
  document.getElementById('btnAssignClient').addEventListener('click', async () => {
    const q = prompt('Client phone or name:');
    if (!q) return;
    try {
      const r = await fetch('/api/widget/client-lookup?q=' + encodeURIComponent(q), { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      const c = d.client || d.data || (Array.isArray(d) ? d[0] : null);
      if (c) {
        state.client = { id: c.id, name: c.name || c.full_name || q, phone: c.phone || '', email: c.email || '' };
      } else {
        state.client = { id: null, name: q, phone: /^\+?\d{7,}$/.test(q.replace(/\D/g,'')) ? q : '', email: '' };
      }
      document.getElementById('cartClient').textContent = state.client.name;
    } catch {
      state.client = { id: null, name: q, phone: '', email: '' };
      document.getElementById('cartClient').textContent = q;
    }
  });

  // ── Payment: Card ────────────────────────────────────────
  document.getElementById('payCard').addEventListener('click', () => openCardModal());
  document.getElementById('payCash').addEventListener('click', () => openCashModal());
  document.getElementById('payLink').addEventListener('click', () => openLinkModal());

  function openModal(html) {
    const m = document.getElementById('payModal');
    document.getElementById('payBody').innerHTML = html;
    m.hidden = false;
  }
  function closeModal() { document.getElementById('payModal').hidden = true; }
  document.getElementById('payClose').addEventListener('click', closeModal);
  document.getElementById('receiptClose').addEventListener('click', () => document.getElementById('receiptModal').hidden = true);

  // ── Card at the front desk (api/pos/reader.js · lib/terminal.js) ─────
  // One paired Stripe reader: the sale goes to it, the client taps or inserts,
  // and this screen turns to "Paid" on its own. No reader yet: pair it here once.
  let readerInfo = null;
  const lastReader = () => { try { return localStorage.getItem('loladesk_reader') || ''; } catch (_) { return ''; } };
  const keepReader = (id) => { try { localStorage.setItem('loladesk_reader', id); } catch (_) {} };
  async function readerApi(body) {
    const r = await fetch('/api/pos/reader', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const d = await r.json().catch(() => ({}));
    return d;
  }

  async function openCardModal() {
    const { total } = totalCents();
    openModal(`<h3>Card payment</h3><div class="amount">${fmt(total)}</div><div id="cardBody"><p>Finding your card reader…</p></div><div id="payStatus"></div>`);
    readerInfo = await readerApi();
    if (readerInfo.ok === false) { document.getElementById('cardBody').innerHTML = `<p>${esc(readerInfo.say || 'Card payments aren’t available right now.')}</p><div class="pay-actions"><button id="cardCancel">Close</button><button class="primary" id="cardToLink">Send a pay link instead</button></div>`; wireFallback(); return; }
    const readers = readerInfo.readers || [];
    if (!readers.length) return showPair();
    const pick = readers.find((r) => r.id === lastReader()) || readers[0];
    document.getElementById('cardBody').innerHTML = `
      ${readers.length > 1 ? `<select class="pay-input" id="readerPick">${readers.map((r) => `<option value="${esc(r.id)}"${r.id === pick.id ? ' selected' : ''}>${esc(r.label)}${r.status === 'offline' ? ' (offline)' : ''}</option>`).join('')}</select>` : `<p>${esc(pick.label)}${pick.status === 'offline' ? ' · offline' : ''}</p>`}
      ${readerInfo.card_fee ? `<p style="font-size:12px;color:var(--pos-ink-mute)">Card fee ${esc(readerInfo.card_fee)}</p>` : ''}
      <div class="pay-actions"><button id="cardCancel">Cancel</button><button class="primary" id="cardSend">Send to reader</button></div>
      <p style="font-size:12px;color:var(--pos-ink-mute);text-align:center;margin-top:8px"><a href="#" id="cardPairAnother">Pair another reader</a></p>`;
    document.getElementById('cardCancel').addEventListener('click', closeModal);
    document.getElementById('cardPairAnother').addEventListener('click', (e) => { e.preventDefault(); showPair(); });
    document.getElementById('cardSend').addEventListener('click', () => {
      const sel = document.getElementById('readerPick');
      sendToReader(sel ? sel.value : pick.id);
    });
  }

  function wireFallback() {
    const c = document.getElementById('cardCancel'); if (c) c.addEventListener('click', closeModal);
    const l = document.getElementById('cardToLink'); if (l) l.addEventListener('click', () => { closeModal(); openLinkModal(); });
  }

  function showPair(needAddress) {
    document.getElementById('cardBody').innerHTML = `
      <p>Pair your Stripe card reader once. Turn it on, connect it to Wi-Fi, and enter the code it shows.</p>
      <input class="pay-input" id="pairCode" placeholder="Code on the reader (e.g. apple-grape-orange)" autocomplete="off">
      <input class="pay-input" id="pairLabel" placeholder="Name (e.g. Front desk)" autocomplete="off">
      <div id="pairAddr" ${needAddress ? '' : 'hidden'}>
        <p style="font-size:13px">Your salon address (once, for Stripe):</p>
        <input class="pay-input" id="addrLine1" placeholder="Street address" autocomplete="street-address">
        <input class="pay-input" id="addrCity" placeholder="City" autocomplete="address-level2">
        <input class="pay-input" id="addrState" placeholder="State (e.g. FL)" maxlength="2" autocomplete="address-level1">
        <input class="pay-input" id="addrZip" placeholder="ZIP code" inputmode="numeric" autocomplete="postal-code">
      </div>
      ${readerInfo && readerInfo.test_mode ? '<p style="font-size:12px;color:var(--pos-ink-mute)">Test mode: enter <b>simulated-wpe</b> for Stripe’s simulated reader.</p>' : ''}
      <div class="pay-actions"><button id="cardCancel">Not now</button><button class="primary" id="pairGo">Pair reader</button></div>
      <p style="font-size:12px;color:var(--pos-ink-mute);text-align:center;margin-top:8px"><a href="#" id="pairToLink">Send a pay link instead</a></p>`;
    document.getElementById('cardCancel').addEventListener('click', closeModal);
    document.getElementById('pairToLink').addEventListener('click', (e) => { e.preventDefault(); closeModal(); openLinkModal(); });
    document.getElementById('pairGo').addEventListener('click', async () => {
      const btn = document.getElementById('pairGo'), status = document.getElementById('payStatus');
      const code = document.getElementById('pairCode').value.trim();
      if (!code) { status.innerHTML = '<div class="pay-status err">Enter the code shown on the reader.</div>'; return; }
      const addrOn = !document.getElementById('pairAddr').hidden;
      const address = addrOn ? { line1: document.getElementById('addrLine1').value.trim(), city: document.getElementById('addrCity').value.trim(), state: document.getElementById('addrState').value.trim().toUpperCase(), postal_code: document.getElementById('addrZip').value.trim() } : undefined;
      btn.disabled = true; btn.textContent = 'Pairing…'; status.innerHTML = '';
      const d = await readerApi({ action: 'pair', code, label: document.getElementById('pairLabel').value.trim() || 'Front desk', address });
      if (d.address_needed) { document.getElementById('pairAddr').hidden = false; status.innerHTML = `<div class="pay-status">${esc(d.say)}</div>`; btn.disabled = false; btn.textContent = 'Pair reader'; return; }
      if (!d.ok) { status.innerHTML = `<div class="pay-status err">${esc(d.say || 'That didn’t pair. Check the code and try again.')}</div>`; btn.disabled = false; btn.textContent = 'Pair reader'; return; }
      keepReader(d.reader.id);
      openCardModal();
    });
  }

  async function sendToReader(readerId) {
    const { total } = totalCents();
    const status = document.getElementById('payStatus');
    const btn = document.getElementById('cardSend');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    keepReader(readerId);
    let sale;
    try {
      const r = await fetch('/api/pos/charge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...salePayload('card'), reader_id: readerId }) });
      sale = await r.json();
      if (!r.ok || sale.ok === false) throw new Error(sale.error || 'The reader didn’t take it.');
    } catch (err) {
      status.innerHTML = `<div class="pay-status err">${esc(err.message)}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      return;
    }
    const pi = sale.data.stripe_id;
    document.getElementById('cardBody').innerHTML = `
      <p>Ask the client to tap, insert or swipe on the reader.</p>
      <div class="pay-actions"><button id="cardStop">Cancel payment</button>${readerInfo && readerInfo.test_mode ? '<button id="cardSim">Simulate tap (test)</button>' : ''}</div>`;
    status.innerHTML = `<div class="pay-status">Waiting for the card… ${fmt(total)}</div>`;
    let done = false;
    document.getElementById('cardStop').addEventListener('click', async () => { done = true; await readerApi({ action: 'cancel', reader_id: readerId, payment_intent: pi }); status.innerHTML = '<div class="pay-status err">Payment cancelled.</div>'; setTimeout(closeModal, 900); });
    const sim = document.getElementById('cardSim'); if (sim) sim.addEventListener('click', () => readerApi({ action: 'simulate', reader_id: readerId }));
    const started = Date.now();
    while (!done && Date.now() - started < 180000) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) return;
      const st = await readerApi({ action: 'status', payment_intent: pi });
      if (st.status === 'paid') {
        done = true;
        status.innerHTML = `<div class="pay-status">Paid ${fmt(total)}${st.last4 ? ` · ${esc(st.brand || 'card')} ${esc(st.last4)}` : ''}</div>`;
        setTimeout(() => { closeModal(); showReceipt(sale.data); resetCart(); }, 900);
        return;
      }
      if (st.status === 'declined') {
        // The reader stops after a decline: cancel this attempt and offer a fresh one.
        done = true;
        await readerApi({ action: 'cancel', reader_id: readerId, payment_intent: pi });
        status.innerHTML = `<div class="pay-status err">${esc(st.say || 'Card declined.')}</div>`;
        document.getElementById('cardBody').innerHTML = '<div class="pay-actions"><button id="cardCancel">Close</button><button class="primary" id="cardRetry">Try another card</button></div>';
        document.getElementById('cardCancel').addEventListener('click', closeModal);
        document.getElementById('cardRetry').addEventListener('click', () => { status.innerHTML = ''; sendToReader(readerId); });
        return;
      }
      if (st.status === 'canceled') { done = true; status.innerHTML = '<div class="pay-status err">Payment cancelled.</div>'; return; }
    }
    if (!done) status.innerHTML = '<div class="pay-status err">Still waiting. If the client paid, it will show in Payments shortly.</div>';
  }

  async function openCashModal() {
    const { total } = totalCents();
    openModal(`
      <h3>Cash</h3>
      <p>Enter the amount received. Change is calculated automatically.</p>
      <div class="amount">${fmt(total)}</div>
      <input class="pay-input" id="cashGiven" type="number" step="0.01" placeholder="Amount given">
      <div id="changeLine" style="text-align:center;color:var(--pos-ink-soft);font-size:14px;">Change: —</div>
      <div class="pay-actions">
        <button id="cashCancel">Cancel</button>
        <button class="primary" id="cashConfirm">Record sale</button>
      </div>
      <div id="payStatus"></div>
    `);
    const given = document.getElementById('cashGiven');
    given.addEventListener('input', () => {
      const g = Math.round(parseFloat(given.value) * 100);
      const change = Number.isFinite(g) ? g - total : 0;
      document.getElementById('changeLine').textContent = 'Change: ' + (change >= 0 ? fmt(change) : '(short ' + fmt(-change) + ')');
    });
    document.getElementById('cashCancel').addEventListener('click', closeModal);
    document.getElementById('cashConfirm').addEventListener('click', async () => {
      const btn = document.getElementById('cashConfirm');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const g = Math.round(parseFloat(given.value || '0') * 100) || total;
        const r = await fetch('/api/pos/cash', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ ...salePayload('cash'), given_cents: g })
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || 'Save failed');
        closeModal();
        showReceipt(d.data);
        resetCart();
      } catch (err) {
        document.getElementById('payStatus').innerHTML = `<div class="pay-status err">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Retry';
      }
    });
  }

  async function openLinkModal() {
    const { total } = totalCents();
    openModal(`
      <h3>Send payment link</h3>
      <p>Client gets a Stripe hosted payment page they can pay from their phone.</p>
      <div class="amount">${fmt(total)}</div>
      <input class="pay-input" id="linkPhone" type="tel" placeholder="Client phone" value="${esc(state.client?.phone || '')}">
      <input class="pay-input" id="linkEmail" type="email" placeholder="Or email" value="${esc(state.client?.email || '')}">
      <div class="pay-actions">
        <button id="linkCancel">Cancel</button>
        <button class="primary" id="linkConfirm">Send</button>
      </div>
      <div id="payStatus"></div>
    `);
    document.getElementById('linkCancel').addEventListener('click', closeModal);
    document.getElementById('linkConfirm').addEventListener('click', async () => {
      const btn = document.getElementById('linkConfirm');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const phone = document.getElementById('linkPhone').value.trim();
        const email = document.getElementById('linkEmail').value.trim();
        if (!phone && !email) throw new Error('Need a phone or email');
        const r = await fetch('/api/pos/charge', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ ...salePayload('link'), delivery: { phone, email } })
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || 'Send failed');
        document.getElementById('payStatus').innerHTML = `<div class="pay-status">Payment link sent.</div>`;
        setTimeout(() => { closeModal(); resetCart(); }, 1400);
      } catch (err) {
        document.getElementById('payStatus').innerHTML = `<div class="pay-status err">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Retry';
      }
    });
  }

  function salePayload(kind) {
    const t = totalCents();
    return {
      client: state.client || null,
      items: state.cart.map(r => ({
        id: r.id, name: r.name, sub: r.sub || '', kind: r.kind, qty: r.qty, price_cents: r.price_cents
      })),
      subtotal_cents: t.subtotal,
      tax_cents: t.tax,
      tip_cents: t.tip,
      total_cents: t.total,
      payment_method: kind
    };
  }

  function showReceipt(sale) {
    const t = totalCents();
    document.getElementById('receiptBody').innerHTML = `
      <h3>Sale complete</h3>
      <p>${esc(state.client?.name || 'Walk-in')} · ${sale?.id ? esc(sale.id.slice(0, 8)) : ''}</p>
      <div class="amount">${fmt(t.total)}</div>
      <div style="border-top:1px solid var(--pos-line);padding-top:14px;margin-top:14px;">
        ${state.cart.map(r => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
          <span>${esc(r.name)} × ${r.qty}</span><span>${fmt(r.price_cents * r.qty)}</span>
        </div>`).join('')}
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:var(--pos-ink-mute);">
          <span>Tax</span><span>${fmt(t.tax)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:var(--pos-ink-mute);">
          <span>Tip</span><span>${fmt(t.tip)}</span>
        </div>
      </div>
      <div class="pay-actions">
        <button id="rcpSkip">No receipt</button>
        <button class="primary" id="rcpSend">Text receipt</button>
      </div>
    `;
    document.getElementById('receiptModal').hidden = false;
    document.getElementById('rcpSkip').addEventListener('click', () => document.getElementById('receiptModal').hidden = true);
    document.getElementById('rcpSend').addEventListener('click', async () => {
      const btn = document.getElementById('rcpSend'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await fetch('/api/pos/receipt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ sale_id: sale?.id || null, phone: state.client?.phone || '', email: state.client?.email || '' })
        });
      } catch {}
      document.getElementById('receiptModal').hidden = true;
    });
  }

  function resetCart() {
    state.cart = [];
    state.client = null;
    state.tipMode = '20';
    state.tipCents = 0;
    document.getElementById('cartClient').textContent = 'Walk-in';
    renderCart();
  }

  boot();
  console.info('[pos] ready');
})();
