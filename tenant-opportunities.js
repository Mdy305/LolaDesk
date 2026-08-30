/* Tenant revenue opportunities: live next actions with conservative attribution tracking. */
(function(){
  if(window.LolaTenantOpportunities) return;
  const esc=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>'$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0});
  async function track(auth,o,event){
    try{await fetch('/api/opportunity-event',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth.token},body:JSON.stringify({opportunityId:o.id,type:o.type,event,potentialRevenue:o.potentialRevenue,clientIds:o.clientIds||[]})});}catch{}
  }
  function ask(prompt,targetPage){
    if(targetPage){try{sessionStorage.setItem('lola_pending_prompt',prompt||'');}catch{}location.href=targetPage;return;}
    if(typeof window.askLola==='function')return window.askLola(prompt);
    const input=document.getElementById('cmdInput');if(input){input.value=prompt;input.focus();return;}
    location.href='lola-live.html?prompt='+encodeURIComponent(prompt||'');
  }
  function render(data,auth){
    const main=document.querySelector('.main,main');if(!main||document.getElementById('revenueOpportunityPanel'))return;
    const rows=Array.isArray(data?.opportunities)?data.opportunities:[],a=data?.attribution||{};
    const panel=document.createElement('section');panel.id='revenueOpportunityPanel';
    panel.style.cssText='margin:0 0 18px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#111114;overflow:hidden';
    const header=`<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.07);flex-wrap:wrap"><div><div style="font-size:12px;color:#8a8a92;margin-bottom:4px">LOLA REVENUE ENGINE</div><strong style="font-size:17px">${rows.length?'Best opportunities right now':'Revenue opportunities will appear here'}</strong></div><div style="display:flex;gap:22px;text-align:right"><div><div style="font-size:10px;color:#8a8a92">POTENTIAL</div><div style="font-size:20px;font-weight:700;color:#dcff66">${esc(data?.potentialRevenueMoney||'$0')}</div></div><div><div style="font-size:10px;color:#8a8a92">ATTRIBUTED</div><div style="font-size:20px;font-weight:700;color:#fff">${esc(a.revenueMoney||'$0')}</div><div style="font-size:10px;color:#777780">${Number(a.conversions||0)} bookings</div></div></div></div>`;
    if(data?.dataUnavailable)panel.innerHTML=header+'<div style="padding:22px;color:#8a8a92">Revenue intelligence is temporarily unavailable. No sample data is shown.</div>';
    else if(!rows.length)panel.innerHTML=header+'<div style="padding:22px;color:#8a8a92">Connect your booking platform and client history. Lola will identify win-backs, VIP rebooking, schedule gaps, and tasteful upsells.</div>';
    else panel.innerHTML=header+'<div>'+rows.map((o,i)=>{const state=o.lifecycle?.event||'identified';return `<article style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;padding:17px 20px;${i<rows.length-1?'border-bottom:1px solid rgba(255,255,255,.06)':''}"><div><div style="display:flex;gap:8px;align-items:center;margin-bottom:5px;flex-wrap:wrap"><strong style="font-size:13px">${esc(o.title)}</strong><span style="font-size:9px;padding:3px 6px;border-radius:999px;background:${o.priority==='high'?'rgba(204,255,0,.12)':'rgba(255,255,255,.06)'};color:${o.priority==='high'?'#dcff66':'#9a9aa2'}">${esc((o.priority||'').toUpperCase())}</span><span style="font-size:9px;color:#777780;text-transform:uppercase">${esc(state)}</span></div><div style="font-size:12px;line-height:1.45;color:#8a8a92">${esc(o.detail)}</div></div><div style="display:flex;align-items:center;gap:12px"><div style="text-align:right"><div style="font-size:10px;color:#66666e">EST.</div><strong style="font-size:13px">${money(o.potentialRevenue)}</strong></div><button data-opp="${i}" style="border:0;border-radius:10px;padding:9px 11px;background:#ccff00;color:#070708;font-weight:700;white-space:nowrap">${esc(state==='executed'?'Run again':o.cta||'Act now')}</button></div></article>`}).join('')+'</div>';
    // Lola first: land AFTER the orb hero grid so the owner meets her before
    // the day's work (the hero spans the full grid on desktop).
    // NOTE: never anchor on launchReadinessBanner — it lives in the topbar.
    const anchor=main.querySelector('.grid-main')||main.querySelector('.lola-panel')||main.querySelector('.dash-header');
    // Insert relative to the anchor's own parent — the anchor may be nested,
    // so main.insertBefore(panel, anchor.nextSibling) throws NotFoundError.
    const host=anchor&&anchor.parentNode?anchor.parentNode:main;
    if(anchor?.nextSibling)host.insertBefore(panel,anchor.nextSibling);else host.prepend(panel);
    panel.querySelectorAll('[data-opp]').forEach(btn=>btn.onclick=async()=>{const o=rows[Number(btn.dataset.opp)];if(!o)return;btn.disabled=true;btn.textContent='Opening…';await track(auth,o,'executed');ask(o.prompt,o.targetPage);});
  }
  async function boot(){
    let auth;try{auth=await window.LolaAuth.ready;}catch{return;}
    if(!/dashboard(?:\.html)?$/.test(location.pathname)&&location.pathname!=='/dashboard')return;
    try{const r=await fetch('/api/opportunities',{headers:{Authorization:'Bearer '+auth.token}});const data=await r.json();render(data,auth);}catch{render({opportunities:[],potentialRevenueMoney:'$0',attribution:{revenueMoney:'$0'},dataUnavailable:true},auth);}
  }
  window.LolaTenantOpportunities={boot};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
