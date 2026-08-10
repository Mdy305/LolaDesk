/* ═══════════════════════════════════════════════════════════════
   Live Activity Poll — the Living Atom reacts to real-time events
   ════════════════════════════════════════════════════════════════
   Polls bookings / calls / inbox on an interval. When something new
   shows up (a booking, a call, an unread message) it:
     - pulses the orb (via window.lolaPulse, exposed by app.js)
     - shows a small toast in the corner
     - re-renders the schedule + away panel so the new item is visible
       without the user refreshing

   Only runs on pages that have the real data functions (dashboard.html).
   Self-contained — no globals except the poll interval handle.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const POLL_MS = 25000;
  let seenBookings = null, seenCalls = null, seenInbox = null;
  let timer = null;

  function toast(text){
    let host = document.getElementById('lolaToastHost');
    if(!host){
      host = document.createElement('div');
      host.id = 'lolaToastHost';
      host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9998;display:flex;flex-direction:column;gap:8px;align-items:flex-end';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'background:#12140f;border:1px solid rgba(204,255,0,.35);color:#eafcd0;padding:10px 14px;border-radius:10px;font-size:12.5px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s;max-width:280px';
    host.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity='1'; el.style.transform='translateY(0)'; });
    setTimeout(()=>{
      el.style.opacity='0'; el.style.transform='translateY(8px)';
      setTimeout(()=>el.remove(), 300);
    }, 4200);
  }

  function diffNewIds(prevSet, items){
    if(!prevSet) return { isFirstLoad:true, added:[] };
    const added = items.filter(x => x.id != null && !prevSet.has(x.id));
    return { isFirstLoad:false, added };
  }

  async function pollOnce(){
    if(!window.LolaData || typeof window.LolaData.load !== 'function') return;
    try{
      const [bkData, callData, inboxData] = await Promise.all([
        window.LolaData.load('bookings').catch(()=>null),
        window.LolaData.load('calls').catch(()=>null),
        window.LolaData.load('inbox').catch(()=>null)
      ]);

      const bookings = (bkData && Array.isArray(bkData.bookings)) ? bkData.bookings : [];
      const calls    = (callData && Array.isArray(callData.calls)) ? callData.calls : [];
      const threads  = (inboxData && Array.isArray(inboxData.threads)) ? inboxData.threads.filter(t=>t.unread) : [];

      const bkDiff    = diffNewIds(seenBookings, bookings);
      const callDiff  = diffNewIds(seenCalls, calls);
      const inboxDiff = diffNewIds(seenInbox, threads);

      seenBookings = new Set(bookings.map(x=>x.id));
      seenCalls    = new Set(calls.map(x=>x.id));
      seenInbox    = new Set(threads.map(x=>x.id));

      // Skip reacting on the very first poll — that's just establishing baseline,
      // not "new" activity.
      if(bkDiff.isFirstLoad) return;

      const events = [];
      bkDiff.added.forEach(b => events.push(`New booking — ${b.client || 'Client'}: ${b.service || 'Appointment'}`));
      callDiff.added.forEach(c => events.push(`New call from ${c.from || 'a client'}${c.booked ? ' (booked!)' : ''}`));
      inboxDiff.added.forEach(t => events.push(`New message from ${t.who || 'a client'}`));

      if(!events.length) return;

      if(typeof window.lolaPulse === 'function') window.lolaPulse(events[0]);
      events.slice(0,3).forEach((msg,i)=> setTimeout(()=>toast(msg), i*350));

      // Refresh the visible panels so the new item actually shows up.
      if(typeof window.lolaRefreshPanels === 'function') window.lolaRefreshPanels();
    }catch(e){ /* silent — never let polling break the dashboard */ }
  }

  function start(){
    if(timer) return;
    pollOnce(); // establish baseline immediately
    timer = setInterval(pollOnce, POLL_MS);
    document.addEventListener('visibilitychange', ()=>{
      if(document.hidden){ clearInterval(timer); timer = null; }
      else if(!timer){ timer = setInterval(pollOnce, POLL_MS); pollOnce(); }
    });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
