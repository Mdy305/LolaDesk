/* ═══════════════════════════════════════════════════════════════
   banking.js — shared runtime for the banking module.
   Exports window.LolaBank. Consumed by banking.html (Overview),
   banking-payments.html (Payments feed), banking-policies.html
   (Revenue levers).

   Backend endpoints (M confirmed these are live):
     GET  /api/stripe/connect/status
     POST /api/stripe/connect/onboard
     GET  /api/stripe/connect/balance
     GET  /api/stripe/connect/payouts[?limit=N]
     GET  /api/stripe/connect/schedule
     POST /api/stripe/connect/schedule
     POST /api/stripe/connect/dashboard
     POST /api/stripe/connect/payout-now
     GET  /api/stripe/payments[?range=7d&filter=&q=&limit=N&cursor=]
     GET  /api/stripe/payments/:id
     POST /api/stripe/payments/:id/refund { amount?, reason? }
     GET  /api/stripe/metrics?range=7d      -> { revenue, charges, tips, deposits, refunds, sparkline:[{d,v}], trend_pct }
     GET  /api/stripe/risk-summary          -> { unpaid_fees:{count,total}, unclaimed_deposits:{count,total}, at_risk_total }
     GET  /api/tenant/billing-policies      -> { deposits, no_show, late_cancel, tips, auto_charge }
     POST /api/tenant/billing-policies      -> full policy object
     POST /api/tenant/billing-policies/preview -> { last_month_recovered, savings_estimate }
   ═══════════════════════════════════════════════════════════════ */

