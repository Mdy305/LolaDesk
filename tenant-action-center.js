/* LolaDesk daily action command center. */
(function(){
  if(window.LolaActionCenter)return;
  const esc=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const badge=p=>p==='critical'?'#ff6b6b':p==='high'?'#dcff66':'#9a9aa2';
  async function setState(auth,id,status){
    const payload={action_id:id,status};
    if(status==='snoozed')payload.snooze_until=new Date(Date.now()+24*3600*1000).toISOString();
    const r=await fetch('/api/action-center',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth.token},body:JSON.stringify(payload)});
    if(!r.ok)throw new Error('Could not update action');
  }
  function render(data,auth){
    const main=document.querySelector('.main,main');if(!main||document.getElementById('dailyActionCenter'))return;
    const items=Array.isArray(data?.items)?data.items:[],section=document.createElement('section');section.id='dailyActionCenter';
    section.style.cssText='margin:0 0 18px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#0f0f12;overflow:hidden';
    const counts=data?.counts||{};
    const head=`<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.07)"><div><div style="font-size:11px;letter-spacing:.12em;color:#8a8a92;margin-bottom:5px">TODAY WITH LOLA</div><strong style="font-size:18px">${items.length?'Your prioritized action queue':'Everything important is handled'}</strong></div><div style="display:flex;gap:16px;text-align:center"><div><strong style="font-size:21px">${Number(counts.open||0)}</strong><div style="font-size:9px;color:#777780">OPEN</div></div><div><strong style="font-size:21px;color:#ff8c8c">${Number(counts.critical||0)}</strong><div style="font-size:9px;color:#777780">URGENT</div></div></div></div>`;
    if(data?.dataUnavailable)section.innerHTML=head+'<div style="padding:22px;color:#8a8a92">The action queue is temporarily unavailable. Lola is not showing invented tasks.</div>';
    else if(!items.length)section.innerHTML=head+'<div style="padding:22px;color:#8a8a92">No missed calls, pending confirmations, campaign approvals, or delivery failures need attention right now.</div>';
    else section.innerHTML=head+'<div>'+items.map((x,i)=>`<article data-row="${i}" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:16px 20px;${i<items.length-1?'border-bottom:1px solid rgba(255,255,255,.06)':''}"><div><div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><span style="width:7px;height:7px;border-radius:50%;background:${badge(x.priority)}"></span><strong style="font-size:13px">${esc(x.title)}</strong></div><div style="font-size:12px;color:#8a8a92;line-height:1.45">${esc(x.detail)}</div></div><div style="display:flex;gap:8px;align-items:center"><button data-open="${i}" style="border:0;border-radius:9px;padding:8px 10px;background:#ccff00;color:#070708;font-weight:700;cursor:pointer">${esc(x.cta||'Open')}</button><button data-done="${i}" title="Mark handled" style="border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;background:transparent;color:#b8b8bf;cursor:pointer">Done</button><button data-snooze="${i}" title="Snooze for 24 hours" style="border:0;background:transparent;color:#777780;cursor:pointer">Later</button></div></article>`).join('')+'</div>';
    // Lola first: land AFTER the orb hero grid so the owner meets her before
    // the day's work (the hero spans the full grid on desktop).
    // NOTE: never anchor on launchReadinessBanner — it lives in the topbar.
    const anchor=main.querySelector('.grid-main')||main.querySelector('.lola-panel')||main.querySelector('.dash-header');
    // Insert relative to the anchor's own parent — the anchor may be nested,
    // so main.insertBefore(section, anchor.nextSibling) throws NotFoundError.
    const host=anchor&&anchor.parentNode?anchor.parentNode:main;
    if(anchor?.nextSibling)host.insertBefore(section,anchor.nextSibling);else host.prepend(section);
    section.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{const x=items[Number(b.dataset.open)];if(x?.href)location.href=x.href;});
    section.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{const x=items[Number(b.dataset.done)];b.disabled=true;try{await setState(auth,x.id,'resolved');b.closest('article')?.remove();}catch{b.disabled=false;}});
    section.querySelectorAll('[data-snooze]').forEach(b=>b.onclick=async()=>{const x=items[Number(b.dataset.snooze)];b.disabled=true;try{await setState(auth,x.id,'snoozed');b.closest('article')?.remove();}catch{b.disabled=false;}});
  }
  async function boot(){
    let auth;try{auth=await window.LolaAuth.ready;}catch{return;}
    if(!/dashboard(?:\.html)?$/.test(location.pathname)&&location.pathname!=='/dashboard')return;
    try{const r=await fetch('/api/action-center',{headers:{Authorization:'Bearer '+auth.token}}),data=await r.json();render(data,auth);}catch{render({items:[],counts:{},dataUnavailable:true},auth);}
  }
  window.LolaActionCenter={boot};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
