/**
 * lola-forward.js — "Keep your number" in 90 seconds.
 * Renders into any element with [data-lola-forward]: pick the carrier, dial the
 * code(s) on the salon phone, tap "Test it" — LolaDesk calls the salon number and
 * confirms when the call reaches Lola.
 */
(function () {
  'use strict';
  const tok = () => { try { return localStorage.getItem('loladesk_token') || ''; } catch (_) { return ''; } };
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CSS = `.lf{display:flex;flex-direction:column;gap:12px}.lf-steps{display:flex;flex-direction:column;gap:8px}.lf-row{display:flex;gap:8px;flex-wrap:wrap}.lf select,.lf input{flex:1;min-width:180px;background:var(--bg2,#111);border:.5px solid var(--border,rgba(255,255,255,.12));border-radius:10px;padding:11px 13px;color:var(--text,#f4f4f6);font:inherit}
.lf-step{display:flex;align-items:center;gap:12px;justify-content:space-between;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 14px}.lf-step b{display:block;font-size:13px;color:var(--text,#f4f4f6)}.lf-step small{color:var(--text2,#a3a3ab);font-size:12px}
.lf-code{font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;color:#fff;white-space:nowrap}.lf-btn{border:1px solid rgba(255,255,255,.18);background:transparent;color:#fff;border-radius:999px;padding:7px 14px;font:inherit;font-size:12.5px;cursor:pointer}
.lf-btn.p{background:#f4f4f6;color:#0a0a0c;border-color:#f4f4f6;font-weight:600}.lf-note{font-size:12.5px;color:var(--text2,#a3a3ab)}.lf-ok{color:#c8ff3d}.lf-err{color:#ff8a8a}`;
  function mount(el) {
    if (el.__lf) return; el.__lf = 1;
    if (!document.getElementById('lf-css')) { const st = document.createElement('style'); st.id = 'lf-css'; st.textContent = CSS; document.head.appendChild(st); }
    el.innerHTML = `<div class="lf"><div class="lf-row"><input class="lf-num" placeholder="Your salon's current number" inputmode="tel"/><select class="lf-car"><option value="att">AT&amp;T</option><option value="tmobile">T-Mobile / Metro</option><option value="verizon">Verizon</option><option value="landline">Landline / business line</option></select></div><div class="lf-steps"></div><div class="lf-row"><button class="lf-btn p lf-test" type="button">Test it</button><span class="lf-note lf-msg"></span></div></div>`;
    const steps = el.querySelector('.lf-steps'), msg = el.querySelector('.lf-msg'), car = el.querySelector('.lf-car'), num = el.querySelector('.lf-num');
    async function plan() {
      try {
        const r = await fetch('/api/forwarding?carrier=' + car.value, { headers: H() }); const d = await r.json();
        if (!d.ok) return;
        if (!d.plan.ok) { steps.innerHTML = `<div class="lf-note">${esc(d.plan.error)}</div>`; return; }
        steps.innerHTML = d.plan.steps.map((s) => `<div class="lf-step"><div><b>${esc(s.when)}</b><small>${s.dial ? 'Dial on the salon phone · undo: ' + esc(s.cancel) : esc(s.portal)}</small></div>${s.dial ? `<span class="lf-code">${esc(s.dial)}</span><button class="lf-btn lf-copy" type="button" data-code="${esc(s.dial)}">Copy</button>` : ''}</div>`).join('') + `<div class="lf-note">${esc(d.plan.note)} Calls Lola answers come to <b>${esc(d.plan.lola)}</b>.</div>`;
        const v = (d.status || []).find((x) => x.status === 'verified');
        if (v) { msg.className = 'lf-note lf-ok'; msg.textContent = `✓ Forwarding works — calls ${v.account_id} misses reach Lola.`; }
      } catch (_) {}
    }
    steps.addEventListener('click', (e) => { const b = e.target.closest('.lf-copy'); if (!b) return; try { navigator.clipboard.writeText(b.dataset.code); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); } catch (_) {} });
    car.addEventListener('change', plan);
    el.querySelector('.lf-test').addEventListener('click', async () => {
      msg.className = 'lf-note'; msg.textContent = 'Calling your salon number…';
      try {
        const r = await fetch('/api/forwarding', { method: 'POST', headers: H(), body: JSON.stringify({ salon_number: num.value }) }); const d = await r.json();
        msg.className = 'lf-note ' + (d.ok ? '' : 'lf-err'); msg.textContent = d.say || (d.ok ? 'Calling…' : 'That didn’t work.');
        if (!d.ok) return;
        const t0 = Date.now();
        const poll = setInterval(async () => {
          const s = await fetch('/api/forwarding?carrier=' + car.value, { headers: H() }).then((x) => x.json()).catch(() => null);
          const v = s && (s.status || []).find((x) => x.status === 'verified');
          if (v) { clearInterval(poll); msg.className = 'lf-note lf-ok'; msg.textContent = '✓ It works. When you miss a call, Lola answers.'; return; }
          if (Date.now() - t0 > 75000) { clearInterval(poll); msg.className = 'lf-note lf-err'; msg.textContent = 'The call didn’t reach Lola. Check the code went through (you should have seen a confirmation), let it ring, and test again.'; }
        }, 4000);
      } catch (_) { msg.className = 'lf-note lf-err'; msg.textContent = 'Couldn’t reach LolaDesk.'; }
    });
    plan();
  }
  const run = () => document.querySelectorAll('[data-lola-forward]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  window.LolaForward = { mount, run };
})();
