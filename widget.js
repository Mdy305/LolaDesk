/*!
 * LolaDesk website widget v3 — drop Lola on any salon's site.
 * <script src="https://www.loladesk.com/widget.js" data-lola="SLUG" data-key="KEY" async></script>
 *
 * v3 upgrade: the launcher is now the real LolaOrb particle canvas —
 * same neon-pink neural network that lives in the dashboard, always
 * breathing, snapping to 'listening' when the visitor types, and
 * radiating in 'speaking' mode when Lola replies. Shadow DOM (never
 * fights the host site's CSS), persistent visitor identity, spring
 * animations, reduced-motion respected, zero external dependencies.
 */
(function(){
  'use strict';
  var script = document.currentScript || (function(){ var s=document.querySelectorAll('script[data-lola]'); return s[s.length-1]; })();
  if(!script) return;
  var SLUG   = script.getAttribute('data-lola') || '';
  var KEY    = script.getAttribute('data-key')  || '';
  if(!SLUG || !KEY) return;
  var ORIGIN  = (function(){ try{ return new URL(script.src).origin; }catch(e){ return 'https://www.loladesk.com'; } })();
  var API     = ORIGIN + '/api/widget-chat';
  var ORB_JS  = ORIGIN + '/lola-orb.js';
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── durable visitor identity ── */
  var VID; try{
    VID = localStorage.getItem('lola_vid');
    if(!VID){ VID = 'v'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('lola_vid',VID); }
  }catch(e){ VID = 'v'+Math.random().toString(36).slice(2); }

  /* ── shadow host ── */
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;width:0;height:0;';
  var root = host.attachShadow ? host.attachShadow({mode:'closed'}) : host;
  function attach(){ if(document.body && !host.parentNode) document.body.appendChild(host); }
  document.addEventListener('DOMContentLoaded', attach);
  attach();

  /* ── styles ── */
  var css = ''
  + ':host{all:initial}'
  + '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
  /* launcher: canvas wrapper replaces the old static .orb button */
  + '.launcher{position:fixed;bottom:22px;right:22px;width:64px;height:64px;border-radius:50%;cursor:pointer;border:none;background:none;padding:0;'
  +   'filter:drop-shadow(0 8px 24px rgba(255,45,142,.55));'
  +   'transition:transform .35s cubic-bezier(0.175, 0.885, 0.32, 1.2),filter .35s}'
  + '.launcher:hover{transform:scale(1.09);filter:drop-shadow(0 10px 32px rgba(255,45,142,.75))}'
  + '.launcher:active{transform:scale(.93)}'
  + '.launcher canvas{border-radius:50%;display:block}'
  /* fallback gradient shown before lola-orb.js loads */
  + '.launcher .fb{width:64px;height:64px;border-radius:50%;'
  +   'background:radial-gradient(circle at 32% 30%,#ff8fc0,#ff2d8e 55%,#7a1050);'
  +   'animation:wbreathe 3.2s ease-in-out infinite}'
  + '@keyframes wbreathe{0%,100%{box-shadow:0 0 0 0 rgba(255,45,142,.4)}50%{box-shadow:0 0 0 10px rgba(255,45,142,0)}}'
  + '.launcher .fb.hidden{opacity:0}'
  /* panel */
  + '.panel{position:fixed;bottom:100px;right:22px;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 130px));'
  +   'background:#141216;border:1px solid rgba(255,255,255,.09);border-radius:22px;display:flex;flex-direction:column;overflow:hidden;'
  +   'box-shadow:0 24px 80px rgba(0,0,0,.6);opacity:0;transform:translateY(18px) scale(.96);pointer-events:none;'
  +   'transition:opacity .4s cubic-bezier(0.175, 0.885, 0.32, 1.2),transform .4s cubic-bezier(0.175, 0.885, 0.32, 1.2)}'
  + '.panel.open{opacity:1;transform:none;pointer-events:auto}'
  /* header with mini orb */
  + '.hd{padding:14px 16px;display:flex;align-items:center;gap:11px;border-bottom:1px solid rgba(255,255,255,.07);'
  +   'background:linear-gradient(135deg,rgba(255,45,142,.16),transparent)}'
  + '.hdorb{width:36px;height:36px;border-radius:50%;flex:none;background:none;padding:0}'
  + '.hdorb canvas{border-radius:50%;display:block}'
  + '.hdorb .fb{width:36px;height:36px;border-radius:50%;'
  +   'background:radial-gradient(circle at 32% 30%,#ff8fc0,#ff2d8e 60%,#7a1050)}'
  + '.hn{color:#fff;font-size:14px;font-weight:600}.hs{color:#ff7fb8;font-size:11px}'
  + '.x{margin-left:auto;background:none;border:none;color:#888;font-size:22px;cursor:pointer;padding:4px 8px;line-height:1}'
  /* messages */
  + '.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}'
  + '.m{max-width:84%;padding:9px 13px;border-radius:16px;font-size:13.5px;line-height:1.45;color:#f2eef2;white-space:pre-wrap;word-wrap:break-word;'
  +   'animation:rise .35s cubic-bezier(0.175, 0.885, 0.32, 1.2)}'
  + '@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
  + '.ai{background:#221e26;border-bottom-left-radius:5px;align-self:flex-start}'
  + '.me{background:linear-gradient(135deg,#ff2d8e,#c2186f);align-self:flex-end;border-bottom-right-radius:5px}'
  + '.typing{display:inline-flex;gap:4px;padding:12px 14px}'
  + '.typing i{width:6px;height:6px;border-radius:50%;background:#ff7fb8;animation:tblink 1.1s infinite}'
  + '.typing i:nth-child(2){animation-delay:.18s}.typing i:nth-child(3){animation-delay:.36s}'
  + '@keyframes tblink{0%,70%,100%{opacity:.25;transform:none}35%{opacity:1;transform:translateY(-3px)}}'
  /* input */
  + '.ft{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.07)}'
  + '.in{flex:1;background:#1d1a21;border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:13.5px;padding:10px 12px;outline:none}'
  + '.in:focus{border-color:#ff2d8e;box-shadow:0 0 0 3px rgba(255,45,142,.15)}'
  + '.snd{background:linear-gradient(135deg,#ff2d8e,#c2186f);border:none;border-radius:12px;color:#fff;width:44px;cursor:pointer;font-size:16px;'
  +   'transition:transform .2s cubic-bezier(0.175, 0.885, 0.32, 1.2)}.snd:active{transform:scale(.92)}'
  /* footer */
  + '.by{color:#5a5560;font-size:9.5px;text-align:center;padding:0 0 8px}.by a{color:#8a8090;text-decoration:none}'
  /* reduced-motion */
  + '@media (prefers-reduced-motion:reduce){.launcher,.panel,.m,.snd,.fb{animation:none!important;transition:none!important}}';

  var style = document.createElement('style'); style.textContent = css; root.appendChild(style);

  /* ── launcher button (64px canvas + fallback gradient) ── */
  var launchBtn = document.createElement('button');
  launchBtn.className = 'launcher';
  launchBtn.setAttribute('aria-label','Chat with Lola');
  var launchFb  = document.createElement('div');  launchFb.className  = 'fb';
  var launchCvs = document.createElement('canvas'); launchCvs.width = launchCvs.height = 64; launchCvs.style.display = 'none';
  launchBtn.appendChild(launchFb);
  launchBtn.appendChild(launchCvs);
  root.appendChild(launchBtn);

  /* ── panel ── */
  var panel = document.createElement('div'); panel.className = 'panel'; root.appendChild(panel);

  /* Header mini-orb */
  var hdOrbWrap = document.createElement('div'); hdOrbWrap.className = 'hdorb';
  var hdFb      = document.createElement('div'); hdFb.className = 'fb'; hdOrbWrap.appendChild(hdFb);
  var hdCvs     = document.createElement('canvas'); hdCvs.width = hdCvs.height = 36; hdCvs.style.display = 'none'; hdOrbWrap.appendChild(hdCvs);

  var hdInfo = document.createElement('div');
  var hdName = document.createElement('div'); hdName.className = 'hn'; hdName.textContent = 'Lola';
  var hdSub  = document.createElement('div'); hdSub.className  = 'hs'; hdSub.textContent  = 'online now';
  hdInfo.appendChild(hdName); hdInfo.appendChild(hdSub);
  var closeBtn = document.createElement('button'); closeBtn.className = 'x'; closeBtn.setAttribute('aria-label','Close'); closeBtn.textContent = '×';

  var hd = document.createElement('div'); hd.className = 'hd';
  hd.appendChild(hdOrbWrap); hd.appendChild(hdInfo); hd.appendChild(closeBtn);

  var msgsEl = document.createElement('div'); msgsEl.className = 'msgs';
  var ft     = document.createElement('div'); ft.className = 'ft';
  var input  = document.createElement('input'); input.className='in'; input.type='text'; input.placeholder='Ask about services, prices, booking…'; input.maxLength=800;
  var snd    = document.createElement('button'); snd.className='snd'; snd.setAttribute('aria-label','Send'); snd.textContent='➤';
  ft.appendChild(input); ft.appendChild(snd);
  var byline = document.createElement('div'); byline.className='by';
  byline.innerHTML='powered by <a href="https://www.loladesk.com" target="_blank" rel="noopener">LolaDesk</a>';
  panel.appendChild(hd); panel.appendChild(msgsEl); panel.appendChild(ft); panel.appendChild(byline);

  /* ── LolaOrb live integration ── */
  var lolaOrb = null, hdOrb = null;
  var ORB_LOADED = false;

  function mountOrbs(){
    if(!window.LolaOrb || ORB_LOADED) return;
    ORB_LOADED = true;
    try{
      // Launcher orb (64px, always ambient)
      launchCvs.style.display = 'block';
      launchFb.classList.add('hidden');
      lolaOrb = window.LolaOrb.mount(launchCvs, { size: 64 });
      lolaOrb.setState('ambient');
      // Header mini orb (36px)
      hdCvs.style.display = 'block';
      hdFb.style.display = 'none';
      hdOrb = window.LolaOrb.mount(hdCvs, { size: 36 });
      hdOrb.setState('ambient');
    }catch(e){ ORB_LOADED = false; }
  }

  // Load lola-orb.js from LolaDesk origin — separate script tag so it
  // shares the CDN cache with the dashboard. Gracefully degrades to the
  // fallback gradient if the load fails.
  (function loadOrbScript(){
    if(window.LolaOrb){ mountOrbs(); return; }
    var s = document.createElement('script');
    s.src = ORB_JS; s.async = true;
    s.onload  = mountOrbs;
    s.onerror = function(){}; // fallback gradient already visible
    document.head.appendChild(s);
  })();

  function orbState(state, duration){
    if(!lolaOrb) return;
    lolaOrb.setState(state);
    if(hdOrb) hdOrb.setState(state);
    if(duration){
      setTimeout(function(){
        if(lolaOrb) lolaOrb.setState('ambient');
        if(hdOrb)   hdOrb.setState('ambient');
      }, duration);
    }
  }

  /* ── messages ── */
  function add(kind, text){
    var d = document.createElement('div'); d.className = 'm ' + kind; d.textContent = text;
    msgsEl.appendChild(d); msgsEl.scrollTop = msgsEl.scrollHeight; return d;
  }
  function setTyping(on){
    var t = msgsEl.querySelector('.typing');
    if(on && !t){ t = document.createElement('div'); t.className='m ai typing'; t.innerHTML='<i></i><i></i><i></i>'; msgsEl.appendChild(t); msgsEl.scrollTop = msgsEl.scrollHeight; }
    if(!on && t) t.remove();
  }

  /* ── panel toggle ── */
  var opened = false, greeted = false, busy = false;
  function toggle(open){
    opened = (open === undefined) ? !opened : open;
    panel.classList.toggle('open', opened);
    if(opened && !greeted){
      greeted = true;
      orbState('thinking');
      fetch(API + '?slug=' + encodeURIComponent(SLUG) + '&key=' + encodeURIComponent(KEY))
        .then(function(r){ return r.json(); })
        .then(function(cfg){
          hdName.textContent = 'Lola · ' + (cfg.name || 'your salon');
          var greeting = cfg.greeting || "Hi! I'm Lola 💗 Ask me about services, prices, or booking.";
          add('ai', greeting);
          orbState('speaking', 2200); // pulse pink for 2.2s then back to ambient
        })
        .catch(function(){
          add('ai', "Hi! I'm Lola 💗 Ask me about services, prices, or booking.");
          orbState('ambient');
        });
    }
    if(opened) setTimeout(function(){ input.focus(); }, REDUCED ? 0 : 380);
  }
  launchBtn.addEventListener('click', function(){ toggle(); });
  closeBtn.addEventListener('click',  function(){ toggle(false); });

  /* ── send message ── */
  function submit(){
    var text = input.value.trim();
    if(!text || busy) return;
    busy = true; input.value = '';
    add('me', text);
    setTyping(true);
    orbState('thinking');
    fetch(API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ slug:SLUG, key:KEY, visitor_id:VID, message:text })
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      setTyping(false);
      busy = false;
      var reply = (d && d.reply) ? d.reply : "Hmm, say that again?";
      add('ai', reply);
      orbState('speaking', 2400); // orb radiates while Lola "speaks" the reply
    })
    .catch(function(){
      setTyping(false); busy = false;
      add('ai', "I lost you for a second — try once more?");
      orbState('ambient');
    });
  }

  snd.addEventListener('click', submit);
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); });
  // Orb goes to 'listening' while visitor is typing — feels responsive
  input.addEventListener('input', function(){
    if(input.value.trim() && !busy) orbState('listening');
    else if(!busy) orbState('ambient');
  });
})();
