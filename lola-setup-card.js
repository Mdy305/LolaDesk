/* ═══════════════════════════════════════════════════════════════
   LolaDesk — lola-setup-card.js: "Get Lola ready", done by Lola.
   ════════════════════════════════════════════════════════════════
   One quiet card on the dashboard while anything is left to set up:
   her number, the salon's current number (forward or move it), business
   texting, Instagram, Facebook Messenger, WhatsApp. Every row has one
   button that simply asks Lola to do it — she runs the whole thing by
   conversation (the setup tools on /api/lola). No IDs, no jargon, no fees:
   everything is included in the plan.

   Mounts into [data-lola-setup] or, on the dashboard, right after the
   Lola orb panel. Disappears when everything is done.
   /dashboard?setup=1 opens Lola with "let's finish setting up".
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__lolaSetupCard) return; window.__lolaSetupCard = true;

  const token = () => { try { return localStorage.getItem('loladesk_token') || ''; } catch (_) { return ''; } };
  const get = (u) => fetch(u, { headers: token() ? { Authorization: 'Bearer ' + token() } : {} }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ask(text) {
    if (typeof window.askLola === 'function') return window.askLola(text);
    if (window.LolaEverywhere && typeof window.LolaEverywhere.ask === 'function') return window.LolaEverywhere.ask(text);
    location.href = '/dashboard?setup=1';
  }

  function rows(setup, ch) {
    const t = setup && setup.telecom || {};
    const line = t.line || {}, tx = t.texting || {};
    const out = [];
    out.push({ key: 'number', title: 'Lola’s phone number', done: !!line.has_number, say: line.has_number ? (line.number ? 'Lola answers ' + line.number + '.' : 'Lola has her number.') : 'Give Lola her own number — included in your plan.', ask: 'Get Lola her phone number.' });
    const port = line.port, fwd = line.forwarding;
    const keepDone = fwd === 'verified' || (port && port.state === 'ported');
    out.push({ key: 'current', title: 'Your current salon number', done: keepDone, optional: true,
      say: port ? (port.say || 'Moving your number to LolaDesk…') : fwd === 'verified' ? 'Calls you miss forward to Lola.' : 'Keep your number: forward missed calls to Lola, or move it to LolaDesk.',
      ask: port ? 'How is moving my number going?' : 'I want to keep my current salon number — help me forward it or move it to LolaDesk.' });
    out.push({ key: 'texting', title: 'Business texting', done: tx.state === 'approved', say: tx.say || 'Register your business so carriers deliver Lola’s texts.', ask: tx.state === 'awaiting_code' ? 'I got the texting verification code.' : 'Register my business for texting.' });
    if (ch) {
      out.push({ key: 'instagram', title: 'Instagram DMs', done: !!(ch.instagram && ch.instagram.on), optional: true, soon: ch.instagram && ch.instagram.available === false, say: ch.instagram && ch.instagram.say, ask: 'Connect my Instagram.' });
      out.push({ key: 'messenger', title: 'Facebook Messenger', done: !!(ch.messenger && ch.messenger.on), optional: true, soon: ch.messenger && ch.messenger.available === false, say: ch.messenger && ch.messenger.say, ask: (ch.messenger && ch.messenger.choose) ? 'Which Facebook Page should you answer?' : 'Connect my Facebook Messenger.' });
      out.push({ key: 'whatsapp', title: 'WhatsApp', done: !!(ch.whatsapp && ch.whatsapp.on), optional: true, say: ch.whatsapp && ch.whatsapp.say, ask: 'Turn on WhatsApp for my salon.' });
    }
    return out;
  }

  function css() {
    if (document.getElementById('lola-setup-css')) return;
    const s = document.createElement('style'); s.id = 'lola-setup-css';
    s.textContent = `
.lsc{margin:18px 0;padding:20px 20px 12px;border-radius:20px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);color:#f2f2f5;font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif}
.lsc-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px}
.lsc-h b{font-size:17px;letter-spacing:-.01em}.lsc-h span{font-size:12px;color:rgba(242,242,245,.55)}
.lsc-sub{color:rgba(242,242,245,.6);font-size:13px;margin-bottom:12px}
.lsc-row{display:grid;grid-template-columns:22px 1fr auto;gap:12px;align-items:center;padding:11px 0;border-top:1px solid rgba(255,255,255,.06)}
.lsc-dot{width:18px;height:18px;border-radius:50%;border:1.5px solid rgba(242,242,245,.35);display:grid;place-items:center;font-size:11px}
.lsc-row.done .lsc-dot{background:#f2f2f5;border-color:#f2f2f5;color:#0b0b0d}
.lsc-t{font-weight:600}.lsc-s{font-size:12.5px;color:rgba(242,242,245,.6);margin-top:2px}
.lsc-b{border:1px solid rgba(242,242,245,.25);background:transparent;color:#f2f2f5;border-radius:999px;padding:7px 14px;font:600 12.5px inherit;cursor:pointer;white-space:nowrap}
.lsc-b:hover{background:rgba(242,242,245,.08)}.lsc-b[disabled]{opacity:.45;cursor:default}
.lsc-all{margin-top:10px;width:100%;padding:12px;border-radius:14px;border:0;background:#f2f2f5;color:#0b0b0d;font:650 14px inherit;cursor:pointer}
@media (max-width:560px){.lsc{padding:16px 14px 8px}.lsc-row{grid-template-columns:20px 1fr}.lsc-b{grid-column:2;justify-self:start;margin-top:4px}}`;
    document.head.appendChild(s);
  }

  async function render(host) {
    const [setup, ch] = await Promise.all([get('/api/setup'), get('/api/channels')]);
    if (!setup || setup.ok === false) { host.innerHTML = ''; return; }
    const list = rows(setup, ch && ch.ok !== false ? ch : null);
    const required = list.filter((r) => !r.optional);
    const left = list.filter((r) => !r.done && !r.soon);
    if (!left.length) { host.innerHTML = ''; return; }
    css();
    const doneN = list.filter((r) => r.done).length;
    host.innerHTML = `<section class="lsc" aria-label="Get Lola ready">
      <div class="lsc-h"><b>Get Lola ready</b><span>${doneN} of ${list.length} done</span></div>
      <div class="lsc-sub">${required.every((r) => r.done) ? 'The essentials are done. Add more places for Lola to answer:' : 'Just ask Lola — she does each step with you. Everything is included in your plan.'}</div>
      ${list.map((r) => `<div class="lsc-row${r.done ? ' done' : ''}">
        <div class="lsc-dot" aria-hidden="true">${r.done ? '✓' : ''}</div>
        <div><div class="lsc-t">${esc(r.title)}</div><div class="lsc-s">${esc(r.say || '')}</div></div>
        ${r.done ? '<span></span>' : `<button class="lsc-b" data-ask="${esc(r.ask)}"${r.soon ? ' disabled' : ''}>${r.soon ? 'Soon' : 'Do it with Lola'}</button>`}
      </div>`).join('')}
      <button class="lsc-all" data-ask="Let's finish setting up my salon — what's next?">Finish setup with Lola</button>
    </section>`;
    host.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) ask(b.getAttribute('data-ask')); }));
  }

  function mount() {
    let host = document.querySelector('[data-lola-setup]');
    if (!host) {
      const panel = document.querySelector('.grid-main .lola-panel');
      if (!panel) return;
      host = document.createElement('div'); host.setAttribute('data-lola-setup', '');
      panel.parentNode.insertBefore(host, panel.nextSibling);
    }
    render(host);
    window.addEventListener('lola:reply', () => setTimeout(() => render(host), 1500));
    window.addEventListener('lola:refresh', () => render(host));
    try {
      if (/[?&]setup=1\b/.test(location.search)) setTimeout(() => ask("Let's finish setting up my salon — what's next?"), 1800);
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
