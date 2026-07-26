/* LolaDesk Revenue Command Center — dashboard-only owner operating layer */
(function(){
  'use strict';
  if(!/\/?dashboard\.html$|\/$/.test(location.pathname)) return;

  const $ = (id) => document.getElementById(id);
  const money = (n) => '$' + Math.max(0, Number(n || 0)).toLocaleString('en-US',{maximumFractionDigits:0});
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ask = (prompt) => {
    if(typeof window.askLola === 'function') return window.askLola(prompt);
    if(typeof window.runResonanceAction === 'function') return window.runResonanceAction(prompt);
    const input = $('cmdInput');
    if(input){ input.value = prompt; input.focus(); }
  };

  function injectStyles(){
    if($('revenueOsStyles')) return;
    const style = document.createElement('style');
    style.id = 'revenueOsStyles';
    style.textContent = `
      .revenue-os{margin-bottom:16px;border:.5px solid var(--border);border-radius:20px;overflow:hidden;background:linear-gradient(145deg,rgba(204,255,0,.055),rgba(90,200,250,.025) 45%,var(--surface) 75%)}
      .revenue-os-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:22px 24px;border-bottom:.5px solid var(--border)}
      .revenue-os-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent2);margin-bottom:5px}.revenue-os-title{font-size:20px;font-weight:620;letter-spacing:-.02em}.revenue-os-sub{font-size:12px;color:var(--text2);margin-top:4px}
      .revenue-os-live{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text2);white-space:nowrap}.revenue-os-live i{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent-glow)}
      .revenue-os-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--border)}
      .revenue-os-metric{background:rgba(12,12,14,.96);padding:18px 20px;min-height:108px}.revenue-os-value{font-size:27px;font-weight:680;line-height:1.1}.revenue-os-label{font-size:11px;color:var(--text2);margin-top:7px}.revenue-os-note{font-size:10px;color:var(--text3);margin-top:3px}
      .revenue-os-body{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,.75fr);gap:0;border-top:.5px solid var(--border)}
      .revenue-os-opps{padding:20px 22px;border-right:.5px solid var(--border)}.revenue-os-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.revenue-os-section-title{font-size:13px;font-weight:600}.revenue-os-section-meta{font-size:10px;color:var(--text3)}
      .revenue-opportunity{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px 0;border-bottom:.5px solid var(--border)}.revenue-opportunity:last-child{border-bottom:0}.revenue-op-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--accent-dim);color:var(--accent2)}.revenue-op-title{font-size:12.5px;font-weight:560}.revenue-op-sub{font-size:10.5px;color:var(--text3);margin-top:2px}.revenue-op-value{text-align:right;font-size:12px;font-weight:650}.revenue-op-btn{margin-top:5px;padding:6px 9px;border-radius:9px;background:var(--surface2);border:.5px solid var(--border2);font-size:10px;color:var(--text2)}.revenue-op-btn:hover{color:var(--accent2);border-color:var(--accent)}
      .revenue-os-actions{padding:20px 22px}.revenue-action{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 13px;margin-bottom:8px;border-radius:12px;background:rgba(255,255,255,.025);border:.5px solid var(--border);text-align:left}.revenue-action:hover{background:var(--accent-dim);border-color:rgba(204,255,0,.35)}.revenue-action strong{font-size:11.5px;display:block}.revenue-action span{font-size:10px;color:var(--text3)}.revenue-action b{font-size:14px;color:var(--accent2)}
      @media(max-width:1100px){.revenue-os-grid{grid-template-columns:repeat(2,1fr)}.revenue-os-body{grid-template-columns:1fr}.revenue-os-opps{border-right:0;border-bottom:.5px solid var(--border)}}
      @media(max-width:620px){.revenue-os-head{padding:18px}.revenue-os-grid{grid-template-columns:1fr}.revenue-os-body{display:block}.revenue-os-opps,.revenue-os-actions{padding:17px}.revenue-opportunity{grid-template-columns:auto 1fr}.revenue-op-value{grid-column:2;text-align:left}}
    `;
    document.head.appendChild(style);
  }

  async function load(){
    if(!window.LolaData || !window.LolaData.load) return;
    let overview={}, callsData={}, inboxData={}, bookingsData={};
    try{
      [overview,callsData,inboxData,bookingsData] = await Promise.all([
        LolaData.load('overview').catch(()=>({})),
        LolaData.load('calls').catch(()=>({})),
        LolaData.load('inbox').catch(()=>({})),
        LolaData.load('bookings').catch(()=>({}))
      ]);
    }catch(e){ return; }

    const k = overview.kpis || {};
    const calls = Array.isArray(callsData.calls) ? callsData.calls : [];
    const threads = Array.isArray(inboxData.threads) ? inboxData.threads : [];
    const bookings = Array.isArray(bookingsData.bookings) ? bookingsData.bookings : [];
    const missed = calls.filter(c => !c.booked);
    const unread = threads.filter(t => t.unread);
    const cancelled = bookings.filter(b => /cancel/i.test(String(b.status || '')));
    const bookedCount = Number(k.bookings30 || bookings.length || 0);
    const trackedRevenue = Number(k.revenue30 || 0);
    const avgTicket = bookedCount > 0 && trackedRevenue > 0 ? trackedRevenue / bookedCount : 250;
    const dueClients = Math.max(0, Math.round(Number(k.clients || 0) * .04));
    const recoverable = Math.round((missed.length + unread.length + cancelled.length) * avgTicket);
    const conversion = calls.length ? Math.round(calls.filter(c=>c.booked).length / calls.length * 100) : Number(k.conversionRate || 0);
    const protectedValue = Math.round(cancelled.length * avgTicket);

    const mount = document.querySelector('.dash-header') || $('roiPanel') || document.querySelector('.grid-main');
    if(!mount || $('revenueCommandCenter')) return;

    const section = document.createElement('section');
    section.id = 'revenueCommandCenter';
    section.className = 'revenue-os';
    section.innerHTML = `
      <div class="revenue-os-head">
        <div><div class="revenue-os-kicker">Lola Revenue OS</div><div class="revenue-os-title">The business is speaking. Lola is acting.</div><div class="revenue-os-sub">One command center for Telnyx calls, messages, bookings, client memory, and profit opportunities.</div></div>
        <div class="revenue-os-live"><i></i> Telnyx AI active</div>
      </div>
      <div class="revenue-os-grid">
        <div class="revenue-os-metric"><div class="revenue-os-value">${money(recoverable)}</div><div class="revenue-os-label">Recoverable pipeline</div><div class="revenue-os-note">Open calls, conversations, and cancellations</div></div>
        <div class="revenue-os-metric"><div class="revenue-os-value">${conversion}%</div><div class="revenue-os-label">Call-to-booking conversion</div><div class="revenue-os-note">Recent Telnyx call outcomes</div></div>
        <div class="revenue-os-metric"><div class="revenue-os-value">${dueClients}</div><div class="revenue-os-label">Clients due to return</div><div class="revenue-os-note">Estimated from current client base</div></div>
        <div class="revenue-os-metric"><div class="revenue-os-value">${money(protectedValue)}</div><div class="revenue-os-label">Cancellation value at risk</div><div class="revenue-os-note">Revenue Lola can attempt to refill</div></div>
      </div>
      <div class="revenue-os-body">
        <div class="revenue-os-opps">
          <div class="revenue-os-section-head"><div class="revenue-os-section-title">Highest-impact opportunities</div><div class="revenue-os-section-meta">Ranked by immediate revenue</div></div>
          ${opportunity('☎','Recover missed callers',`${missed.length} recent callers did not book`,missed.length*avgTicket,'Contact now',`Use Telnyx SMS and voice to follow up every recent caller who did not book. Prioritize high-intent leads, personalize each message, and report the booked revenue.`)}
          ${opportunity('↻','Reactivate returning clients',`${dueClients} clients may be at their ideal return window`,dueClients*avgTicket,'Launch rebooking',`Identify clients due to return based on service history. Create a premium, personal rebooking campaign through Telnyx SMS or WhatsApp and ask for confirmation before sending.`)}
          ${opportunity('◇','Fill cancellations',`${cancelled.length} cancelled appointments detected`,protectedValue,'Fill gaps',`Find the best waitlist and VIP clients for cancelled appointments. Rank them by likelihood to book and prepare Telnyx outreach.`)}
          ${opportunity('✦','Convert waiting conversations',`${unread.length} unread conversations need attention`,unread.length*avgTicket,'Convert leads',`Review unread client conversations across channels, identify purchase intent, and draft the fastest path to a confirmed booking.`)}
        </div>
        <div class="revenue-os-actions">
          <div class="revenue-os-section-head"><div class="revenue-os-section-title">Owner commands</div><div class="revenue-os-section-meta">Ask once. Lola executes.</div></div>
          ${action('Run today for me','Prioritize bookings, clients, team, and revenue','Run my business today. Review calls, inbox, bookings, client memory, revenue risk, and team workload. Give me the three highest-impact actions and execute anything safe that does not require confirmation.')}
          ${action('Find where I lose money','Audit conversion, gaps, no-shows, and retention','Analyze where this business is losing revenue across calls, unanswered messages, cancellations, no-shows, low rebooking, empty capacity, and missed upsells. Rank the leaks by dollar impact.')}
          ${action('Create tomorrow’s revenue plan','Turn open capacity into confirmed appointments','Build tomorrow\'s revenue plan. Identify open capacity, best-fit clients, premium service opportunities, and Telnyx outreach required to fill the schedule.')}
          ${action('Brief me like a CEO','Revenue, risks, team, and next decisions','Give me an executive briefing with revenue, pipeline, risks, client opportunities, staff utilization, and the three decisions that matter most right now.')}
        </div>
      </div>`;

    mount.insertAdjacentElement('afterend',section);
    section.querySelectorAll('[data-lola-prompt]').forEach(btn => btn.addEventListener('click',()=>ask(btn.dataset.lolaPrompt)));
  }

  function opportunity(icon,title,sub,value,label,prompt){
    return `<div class="revenue-opportunity"><div class="revenue-op-icon">${icon}</div><div><div class="revenue-op-title">${esc(title)}</div><div class="revenue-op-sub">${esc(sub)}</div></div><div class="revenue-op-value">${money(value)}<br><button class="revenue-op-btn" data-lola-prompt="${esc(prompt)}">${esc(label)}</button></div></div>`;
  }
  function action(title,sub,prompt){
    return `<button class="revenue-action" data-lola-prompt="${esc(prompt)}"><div><strong>${esc(title)}</strong><span>${esc(sub)}</span></div><b>→</b></button>`;
  }

  injectStyles();
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(load,300));
  else setTimeout(load,300);
})();
