/* ═══════════════════════════════════════════════════════════════
   Lola Autopilot — live run announcements via the ONE notification
   ════════════════════════════════════════════════════════════════
   After each hourly autopilot run (api/cron/autopilot), the owner's
   open app announces what Lola's agents just did — "Lola recovered
   3 missed calls" — through LolaNotify, deduped by run id so each
   run fires exactly once, on whatever authenticated page they're on.

   Polls /api/autopilot-notices every minute (only while visible).
   The FIRST poll establishes baseline and never announces history;
   later polls announce NEW runs whose status did something
   (success/partial/failed — 'skipped' is a quiet heartbeat, no
   toast). Seen ids persist in localStorage so a refresh never
   re-announces a run.

   Injected by auth-guard on every authenticated page, after
   lola-notify.js. Self-contained — no globals besides LolaNotify.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const POLL_MS = 60000;
  const KEY = 'loladesk_autopilot_seen_v1';

  const LABELS = {
    'routing-heal': 'Routing heal',
    'missed-call-recovery': 'Missed-call recovery',
    'rebooking': 'Rebooking',
    'sync-self-heal': 'Sync self-heal'
  };

  function token(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }

  function loadSeen(){
    try{ const raw = JSON.parse(localStorage.getItem(KEY)||'[]'); return new Set(Array.isArray(raw) ? raw : []); }catch(e){ return new Set(); }
  }
  function saveSeen(set){
    try{ localStorage.setItem(KEY, JSON.stringify(Array.from(set).slice(-100))); }catch(e){}
  }

  // A run that did nothing ('skipped') is the normal hourly heartbeat —
  // announcing it every hour would be noise. Success/partial/failed are real.
  function shouldAnnounce(status){ return status === 'success' || status === 'partial' || status === 'failed'; }
  function toneFor(status){ return status === 'failed' ? 'error' : 'lead'; }
  function titleFor(run){
    const label = LABELS[run.agent] || 'Autopilot';
    if(run.status === 'failed') return 'Autopilot needs attention — ' + label;
    return 'Lola Autopilot — ' + label;
  }

  async function pollOnce(){
    if(!token() || !window.LolaNotify) return;
    try{
      const r = await fetch('/api/autopilot-notices', { headers:{ Authorization:'Bearer '+token() } });
      if(!r.ok) return;
      const d = await r.json();
      if(!d.ok || !Array.isArray(d.runs)) return;

      const seen = loadSeen();
      const fresh = d.runs.filter(x => x && x.id && !seen.has(x.id));
      if(!fresh.length) return;

      // First time this browser has ever asked: adopt current runs as the
      // baseline so a page load never announces last night's run history.
      if(localStorage.getItem(KEY) === null){
        fresh.forEach(x => seen.add(x.id));
        saveSeen(seen);
        return;
      }

      const toShow = fresh.filter(x => shouldAnnounce(x.status)).reverse(); // oldest first
      toShow.forEach((run, i) => {
        setTimeout(() => {
          if(!window.LolaNotify) return;
          window.LolaNotify.show({
            tone: toneFor(run.status),
            title: titleFor(run),
            sub: run.summary || (run.status + ' — no summary'),
            duration: run.status === 'failed' ? 7000 : 5000
          });
          if(typeof window.lolaPulse === 'function') window.lolaPulse(run.summary || '');
        }, i * 900);
      });

      fresh.forEach(x => seen.add(x.id));
      saveSeen(seen);
    }catch(e){ /* silent — announcements are best-effort, never break the app */ }
  }

  let timer = null;
  function start(){
    if(timer) return;
    pollOnce(); // baseline immediately
    timer = setInterval(pollOnce, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if(document.hidden){ clearInterval(timer); timer = null; }
      else if(!timer){ timer = setInterval(pollOnce, POLL_MS); pollOnce(); }
    });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