(function(){
'use strict';

const LolaBank = {
  state: {
    connected: false,
    sub_state: 'unknown',
    account_id: null,
    schedule: { interval: 'weekly', weekly_anchor: 'friday' },
    currentSchedule: 'weekly',
    pendingSchedule: null,
    metrics: null
  },

  /* ── utils ──────────────────────────────────────────────────── */
  $(id){ return document.getElementById(id); },
  esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
  money(cents, currency){
    const n = Number(cents||0)/100;
    const cur = (currency||'USD').toUpperCase();
    try{ return new Intl.NumberFormat('en-US',{style:'currency',currency:cur}).format(n); }
    catch(e){ return '$' + n.toFixed(2); }
  },
  moneyShort(cents, currency){
    const n = Number(cents||0)/100;
    if(n >= 10000) return '$' + Math.round(n/1000) + 'k';
    return this.money(cents, currency);
  },
  fmtDate(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  },
  fmtTime(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  },
  relTime(iso){
    if(!iso) return '';
    const t = new Date(iso).getTime();
    if(!t) return '';
    const s = Math.max(0, Math.floor((Date.now() - t)/1000));
    if(s < 60) return 'just now';
    if(s < 3600) return Math.floor(s/60)+'m ago';
    if(s < 86400) return Math.floor(s/3600)+'h ago';
    if(s < 2592000) return Math.floor(s/86400)+'d ago';
    return this.fmtDate(iso);
  },

  async authToken(){
    try{
      const auth = await window.LolaAuth.ready;
      return auth?.token || localStorage.getItem('loladesk_token') || '';
    }catch(e){ return localStorage.getItem('loladesk_token') || ''; }
  },
  async api(path, opts){
    const tok = await this.authToken();
    const headers = { 'Content-Type':'application/json', ...(tok?{Authorization:'Bearer '+tok}:{}) };
    const merged = { ...(opts||{}), headers:{ ...headers, ...(opts?.headers||{}) } };
    let r;
    try{ r = await fetch(path, merged); }
    catch(e){ return { ok:false, status:0, data:{ error:String(e.message||e) } }; }
    const data = await r.json().catch(()=>({}));
    return { ok: r.ok, status: r.status, data };
  },

  /* ── state paint ────────────────────────────────────────────── */
  showConnect(){
    const l = this.$('loadingState'); if(l) l.style.display = 'none';
    const h = this.$('connectHero'); if(h) h.hidden = false;
    const b = this.$('bankingBody'); if(b) b.hidden = true;
    const s = this.$('statusBanner'); if(s) s.hidden = true;
    const n = this.$('narrativeLine'); if(n) n.innerHTML = "Stripe isn't connected yet. Connect it to start taking deposits and tips.";
  },
  showConnected(){
    const l = this.$('loadingState'); if(l) l.style.display = 'none';
    const h = this.$('connectHero'); if(h) h.hidden = true;
    const b = this.$('bankingBody'); if(b) b.hidden = false;
    this.updateStatusBanner();
  },
  updateStatusBanner(){
    const b = this.$('statusBanner');
    if(!b) return;
    const sub = String(this.state.sub_state||'').toLowerCase();
    if(sub === 'pending_verification' || sub === 'restricted'){
      b.hidden = false;
      b.className = 'status-banner ' + (sub === 'restricted' ? 'err' : 'warn');
      const t = this.$('statusText');
      if(t) t.innerHTML = sub === 'restricted'
        ? "Payouts are paused — <b>Stripe needs updated info to release funds.</b>"
        : "Almost there — <b>Stripe needs a bit more info to fully activate payouts.</b>";
    } else {
      b.hidden = true;
    }
  },

  /* ── loaders ────────────────────────────────────────────────── */
  async loadStatus(){
    const { ok, data } = await this.api('/api/stripe/connect/status');
    if(!ok){ this.state.connected = false; return; }
    this.state.connected = !!data.connected;
    this.state.sub_state = data.sub_state || 'unknown';
    this.state.account_id = data.account_id || null;
  },

  async loadWeekMetrics(){
    const { ok, data } = await this.api('/api/stripe/metrics?range=7d');
    if(!ok) return;
    this.state.metrics = data;
    const set = (id, val) => { const el = this.$(id); if(el) el.textContent = val; };
    const revEl = this.$('weekRevenue');
    if(revEl) revEl.textContent = this.money(data.revenue||0, data.currency||'usd');
    set('weekCharges', String(data.charges||0));
    set('weekTips', this.money(data.tips||0, data.currency||'usd'));
    set('weekDeposits', this.money(data.deposits||0, data.currency||'usd'));
    set('weekRefunds', this.money(data.refunds||0, data.currency||'usd'));
    const trend = this.$('weekTrendPct');
    if(trend){
      const p = Number(data.trend_pct||0);
      const sign = p > 0 ? '▲' : p < 0 ? '▼' : '·';
      const cls = p > 0 ? 'trend-up' : p < 0 ? 'trend-down' : 'trend-neutral';
      trend.className = cls;
      trend.textContent = sign + ' ' + Math.abs(Math.round(p)) + '% vs. previous week';
    }
    const narrative = this.$('narrativeLine');
    if(narrative){
      const cur = data.currency || 'usd';
      const msg = data.charges > 0
        ? `Lola collected <b>${this.money(data.revenue||0,cur)}</b> across <b>${data.charges||0}</b> charges this week.`
        : `Lola is ready to collect. Set up deposits in <a href="banking-policies.html" style="color:var(--accent);text-decoration:none">Policies</a> to lock every booking with a card on file.`;
      narrative.innerHTML = msg;
    }
  },

  async loadBalance(){
    const { ok, data } = await this.api('/api/stripe/connect/balance');
    if(!ok) return;
    const avail = (data.available && data.available[0]) || { amount:0, currency:'usd' };
    const pend  = (data.pending   && data.pending[0])   || { amount:0, currency:'usd' };
    const trans = (data.instant_available && data.instant_available[0]) || { amount:0, currency:'usd' };
    const set = (id, val) => { const el = this.$(id); if(el) el.textContent = val; };
    set('balanceAmount', this.money(avail.amount, avail.currency));
    set('balanceCurrency', (avail.currency||'usd').toUpperCase());
    set('pendingAmount', this.money(pend.amount, pend.currency));
    set('inTransit', this.money(trans.amount, trans.currency));
    const sub = this.$('balanceSub');
    if(sub) sub.textContent = avail.amount > 0
      ? "Ready to send to your bank on the next scheduled payout."
      : "As bookings settle, they show up here — usually within 2 business days.";
    const btn = this.$('payoutNowBtn');
    if(btn) btn.disabled = !(avail.amount > 0);
  },

  async loadPayouts(limit){
    const host = this.$('payoutsList');
    if(!host) return;
    const { ok, data } = await this.api('/api/stripe/connect/payouts' + (limit?('?limit='+limit):''));
    if(!ok || !Array.isArray(data.payouts) || !data.payouts.length){
      host.innerHTML = `<div class="payouts-empty">No payouts yet. Once you take your first booking with a deposit, it will land here.</div>`;
      return;
    }
    host.innerHTML = data.payouts.map(p => this.payoutRowHtml(p)).join('');
  },
  payoutRowHtml(p){
    const status = String(p.status||'').toLowerCase();
    const label = ({paid:'Paid',pending:'Pending',failed:'Failed',in_transit:'In transit',canceled:'Canceled'})[status] || 'Pending';
    const icon = status === 'paid'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
      : status === 'failed'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l3 2"/></svg>';
    return `
      <div class="payout-row">
        <div class="payout-icon ${status}" aria-hidden="true">${icon}</div>
        <div class="payout-info">
          <div class="payout-date">${this.esc(this.fmtDate(p.arrival_date))}</div>
          <div class="payout-sub">${this.esc(this.relTime(p.arrival_date))} · to bank ending ${this.esc(p.destination_last4 || '••••')}</div>
        </div>
        <div class="payout-amount">${this.money(p.amount, p.currency)}</div>
        <span class="payout-status ${status}">${label}</span>
      </div>`;
  },

  async loadSchedule(){
    const { ok, data } = await this.api('/api/stripe/connect/schedule');
    if(!ok) return;
    this.state.schedule = data.schedule || this.state.schedule;
    this.state.currentSchedule = this.state.schedule.interval || 'weekly';
    const label = this.state.currentSchedule === 'daily' ? 'Daily'
      : this.state.currentSchedule === 'weekly' ? `Weekly, ${(this.state.schedule.weekly_anchor||'friday').charAt(0).toUpperCase()+ (this.state.schedule.weekly_anchor||'friday').slice(1)}s`
      : this.state.currentSchedule === 'monthly' ? 'Monthly, 1st business day'
      : 'Weekly, Fridays';
    const cs = this.$('currentSchedule'); if(cs) cs.textContent = label;
    document.querySelectorAll('.schedule-opt').forEach(el => {
      el.classList.toggle('on', el.dataset.int === this.state.currentSchedule);
    });
  },

  async loadRiskSummary(){
    const { ok, data } = await this.api('/api/stripe/risk-summary');
    const card = this.$('riskCard');
    if(!card) return;
    if(!ok || !data || Number(data.at_risk_total||0) <= 0){ card.hidden = true; return; }
    card.hidden = false;
    const t = this.$('riskTitle'); if(t) t.textContent = 'Revenue at risk';
    const s = this.$('riskSub');
    if(s){
      const uf = data.unpaid_fees || { count:0, total:0 };
      const ud = data.unclaimed_deposits || { count:0, total:0 };
      const parts = [];
      if(uf.count) parts.push(`${uf.count} unpaid no-show fee${uf.count>1?'s':''}`);
      if(ud.count) parts.push(`${ud.count} unclaimed deposit${ud.count>1?'s':''}`);
      s.innerHTML = `${parts.join(' and ')} — <b>${this.money(data.at_risk_total||0, data.currency||'usd')}</b> waiting to be collected.`;
    }
  },

  /* ── sparkline (used on Overview) ───────────────────────────── */
  drawSparkline(){
    const svg = this.$('sparkChart');
    if(!svg) return;
    const pts = (this.state.metrics && Array.isArray(this.state.metrics.sparkline)) ? this.state.metrics.sparkline : [];
    if(!pts.length){
      svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="var(--text3)" font-size="11">no data yet</text>`;
      return;
    }
    const W = 300, H = 120, PAD = 8;
    const vals = pts.map(p => Number(p.v||0));
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const range = Math.max(1, max - min);
    const stepX = (W - PAD*2) / Math.max(1, vals.length - 1);
    const path = vals.map((v,i) => {
      const x = PAD + i*stepX;
      const y = H - PAD - ((v - min) / range) * (H - PAD*2);
      return (i?'L':'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const area = path + ` L ${(PAD + (vals.length-1)*stepX).toFixed(1)},${(H-PAD).toFixed(1)} L ${PAD.toFixed(1)},${(H-PAD).toFixed(1)} Z`;
    svg.innerHTML = `
      <defs>
        <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#sparkFill)" stroke="none"/>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    `;
  },

  /* ── schedule actions ───────────────────────────────────────── */
  pickSchedule(interval){
    document.querySelectorAll('.schedule-opt').forEach(el => {
      el.classList.toggle('on', el.dataset.int === interval);
    });
    this.state.pendingSchedule = interval;
    const dirty = interval !== this.state.currentSchedule;
    const s = this.$('scheduleSave');
    if(s) s.classList.toggle('dirty', dirty);
  },
  async saveSchedule(){
    const btn = this.$('scheduleSave');
    if(!btn) return;
    const interval = this.state.pendingSchedule || this.state.currentSchedule;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Saving…';
    const { ok, data } = await this.api('/api/stripe/connect/schedule', { method:'POST', body: JSON.stringify({ interval }) });
    if(ok){
      this.state.currentSchedule = interval;
      btn.classList.remove('dirty');
      btn.textContent = 'Saved ✓';
      setTimeout(()=>{ btn.textContent = prev; btn.disabled = false; }, 1400);
      this.loadSchedule();
    } else {
      btn.textContent = 'Save failed — try again';
      setTimeout(()=>{ btn.textContent = prev; btn.disabled = false; }, 2000);
    }
  },

  /* ── one-shot actions ───────────────────────────────────────── */
  async startConnect(){
    const btn = this.$('connectBtn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<span>Opening Stripe…</span>'; }
    const { ok, data } = await this.api('/api/stripe/connect/onboard', { method:'POST' });
    if(ok && data.url){ location.href = data.url; return; }
    if(btn){
      btn.disabled = false;
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Try again';
    }
    alert("Couldn't start Stripe onboarding: " + (data?.error || 'Unknown error'));
  },
  async openStripeDashboard(){
    const { ok, data } = await this.api('/api/stripe/connect/dashboard', { method:'POST' });
    if(ok && data.url){ window.open(data.url, '_blank', 'noopener'); return; }
    window.open('https://dashboard.stripe.com/', '_blank', 'noopener');
  },
  async triggerPayout(){
    const btn = this.$('payoutNowBtn');
    if(!btn) return;
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Requesting…';
    const { ok } = await this.api('/api/stripe/connect/payout-now', { method:'POST' });
    if(ok){
      btn.textContent = 'Payout requested ✓';
      setTimeout(()=>{ btn.textContent = prev; btn.disabled = false; this.loadBalance(); this.loadPayouts(6); }, 1600);
    } else {
      btn.textContent = 'Failed — try again';
      setTimeout(()=>{ btn.textContent = prev; btn.disabled = false; }, 2000);
    }
  },

  /* ── payments feed helpers (used by banking-payments.html) ──── */
  paymentTypeIcon(kind){
    switch(kind){
      case 'tip':      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>';
      case 'deposit':  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M12 3v6M9 6l3-3 3 3"/></svg>';
      case 'refund':   return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1015.5-6.5L21 8M21 3v5h-5"/></svg>';
      case 'fee':      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l3 2"/></svg>';
      default:         return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
    }
  },
  paymentTypeLabel(kind){
    return ({ charge:'Charge', tip:'Tip', deposit:'Deposit', refund:'Refund', fee:'No-show fee' })[kind] || 'Charge';
  }
};

window.LolaBank = LolaBank;
})();
