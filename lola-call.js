/* LolaDesk — lola-call.js: call a client from anywhere in LolaDesk.
 *   LolaCall(phone, name)   or any element with data-lola-call="+1305…" data-name="Maria"
 * Three ways, one sheet:
 *   · Call from my phone — LolaDesk rings your mobile, then connects the client
 *     (they see the salon's number, not yours). Works on a Mac too.
 *   · Lola calls them    — Lola phones the client herself.
 *   · This device        — the plain dialer (tel:), handy on a phone.
 */
(function () {
  if (window.LolaCall) return;
  const tok = () => { try { return localStorage.getItem('loladesk_token') || ''; } catch (_) { return ''; } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };
  let sheet = null;
  function close() { if (sheet) { sheet.remove(); sheet = null; } }
  async function place(mode, phone, name, note) {
    note.textContent = mode === 'me' ? 'Ringing your phone…' : 'Lola is dialing…'; note.style.color = '#a1a1a8';
    sheet.querySelectorAll('button[data-m]').forEach((b) => { b.disabled = true; });
    try {
      const r = await fetch('/api/call-center/call-client', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: JSON.stringify({ to: phone, name, mode }) });
      const d = await r.json().catch(() => ({}));
      note.textContent = d.say || (r.ok ? 'Calling…' : 'That call didn’t go through.');
      note.style.color = r.ok ? '#f5f5f7' : '#ff8a80';
      if (r.ok) setTimeout(close, 4000); else sheet.querySelectorAll('button[data-m]').forEach((b) => { b.disabled = false; });
    } catch (_) { note.textContent = 'The connection dropped. Try again.'; note.style.color = '#ff8a80'; sheet.querySelectorAll('button[data-m]').forEach((b) => { b.disabled = false; }); }
  }
  function open(phone, name) {
    close();
    sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'Call ' + (name || fmt(phone)));
    sheet.style.cssText = 'position:fixed;inset:0;z-index:400;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55);padding:16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
    const btn = 'display:block;width:100%;text-align:left;padding:14px 16px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:#16161a;color:#f5f5f7;font:inherit;cursor:pointer;margin-top:8px';
    sheet.innerHTML = `<div style="width:100%;max-width:420px;background:#0f0f12;border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:18px 16px 16px;box-shadow:0 20px 60px rgba(0,0,0,.6)">
      <div style="font-size:17px;font-weight:600;color:#f5f5f7">Call ${esc(name || fmt(phone))}</div>
      <div style="font-size:12.5px;color:#7a7a82;margin:3px 0 6px">${esc(fmt(phone))}</div>
      <button data-m="me" style="${btn}"><b style="font-size:14.5px">Call from my phone</b><div style="font-size:12px;color:#8a8a92;margin-top:3px">We ring your mobile, then connect them. They see the salon’s number.</div></button>
      <button data-m="lola" style="${btn}"><b style="font-size:14.5px">Have Lola call them</b><div style="font-size:12px;color:#8a8a92;margin-top:3px">Lola phones them for you — the call shows up in Calls.</div></button>
      <a href="tel:${esc(phone)}" style="${btn};text-decoration:none"><b style="font-size:14.5px">Use this device</b><div style="font-size:12px;color:#8a8a92;margin-top:3px">Opens your phone’s dialer.</div></a>
      <div data-note style="min-height:18px;font-size:13px;margin:12px 4px 2px"></div>
      <button data-x style="${btn};text-align:center;background:transparent">Cancel</button></div>`;
    document.body.appendChild(sheet);
    const note = sheet.querySelector('[data-note]');
    sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-x]')) close(); });
    sheet.querySelectorAll('button[data-m]').forEach((b) => b.addEventListener('click', () => place(b.dataset.m, phone, name, note)));
    addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', k); } });
    setTimeout(() => { const f = sheet && sheet.querySelector('button[data-m]'); f && f.focus(); }, 30);
  }
  window.LolaCall = open;
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-lola-call]');
    if (!el) return;
    e.preventDefault(); open(el.getAttribute('data-lola-call'), el.getAttribute('data-name') || '');
  });
})();
