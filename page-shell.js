/* LolaDesk — page-shell primitives. Every rebuilt page uses these.
 *   window.LolaShell = {
 *     authToken(), api(path, body, method), fetchJson(path),
 *     toast(msg, kind), dialog({ title, body, actions }), confirm(msg),
 *     ensureSidebar(), fmtMoney(cents), fmtDate(iso), fmtTime(iso)
 *   }
 */
(function () {
  if (window.LolaShell) return;

  /* ---- utilities ---- */
  const $  = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
  const html = (tag, cls, h) => { const n = document.createElement(tag); if (cls) n.className = cls; if (h != null) n.innerHTML = h; return n; };
  const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch (_) {} };

  const authToken = () => {
    try {
      const s = window.supa || window.supabase;
      const sess = s?.auth?.session?.() || null;
      return sess?.access_token || localStorage.getItem('sb-access-token') || localStorage.getItem('access_token') || '';
    } catch { return ''; }
  };

  async function fetchJson(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + authToken(), ...(opts.headers || {}) } });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { ok: r.ok && d?.ok !== false, data: d?.data ?? d, error: d?.error || (r.ok ? null : 'http_' + r.status), raw: d, status: r.status };
  }

  async function api(path, body, method = 'POST') {
    return fetchJson(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  }

  const fmtMoney = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m} ${ap}`;
  };

  /* ---- toast ---- */
  function toast(message, kind = 'ok') {
    let wrap = document.querySelector('.ls-toast-wrap');
    if (!wrap) {
      wrap = el('div', 'ls-toast-wrap');
      wrap.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10001;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none';
      document.body.append(wrap);
    }
    const t = el('div', 'ls-toast');
    const colors = { ok: 'rgba(52,199,89,.94)', warn: 'rgba(255,179,64,.94)', dan: 'rgba(255,69,58,.94)', info: 'rgba(10,10,15,.94)' };
    t.style.cssText = `background:${colors[kind] || colors.info};color:#fff;padding:11px 20px;border-radius:22px;font:500 14px -apple-system,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.28);transform:translateY(20px);opacity:0;transition:transform .35s cubic-bezier(0.32,0.72,0,1),opacity .28s ease-out;backdrop-filter:blur(10px)`;
    t.textContent = message;
    wrap.append(t);
    requestAnimationFrame(() => { t.style.transform = 'translateY(0)'; t.style.opacity = '1'; });
    setTimeout(() => { t.style.transform = 'translateY(-8px)'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2400);
  }

  /* ---- dialog ---- */
  function dialog({ title, subtitle, body, actions, wide = false }) {
    return new Promise((resolve) => {
      const back = el('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);backdrop-filter:blur(14px) saturate(140%);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .28s cubic-bezier(0.16,1,0.3,1)';
      const card = el('div');
      card.style.cssText = `background:var(--surface,#101012);border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:var(--r-lg,20px);box-shadow:var(--shadow-3,0 24px 60px rgba(0,0,0,.34));width:min(${wide ? 640 : 480}px,100%);color:var(--text,#f4f4f7);overflow:hidden;transform:translateY(24px) scale(.96);opacity:0;transition:transform .38s cubic-bezier(0.32,0.72,0,1),opacity .28s ease-out`;
      const head = el('div');
      head.style.cssText = 'padding:22px 24px 4px';
      const t = el('div');
      t.style.cssText = 'font:600 20px/1.25 -apple-system,sans-serif;letter-spacing:-.02em';
      t.textContent = title || '';
      head.append(t);
      if (subtitle) {
        const s = el('div');
        s.style.cssText = 'font:400 14px -apple-system,sans-serif;color:var(--text2,#9a9aa2);margin-top:4px';
        s.textContent = subtitle;
        head.append(s);
      }
      const bod = el('div');
      bod.style.cssText = 'padding:16px 24px 4px';
      if (typeof body === 'string') bod.innerHTML = body;
      else if (body instanceof Node) bod.append(body);
      const foot = el('div');
      foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:16px 22px 22px;flex-wrap:wrap';
      card.append(head, bod, foot);
      back.append(card);
      document.body.append(back);
      requestAnimationFrame(() => { back.style.opacity = '1'; card.style.transform = 'translateY(0) scale(1)'; card.style.opacity = '1'; });
      const close = (v) => { back.style.opacity = '0'; setTimeout(() => back.remove(), 260); resolve(v); };
      back.addEventListener('click', (e) => { if (e.target === back) close(null); });
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', esc); } });

      (actions || [{ label: 'OK', value: true, primary: true }]).forEach((a) => {
        const btn = el('button');
        btn.className = 'ld-btn' + (a.primary ? ' pri' : '') + (a.danger ? ' dan' : '');
        btn.textContent = a.label;
        btn.onclick = async () => {
          if (typeof a.onClick === 'function') {
            const result = await a.onClick({ body: bod, close });
            if (result !== undefined) close(result);
          } else {
            close(a.value !== undefined ? a.value : true);
          }
        };
        foot.append(btn);
      });
      return { body: bod, close };
    });
  }

  async function confirmDialog(message, opts = {}) {
    return dialog({
      title: opts.title || 'Are you sure?',
      body: `<p style="color:var(--text2,#9a9aa2);margin:0">${message}</p>`,
      actions: [
        { label: opts.cancelLabel || 'Cancel', value: false },
        { label: opts.confirmLabel || 'Confirm', value: true, primary: !opts.danger, danger: opts.danger },
      ],
    });
  }

  /* ---- ensure sidebar (defensive) ---- */
  function ensureSidebar() {
    if (document.querySelector('script[data-lola-sidebar-mounted]')) return;
    if (document.querySelector('script[src="sidebar.js"]') || document.querySelector('script[src="/sidebar.js"]')) return;
    const s = document.createElement('script');
    s.src = '/sidebar.js';
    s.defer = true;
    s.setAttribute('data-lola-sidebar-mounted', '1');
    document.head.append(s);
  }

  /* ---- page-init helper: guards auth, mounts sidebar, injects design.css ---- */
  function initPage(opts = {}) {
    if (!document.querySelector('link[data-lola-design]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/design.css'; link.setAttribute('data-lola-design', '1');
      document.head.prepend(link);
    }
    ensureSidebar();
    // Auth guard, if not already handled by auth-guard.js
    if (opts.requireAuth !== false && !authToken()) {
      const path = location.pathname + location.search;
      location.replace('/login?next=' + encodeURIComponent(path));
    }
  }

  /* ---- public ---- */
  window.LolaShell = {
    api, fetchJson, authToken, toast, dialog, confirm: confirmDialog,
    ensureSidebar, initPage, fmtMoney, fmtDate, fmtTime, haptic,
    el, html, $,
  };
  window.dispatchEvent(new CustomEvent('lola:shell-ready'));
})();
