/* LolaDesk campaign approval center — truthful draft/review/send workflow. */
(function(){
  if(window.LolaCampaignApproval)return;
  const esc=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=async(auth,body)=>{const r=await fetch('/api/marketing-automations',{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);return data;};
  const toast=(text,bad=false)=>{let t=document.getElementById('campaignApprovalToast');if(!t){t=document.createElement('div');t.id='campaignApprovalToast';t.style.cssText='position:fixed;right:20px;bottom:20px;z-index:10020;padding:12px 15px;border-radius:11px;background:#17171a;color:#fff;border:1px solid rgba(255,255,255,.12);font:600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';document.body.appendChild(t);}t.textContent=text;t.style.borderColor=bad?'rgba(255,90,90,.45)':'rgba(204,255,0,.35)';clearTimeout(t._timer);t._timer=setTimeout(()=>t.remove(),3600);};
  function mount(auth,data){
    if(document.getElementById('campaignApprovalCenter'))return;
    const main=document.querySelector('.main,main');if(!main)return;
    const section=document.createElement('section');section.id='campaignApprovalCenter';section.style.cssText='margin:18px 0;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#111114;overflow:hidden';
    section.innerHTML=`<div style="padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.07)"><div style="font-size:11px;color:#8b8b93;letter-spacing:.08em">CAMPAIGN APPROVAL CENTER</div><strong style="display:block;margin-top:4px;font-size:17px">Prepare first. Approve before sending.</strong><div style="margin-top:5px;font-size:12px;color:#85858d">Lola never claims a campaign was sent until Telnyx returns a real result.</div></div><div style="padding:18px 20px"><div id="campaignSegments" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px"></div><div id="campaignDrafts" style="margin-top:16px"></div></div>`;
    const anchor=main.querySelector('.page-header,.topbar,.dash-header');anchor?.nextSibling?main.insertBefore(section,anchor.nextSibling):main.prepend(section);
    const seg=section.querySelector('#campaignSegments');
    seg.innerHTML=(data.segments||[]).map(s=>`<button data-campaign="${esc(s.id)}" style="text-align:left;padding:13px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:#17171a;color:#fff;cursor:pointer"><strong style="display:block;font-size:13px">${esc(s.name)}</strong><span style="display:block;margin-top:3px;color:#8b8b93;font-size:11px">${Number(s.count||0)} contacts · ${esc(s.desc)}</span></button>`).join('');
    seg.querySelectorAll('[data-campaign]').forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{const out=await api(auth,{action:'draft',campaign:btn.dataset.campaign});toast(out.speak);location.reload();}catch(e){toast(e.message,true);btn.disabled=false;}});
    renderDrafts(auth,data,section.querySelector('#campaignDrafts'));
  }
  function renderDrafts(auth,data,host){
    const rows=data.drafts||[];
    if(!rows.length){host.innerHTML='<div style="padding:14px;border:1px dashed rgba(255,255,255,.1);border-radius:12px;color:#777780;font-size:12px">No campaign drafts yet.</div>';return;}
    host.innerHTML=rows.map(d=>`<article style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:14px 0;border-top:1px solid rgba(255,255,255,.06)"><div><strong style="font-size:13px">${esc(d.campaign||'campaign')}</strong><span style="margin-left:8px;font-size:9px;padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.06);color:#a2a2aa">${esc((d.status||'draft').toUpperCase())}</span><div style="margin-top:6px;font-size:12px;color:#8b8b93;line-height:1.45">${esc(d.message)}</div><div style="margin-top:5px;font-size:10px;color:#66666e">${Number(d.target_count||0)} recipients</div></div><div style="display:flex;gap:8px;align-items:center">${d.status==='draft'?`<button data-cancel="${esc(d.draftId)}" style="padding:8px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#aaa">Cancel</button>${data.canApprove?`<button data-send="${esc(d.draftId)}" style="padding:8px 11px;border:0;border-radius:9px;background:#ccff00;color:#070708;font-weight:700">Approve & send</button>`:'<span style="font-size:10px;color:#777">Manager approval required</span>'}`:''}</div></article>`).join('');
    host.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>act(auth,b,{action:'cancel',draftId:b.dataset.cancel}));
    host.querySelectorAll('[data-send]').forEach(b=>b.onclick=()=>{if(!confirm('Approve this campaign and send it now?'))return;act(auth,b,{action:'approve_send',draftId:b.dataset.send});});
  }
  async function act(auth,btn,body){btn.disabled=true;try{const out=await api(auth,body);toast(out.speak||`Campaign ${out.status}.`);location.reload();}catch(e){toast(e.message,true);btn.disabled=false;}}
  async function boot(){if(!/(^|\/)marketing(?:\.html)?$/.test(location.pathname))return;let auth;try{auth=await window.LolaAuth.ready;}catch{return;}try{mount(auth,await api(auth));}catch(e){toast(e.message,true);}}
  window.LolaCampaignApproval={boot};
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',boot,{once:true}):boot();
})();