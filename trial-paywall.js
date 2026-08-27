/* ═══════════════════════════════════════════════════════════════
   LolaDesk — trial-to-paid paywall
   Injected by auth-guard on every authenticated page. Shows the
   days-left banner during the trial and the hard paywall after it
   ends, with an upgrade CTA that deep-links straight into the
   correct Stripe Checkout session for the tenant's current plan.

   Pure logic (buildBanner) carries no DOM and is exported for
   tests; everything else is the thin boot/render layer.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if (window.LolaTrialPaywall) return; // never double-boot

  function buildBanner(state, pathname){
    if(!state || !state.ok) return { visible:false };
    if((pathname||'').includes('subscription')) return { visible:false }; // that page has its own billing UI
    if(state.status==='active'||state.status==='canceling') return { visible:false };
    if(!state.stripe_configured) return { visible:false }; // no upgrade path yet — stay quiet

    const plan = (state.plan==='pro'||state.plan==='scale') ? state.plan : 'starter';
    const d = Number(state.trial_days_left)||0;

    if(state.status==='trialing'){
      if(d>0){
        return {
          visible:true, tone:d<=3?'warn':'default', dismissible:true,
          kicker:'FREE TRIAL',
          title:d+' day'+(d===1?'':'s')+' left',
          copy:'Lola keeps answering calls and booking clients. Pick a plan to keep her on after your trial.',
          cta:'Upgrade now', action:'checkout', plan
        };
      }
      return {
        visible:true, tone:'paywall', dismissible:false,
        kicker:'TRIAL ENDED',
        title:'Your trial has ended',
        copy:'Lola paused new bookings for your salon. Pick a plan to bring her back instantly.',
        cta:'Upgrade now', action:'checkout', plan
      };
    }
    if(state.status==='past_due'){
      return {
        visible:true, tone:'danger', dismissible:false,
        kicker:'PAYMENT FAILED',
        title:'Payment didn\u2019t go through',
        copy:'Lola paused new bookings until your payment is updated.',
        cta:'Update card', action:'portal'
      };
    }
    if(state.status==='canceled'){
      return {
        visible:true, tone:'danger', dismissible:false,
        kicker:'SUBSCRIPTION ENDED',
        title:'Lola is paused',
        copy:'Reactivate your subscription to bring her back to answering calls.',
        cta:'Reactivate', action:'checkout', plan
      };
    }
    return { visible:false };
  }

  // ── render layer ───────────────────────────────────────────────
  const TONES = {
    default:['rgba(204,255,0,.14)','rgba(204,255,0,.5)','#ccff00'],
    warn:   ['rgba(255,192,67,.18)','rgba(255,192,67,.6)','#ffc043'],
    paywall:['rgba(255,107,107,.22)','rgba(255,107,107,.7)','#ff8a8a'],
    danger: ['rgba(255,107,107,.22)','rgba(255,107,107,.7)','#ff8a8a']
  };

  function styleOnce(){
    if(document.getElementById('lola-paywall-style')) return;
    const st=document.createElement('style'); st.id='lola-paywall-style';
    st.textContent=[
      '.lola-paywall{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:14px;',
      'padding:10px 16px;border-bottom:.5px solid var(--lola-pw-border,rgba(255,255,255,.08));',
      'background:var(--lola-pw-bg,rgba(8,8,10,.94));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);}',
      '.lola-paywall-inner{display:flex;align-items:center;gap:12px;flex:1;min-width:0;flex-wrap:wrap}',
      '.lola-pw-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 12px var(--lola-pw-glow)}',
      '.lola-pw-kicker{font-size:9.5px;letter-spacing:.16em;font-weight:700;color:var(--lola-pw-accent);opacity:.9}',
      '.lola-pw-title{font-size:13.5px;font-weight:650;color:#f2f2f5;letter-spacing:-.01em}',
      '.lola-pw-copy{font-size:12px;color:rgba(242,242,245,.6);line-height:1.5}',
      '.lola-pw-cta{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;padding:9px 18px;border-radius:11px;',
      'border:none;cursor:pointer;font:inherit;font-size:13px;font-weight:650;color:#080809;',
      'background:var(--lola-pw-accent);box-shadow:0 0 0 1px var(--lola-pw-accent),0 4px 18px var(--lola-pw-glow);transition:.18s}',
      '.lola-pw-cta:hover{transform:translateY(-1px)}.lola-pw-cta:disabled{opacity:.6;cursor:wait;transform:none}',
      '.lola-pw-cta .lola-pw-spin{width:12px;height:12px;border:2px solid rgba(8,8,10,.35);border-top-color:#080809;',
      'border-radius:50%;animation:lola-pw-rot .7s linear infinite}',
      '.lola-pw-x{flex:0 0 auto;width:26px;height:26px;border-radius:8px;border:none;cursor:pointer;color:rgba(242,242,245,.55);',
      'background:rgba(255,255,255,.06);font-size:14px;line-height:1}',
      '.lola-pw-x:hover{color:#f2f2f5;background:rgba(255,255,255,.12)}',
      '@keyframes lola-pw-rot{to{transform:rotate(360deg)}}'
    ].join('');
    document.head.appendChild(st);
  }

  function token(){
    return (window.LolaAuth&&window.LolaAuth.token)||(localStorage.getItem('loladesk_token')||'');
  }

  function setTone(banner, tone){
    const t=TONES[tone]||TONES.default;
    banner.style.setProperty('--lola-pw-accent',t[2]);
    banner.style.setProperty('--lola-pw-glow',t[1]);
    banner.style.setProperty('--lola-pw-border',t[0]);
  }

  function place(banner){
    const main=document.querySelector('.main');
    if(main&&main.firstChild) main.insertBefore(banner,main.firstChild);
    else if(main) main.appendChild(banner);
    else document.body.prepend(banner);
  }

  async function runAction(b, btn){
    btn.disabled=true;
    btn.innerHTML='<span class="lola-pw-spin"></span><span>Working…</span>';
    try{
      const r=await fetch('/api/billing',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},
        body:JSON.stringify({action:b.action==='portal'?'portal':'checkout',plan:b.plan})});
      const d=await r.json();
      if(!d.ok) throw new Error(d.error||'Could not open checkout');
      location.href=d.url;
    }catch(e){
      btn.disabled=false;
      btn.textContent=b.cta;
      if(window.LolaUX) window.LolaUX.toast(e.message,{type:'error',duration:5200});
      else alert(e.message);
    }
  }

  function render(b){
    if(document.getElementById('lola-paywall')) return;
    styleOnce();
    const banner=document.createElement('div');
    banner.id='lola-paywall';
    banner.className='lola-paywall';
    setTone(banner,b.tone);
    banner.setAttribute('role','region');
    banner.setAttribute('aria-label',b.title);
    const inner=document.createElement('div');
    inner.className='lola-paywall-inner';
    inner.innerHTML='<span class="lola-pw-dot"></span>'+
      '<div style="display:flex;flex-direction:column;gap:1px;min-width:0">'+
      '<span class="lola-pw-kicker">'+b.kicker+'</span>'+
      '<span class="lola-pw-title">'+b.title.replace(/</g,'&lt;')+'</span>'+
      '<span class="lola-pw-copy">'+b.copy.replace(/</g,'&lt;')+'</span>'+
      '</div>';
    const btn=document.createElement('button');
    btn.type='button'; btn.className='lola-pw-cta'; btn.textContent=b.cta;
    btn.onclick=()=>runAction(b,btn);
    banner.appendChild(inner);
    banner.appendChild(btn);
    if(b.dismissible){
      const x=document.createElement('button');
      x.type='button'; x.className='lola-pw-x'; x.setAttribute('aria-label','Dismiss'); x.textContent='\u2715';
      x.onclick=()=>{ try{ sessionStorage.setItem('lola-paywall-dismissed','1'); }catch(e){} banner.remove(); };
      banner.appendChild(x);
    }
    place(banner);
  }

  async function boot(){
    const t=token(); if(!t) return;
    try{ if(sessionStorage.getItem('lola-paywall-dismissed')) return; }catch(e){}
    let state;
    try{
      const r=await fetch('/api/billing?action=status',{headers:{Authorization:'Bearer '+t}});
      state=await r.json();
    }catch(e){ return; }
    const b=buildBanner(state,location.pathname);
    if(b.visible) render(b);
  }

  window.LolaTrialPaywall={ buildBanner };

  if(window.LolaAuth&&window.LolaAuth.ready){
    window.LolaAuth.ready.then(()=>boot()).catch(()=>{});
  }else if(typeof document!=='undefined'&&document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>boot(),{once:true});
  }else if(typeof document!=='undefined'){
    boot();
  }
})();
