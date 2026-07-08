/*!
 * LolaDesk website widget — drop Lola on any salon's site.
 * <script src="https://www.loladesk.com/widget.js" data-lola="SLUG" data-key="KEY" async></script>
 *
 * Shadow DOM (never fights the host site's CSS), one spring curve,
 * persistent visitor identity (Lola remembers returning visitors),
 * reduced-motion respected, ~zero dependencies.
 */
(function(){
  'use strict';
  var script = document.currentScript || (function(){ var s=document.querySelectorAll('script[data-lola]'); return s[s.length-1]; })();
  if(!script) return;
  var SLUG = script.getAttribute('data-lola') || '';
  var KEY  = script.getAttribute('data-key') || '';
  if(!SLUG || !KEY) return;
  var ORIGIN = (function(){ try{ return new URL(script.src).origin; }catch(e){ return 'https://www.loladesk.com'; } })();
  var API = ORIGIN + '/api/widget-chat';
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* durable visitor identity → Lola remembers returning visitors */
  var VID; try{
    VID = localStorage.getItem('lola_vid');
    if(!VID){ VID = 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lola_vid', VID); }
  }catch(e){ VID = 'v' + Math.random().toString(36).slice(2); }

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;width:0;height:0;';
  var root = host.attachShadow ? host.attachShadow({mode:'closed'}) : host;
  document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(host); });
  if(document.body) document.body.appendChild(host);

  var css = ''
  + ':host{all:initial}'
  + '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
  + '.orb{position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;cursor:pointer;border:none;'
  +   'background:radial-gradient(circle at 32% 30%,#e6ff85,#ccff00 55%,#3a5a00);box-shadow:0 8px 30px rgba(204,255,0,.45);'
  +   'transition:transform .35s cubic-bezier(.22,1,.36,1),box-shadow .35s;animation:breathe 3.2s ease-in-out infinite}'
  + '.orb:hover{transform:scale(1.08)}.orb:active{transform:scale(.94)}'
  + '@keyframes breathe{0%,100%{box-shadow:0 8px 30px rgba(204,255,0,.45)}50%{box-shadow:0 8px 44px rgba(204,255,0,.7)}}'
  + '.panel{position:fixed;bottom:96px;right:22px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 130px));'
  +   'background:#141216;border:1px solid rgba(255,255,255,.09);border-radius:20px;display:flex;flex-direction:column;overflow:hidden;'
  +   'box-shadow:0 24px 80px rgba(0,0,0,.55);opacity:0;transform:translateY(14px) scale(.97);pointer-events:none;'
  +   'transition:opacity .4s cubic-bezier(.22,1,.36,1),transform .4s cubic-bezier(.22,1,.36,1)}'
  + '.panel.open{opacity:1;transform:none;pointer-events:auto}'
  + '.hd{padding:14px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.07);'
  +   'background:linear-gradient(135deg,rgba(204,255,0,.16),transparent)}'
  + '.dot{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#e6ff85,#ccff00 60%,#3a5a00);flex:none}'
  + '.hn{color:#fff;font-size:14px;font-weight:600}.hs{color:#dcff66;font-size:11px}'
  + '.x{margin-left:auto;background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px}'
  + '.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}'
  + '.m{max-width:82%;padding:9px 13px;border-radius:15px;font-size:13.5px;line-height:1.45;color:#f2eef2;white-space:pre-wrap;word-wrap:break-word;'
  +   'animation:rise .35s cubic-bezier(.22,1,.36,1)}'
  + '@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
  + '.ai{background:#221e26;border-bottom-left-radius:5px;align-self:flex-start}'
  + '.me{background:linear-gradient(135deg,#ccff00,#8fd400);align-self:flex-end;border-bottom-right-radius:5px;color:#10140a}'
  + '.typing{display:inline-flex;gap:4px;padding:12px 14px}.typing i{width:6px;height:6px;border-radius:50%;background:#dcff66;animation:blink 1.1s infinite}'
  + '.typing i:nth-child(2){animation-delay:.18s}.typing i:nth-child(3){animation-delay:.36s}'
  + '@keyframes blink{0%,70%,100%{opacity:.25;transform:none}35%{opacity:1;transform:translateY(-3px)}}'
  + '.ft{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.07)}'
  + '.in{flex:1;background:#1d1a21;border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:13.5px;padding:10px 12px;outline:none}'
  + '.in:focus{border-color:#ccff00;box-shadow:0 0 0 3px rgba(204,255,0,.15)}'
  + '.snd{background:linear-gradient(135deg,#ccff00,#8fd400);border:none;border-radius:12px;color:#10140a;width:44px;cursor:pointer;font-size:16px;'
  +   'transition:transform .2s cubic-bezier(.22,1,.36,1)}.snd:active{transform:scale(.92)}'
  + '.by{color:#5a5560;font-size:9.5px;text-align:center;padding:0 0 8px}.by a{color:#8a8090;text-decoration:none}'
  + '@media (prefers-reduced-motion: reduce){.orb,.panel,.m,.snd{animation:none!important;transition:none!important}}';

  var style = document.createElement('style'); style.textContent = css; root.appendChild(style);

  var orb = document.createElement('button'); orb.className = 'orb'; orb.setAttribute('aria-label','Chat with Lola'); root.appendChild(orb);
  var panel = document.createElement('div'); panel.className = 'panel'; root.appendChild(panel);
  panel.innerHTML = '<div class="hd"><div class="dot"></div><div><div class="hn">Lola</div><div class="hs">online now</div></div><button class="x" aria-label="Close">×</button></div>'
    + '<div class="msgs"></div>'
    + '<div class="ft"><input class="in" type="text" placeholder="Ask about services, prices, booking…" maxlength="800"><button class="snd" aria-label="Send">➤</button></div>'
    + '<div class="by">powered by <a href="https://www.loladesk.com" target="_blank" rel="noopener">LolaDesk</a></div>';

  var msgs = panel.querySelector('.msgs'), input = panel.querySelector('.in'), send = panel.querySelector('.snd');
  var opened = false, greeted = false, busy = false;

  function add(kind, text){
    var d = document.createElement('div'); d.className = 'm ' + kind; d.textContent = text;
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function typing(on){
    var t = msgs.querySelector('.typing');
    if(on && !t){ t = document.createElement('div'); t.className='m ai typing'; t.innerHTML='<i></i><i></i><i></i>'; msgs.appendChild(t); msgs.scrollTop = msgs.scrollHeight; }
    if(!on && t) t.remove();
  }

  function toggle(open){
    opened = open === undefined ? !opened : open;
    panel.classList.toggle('open', opened);
    if(opened && !greeted){
      greeted = true;
      fetch(API + '?slug=' + encodeURIComponent(SLUG) + '&key=' + encodeURIComponent(KEY))
        .then(function(r){ return r.json(); })
        .then(function(cfg){
          panel.querySelector('.hn').textContent = 'Lola · ' + (cfg.name || 'your salon');
          add('ai', cfg.greeting || "Hi! I'm Lola 💗 Ask me about services, prices, or booking.");
        })
        .catch(function(){ add('ai', "Hi! I'm Lola 💗 Ask me about services, prices, or booking."); });
    }
    if(opened) setTimeout(function(){ input.focus(); }, REDUCED ? 0 : 380);
  }
  orb.addEventListener('click', function(){ toggle(); });
  panel.querySelector('.x').addEventListener('click', function(){ toggle(false); });

  function submit(){
    var text = input.value.trim();
    if(!text || busy) return;
    busy = true; input.value = '';
    add('me', text); typing(true);
    fetch(API, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ slug: SLUG, key: KEY, visitor_id: VID, message: text }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ typing(false); busy = false; add('ai', d && d.reply ? d.reply : "Hmm, say that again?"); })
      .catch(function(){ typing(false); busy = false; add('ai', "I lost you for a second — try once more?"); });
  }
  send.addEventListener('click', submit);
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); });
})();
