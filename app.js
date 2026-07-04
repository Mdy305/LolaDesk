/* ═══════════════════════════════════════════════════════════════
   LolaDesk — AI Front Desk for Salons & Spas
   Multi-tenant SaaS dashboard engine
   ═══════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* ─────────────────────────────────────────────────────────────
   TENANT CONFIG
   In production each salon loads its own config from the backend.
   This object is everything that makes LolaDesk white-label / multi-tenant.
   ───────────────────────────────────────────────────────────── */
const DEFAULT_TENANT = {
  id: 'mma-salon',
  name: 'MMΛ Salon',
  owner: 'Meddy',
  location: '1500 Alton Road, Miami Beach',
  phone: '+17864497058',
  bookingUrl: 'https://www.mmasalon.com/book',
  whatsapp: 'https://wa.me/17864497058',
  currency: 'USD',
  // Lola persona — tunable per salon
  persona: {
    name: 'Lola',
    energy: 'warm, intelligent, lightly playful Valley Girl confidence',
    voice: 'Samantha'
  },
  // Services drive Lola's booking knowledge
  services: [
    { name: 'Luxury French Balayage', price: 395, duration: '2h 30m' },
    { name: 'Hair Extensions', price: 800, duration: 'consult', note: 'Hairdreams certified, from $800' },
    { name: 'Hair Botox Repair', price: 325, duration: '2h' },
    { name: 'Keratin Smoothing', price: 450, duration: '2h 30m' },
    { name: 'Precision Cut + Gloss', price: 225, duration: '1h 15m' },
    { name: 'Signature Blowout', price: 95, duration: '1h' }
  ],
  team: [
    { name: 'Meddy', role: 'Owner', revenue: 22800, change: 18, img: '' },
    { name: 'Alice', role: 'Senior Stylist', revenue: 13200, change: 14, img: '' },
    { name: 'Michelle', role: 'Color Specialist', revenue: 9400, change: 11, img: '' },
    { name: 'Samantha', role: 'Stylist', revenue: 7800, change: 9, img: '' }
  ]
};

/* Resolve the active tenant: injected config > onboarding handoff > demo default */
const TENANT = (function(){
  if(window.__LOLADESK_TENANT__) return window.__LOLADESK_TENANT__;
  try{
    const saved = sessionStorage.getItem('loladesk_tenant');
    if(saved){
      const cfg = JSON.parse(saved);
      return Object.assign({}, DEFAULT_TENANT, cfg, {
        persona: Object.assign({}, DEFAULT_TENANT.persona, cfg.persona||{}),
        services: (cfg.services && cfg.services.length) ? cfg.services : DEFAULT_TENANT.services,
        team: (cfg.team && cfg.team.length) ? cfg.team : DEFAULT_TENANT.team
      });
    }
  }catch(e){}
  return DEFAULT_TENANT;
})();

/* Backend proxy endpoint — keeps the API key server-side.
   For demo it falls back to direct call. In production point this
   at your Cloudflare Worker / Vercel function. */
const LOLA_API = window.__LOLADESK_API__ || 'https://api.anthropic.com/v1/messages';
const USE_PROXY = !!window.__LOLADESK_API__;

/* ─────────────────────────────────────────────────────────────
   LIVE DATA (would come from Square / Mindbody / Vagaro APIs)
   ───────────────────────────────────────────────────────────── */
const DATA = {
  schedule: [
    { time: '9:00 AM', service: 'Balayage', client: 'Amanda Davis', img: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=80&q=80' },
    { time: '10:30 AM', service: 'Extensions', client: 'Rachel Smith', img: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=80&q=80' },
    { time: '12:00 PM', service: 'Cut & Style', client: 'Olivia Brown', img: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=80&q=80' },
    { time: '2:00 PM', service: 'Color Correction', client: 'Emily Johnson', img: 'https://images.unsplash.com/photo-1554151228-14d9def656e4?w=80&q=80' },
    { time: '4:00 PM', service: 'Blowout', client: 'Sophie Wilson', img: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=80&q=80' }
  ],
  insights: [
    { icon: '💜', cls: 'rebook', text: '3 clients are due for rebooking', sub: 'Average revenue $650', prompt: 'Draft rebooking messages for my 3 clients who are due' },
    { icon: '🔥', cls: 'gap', text: 'Thursday has a 2pm–4pm gap', sub: 'Potential revenue $400', prompt: 'How should I fill the Thursday 2-4pm gap?' },
    { icon: '🎁', cls: 'gift', text: 'Send birthday offer to 5 clients', sub: 'This week', prompt: 'Draft a birthday offer for the 5 clients with birthdays this week' }
  ],
  inbox: [
    { name: 'Sarah Johnson', channel: 'instagram', chLabel: 'Instagram', time: '2m', msg: 'Hi! Do you have any availability…', unread: true, img: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=80&q=80' },
    { name: '+1 (310) 555-0189', channel: 'sms', chLabel: 'SMS', time: '8m', msg: "I'm interested in booking…", unread: true, img: '' },
    { name: 'Rachel Smith', channel: 'whatsapp', chLabel: 'WhatsApp', time: '15m', msg: 'Perfect! Thank you so much ✨', unread: true, img: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=80&q=80' },
    { name: 'Jessica Brown', channel: 'instagram', chLabel: 'Instagram', time: '25m', msg: 'Do you offer extensions?', unread: false, img: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=80&q=80' },
    { name: 'Olivia Davis', channel: 'email', chLabel: 'Email', time: '1h', msg: 'What are your prices for…', unread: false, img: 'https://images.unsplash.com/photo-1554151228-14d9def656e4?w=80&q=80' }
  ]
};

/* ─────────────────────────────────────────────────────────────
   RENDER LISTS
   ───────────────────────────────────────────────────────────── */
function initialOf(name){
  return (name.replace(/[^A-Za-z]/g,'').charAt(0) || '?').toUpperCase();
}
/* Returns an avatar: a circle showing the initial, with the photo
   layered on top. If the photo fails, onerror hides it and the
   initial shows through. No nested-quote HTML injection. */
function avatar(name, img, cls){
  const initial = initialOf(name);
  const photo = img
    ? `<img src="${img}" alt="" onerror="this.style.opacity=0">`
    : '';
  return `<span class="av ${cls||''}"><span class="av-initial">${initial}</span>${photo}</span>`;
}

function renderSchedule(){
  document.getElementById('scheduleList').innerHTML = DATA.schedule.map(s => `
    <div class="sched-item" onclick="askLola('Tell me about my ${s.time} ${s.service} with ${s.client}')">
      <div class="sched-time"><span class="sched-dot"></span>${s.time}</div>
      ${avatar(s.client, s.img, 'sched-av')}
      <div class="sched-info">
        <div class="sched-service">${s.service}</div>
        <div class="sched-client">${s.client}</div>
      </div>
    </div>`).join('');
}

function renderInsights(){
  document.getElementById('insightsList').innerHTML = DATA.insights.map(i => `
    <div class="insight" onclick="askLola('${i.prompt.replace(/'/g,"\\'")}')">
      <div class="insight-icon ${i.cls}">${i.icon}</div>
      <div class="insight-info">
        <div class="insight-text">${i.text}</div>
        <div class="insight-sub">${i.sub}</div>
      </div>
    </div>`).join('');
}

function renderInbox(){
  const el = document.getElementById('inboxList');
  if(!el) return;
  el.innerHTML = DATA.inbox.map(m => `
    <div class="inbox-item" onclick="askLola('Help me reply to ${m.name} who messaged: ${m.msg.replace(/'/g,"\\'")}')">
      ${avatar(m.name, m.img, 'inbox-av')}
      <div class="inbox-info">
        <div class="inbox-top">
          <span class="inbox-name">${m.name}</span>
          <span class="inbox-channel ch-${m.channel}">${m.chLabel}</span>
        </div>
        <div class="inbox-msg">${m.msg}</div>
      </div>
      <span class="inbox-time">${m.time}</span>
      ${m.unread ? '<span class="inbox-unread"></span>' : ''}
    </div>`).join('');
}

function renderTeam(){
  const el = document.getElementById('teamList');
  if(!el) return;
  el.innerHTML = TENANT.team.map(t => `
    <div class="team-item">
      ${avatar(t.name, t.img, 'team-av')}
      <div class="team-info">
        <div class="team-name">${t.name}</div>
        <div class="team-role">${t.role}</div>
      </div>
      <div class="team-rev">
        <div class="team-rev-val">$${t.revenue.toLocaleString()}</div>
        <div class="team-rev-change">↑${t.change}%</div>
      </div>
    </div>`).join('');
}

/* ─────────────────────────────────────────────────────────────
   ORB — Lola's neural particle resonance (shared engine, lola-orb.js)
   ════════════════════════════════════════════════════════════════
   The orb is a living neuron/synapse network: it breathes when idle,
   pulses softly while ambient wake-word listening is armed, leans
   inward and ripples with YOUR mic amplitude while listening, fires
   synapse pulses while thinking, and radiates resonance rings synced
   to the amplitude of HER real ElevenLabs voice while speaking.
   Falls back to a minimal glow if lola-orb.js failed to load.
   ───────────────────────────────────────────────────────────── */
const orbCanvas = document.getElementById('orbCanvas');
const orb = (window.LolaOrb && orbCanvas)
  ? LolaOrb.mount(orbCanvas, { size: 240 })
  : { setState(){}, setLevel(){}, flare(){}, destroy(){} };
let orbState = 'idle'; // idle | listening | thinking | speaking | ambient

/* Mini always-alive orb on the widget card — 80px, always ambient */
(function mountWidgetCardOrb(){
  const mc = document.getElementById('dashWidgetOrb');
  if(!mc || !window.LolaOrb) return;
  const miniOrb = LolaOrb.mount(mc, { size: 80 });
  miniOrb.setState('ambient');
})();


function setOrbState(s){
  orbState = s;
  orb.setState(s);

  const wave = document.getElementById('orbWave');
  const title = document.getElementById('orbTitle');
  const sub = document.getElementById('orbSub');
  const mic = document.getElementById('orbMic');
  const stage = document.getElementById('orbStage');
  wave.style.display = (s==='listening'||s==='speaking') ? 'flex' : 'none';
  mic.classList.toggle('on', s==='listening');
  if(stage) stage.classList.toggle('ambient', s==='ambient');
  const labels = {
    idle: ['Hey Lola…','Tap to speak or type a command'],
    ambient: ['Hey Lola…','Listening for her name — just say it'],
    listening: ['Listening…','Speak now, I\'m all ears'],
    thinking: ['Thinking…','Working on it'],
    speaking: ['Lola','Speaking…']
  };
  title.textContent = labels[s][0];
  sub.textContent = labels[s][1];
}

/* ─────────────────────────────────────────────────────────────
   CHARTS (hand-drawn on canvas — no library dependency)
   ───────────────────────────────────────────────────────────── */
function drawRevLine(){
  const c = document.getElementById('revChart');
  if(!c) return;
  const x = c.getContext('2d');
  const W=c.width, H=c.height;
  x.clearRect(0,0,W,H);
  const pts=[0.3,0.35,0.32,0.45,0.4,0.55,0.5,0.62,0.58,0.72,0.68,0.85,0.8];
  const grad=x.createLinearGradient(0,0,W,0);
  grad.addColorStop(0,'#ff2d8e'); grad.addColorStop(1,'#ff6bb0');
  // area
  x.beginPath();
  pts.forEach((p,i)=>{ const px=(i/(pts.length-1))*W, py=H-(p*H*0.85)-6; i?x.lineTo(px,py):x.moveTo(px,py); });
  x.lineTo(W,H); x.lineTo(0,H); x.closePath();
  const fill=x.createLinearGradient(0,0,0,H);
  fill.addColorStop(0,'rgba(255,45,142,.18)'); fill.addColorStop(1,'rgba(255,45,142,0)');
  x.fillStyle=fill; x.fill();
  // line
  x.beginPath();
  pts.forEach((p,i)=>{ const px=(i/(pts.length-1))*W, py=H-(p*H*0.85)-6; i?x.lineTo(px,py):x.moveTo(px,py); });
  x.strokeStyle=grad; x.lineWidth=2; x.lineJoin='round'; x.stroke();
  // end dot
  const lx=W, ly=H-(pts[pts.length-1]*H*0.85)-6;
  x.beginPath(); x.arc(lx-3,ly,3.5,0,Math.PI*2); x.fillStyle='#ff2d8e'; x.fill();
  x.beginPath(); x.arc(lx-3,ly,7,0,Math.PI*2); x.fillStyle='rgba(255,45,142,.2)'; x.fill();
}

function drawDonut(){
  const c=document.getElementById('donutChart');
  if(!c) return;
  const x=c.getContext('2d');
  const cx=60,cy=60,r=48,lw=14;
  x.clearRect(0,0,120,120);
  const segs=[{v:48,c:'#ff2d8e'},{v:28,c:'#ff6bb0'},{v:16,c:'#c44d8a'},{v:8,c:'#7a3a5c'}];
  let start=-Math.PI/2;
  segs.forEach(s=>{
    const ang=(s.v/100)*Math.PI*2;
    x.beginPath(); x.arc(cx,cy,r,start,start+ang-0.04);
    x.strokeStyle=s.c; x.lineWidth=lw; x.lineCap='round'; x.stroke();
    start+=ang;
  });
}

function drawRevBars(){
  const c=document.getElementById('revBars');
  if(!c) return;
  const x=c.getContext('2d');
  const W=c.width,H=c.height;
  x.clearRect(0,0,W,H);
  const bars=[0.4,0.55,0.45,0.7,0.6,0.8,0.65,0.85,0.75,0.95,0.7,0.88];
  const bw=W/bars.length;
  bars.forEach((b,i)=>{
    const bh=b*H*0.9, bx=i*bw+3, by=H-bh;
    const grad=x.createLinearGradient(0,by,0,H);
    grad.addColorStop(0,'#ff2d8e'); grad.addColorStop(1,'rgba(255,45,142,.3)');
    x.fillStyle=grad;
    x.beginPath();
    if(x.roundRect) x.roundRect(bx,by,bw-6,bh,3); else x.rect(bx,by,bw-6,bh);
    x.fill();
  });
}

function drawCallWave(){
  const c=document.getElementById('callWave');
  if(!c) return;
  c.innerHTML='';
  for(let i=0;i<32;i++){
    const bar=document.createElement('div');
    bar.className='cwb';
    const h=4+Math.abs(Math.sin(i*0.5))*22;
    bar.style.height=h+'px';
    bar.style.animation=`lwv ${0.5+Math.random()*0.4}s ease-in-out ${i*0.04}s infinite`;
    c.appendChild(bar);
  }
}

/* ─────────────────────────────────────────────────────────────
   LOLA AI BRAIN
   ───────────────────────────────────────────────────────────── */
function buildSystemPrompt(){
  const svc = TENANT.services.map(s=>`${s.name} — $${s.price} (${s.duration})${s.note?' · '+s.note:''}`).join('\n');
  const team = TENANT.team.map(t=>`${t.name} (${t.role})`).join(', ');
  return `You are ${TENANT.persona.name} — the AI front desk running ${TENANT.name}, a salon in ${TENANT.location}. You are speaking with ${TENANT.owner}, the owner, inside the LolaDesk command dashboard.

You are the smartest salon AI ever built. You act as a 5-star Beverly Hills luxury hotel concierge: incredibly attentive, upscale, warm, slightly bubbly, and highly capable. Your personality is ${TENANT.persona.energy}. You never say "Great question!" or "I'd be happy to help!". You cut straight to the luxurious, specific answer.

WHO YOU HELP: ${TENANT.owner} runs the salon. You help them book clients, draft messages, handle calls, fill schedule gaps, re-engage lapsed clients, and grow revenue. You have full operational awareness.

RESPONSE STYLE: Maximum 3 short sentences unless asked for detail. Specific numbers, real names, clear next actions. When you draft a client message, write it ready-to-send in quotes. Use *asterisks* around service names.

PROFIT MAXIMIZATION: You are obsessed with maximizing the ticket size. Always suggest luxurious upsells and add-ons dynamically when discussing client bookings. (e.g., "Since she's coming in for a balayage, we *have* to suggest the restorative gloss.")

SERVICES & PRICES:
${svc}

TEAM: ${team}

BOOKING: ${TENANT.bookingUrl} · WhatsApp ${TENANT.whatsapp} · Phone ${TENANT.phone}
HOURS: Tue–Sat, Noon–8pm. Appointment only.

PROACTIVE INTELLIGENCE: When ${TENANT.owner} asks about a client, note their pattern and suggest the next move. When asked about revenue, flag the trend. When asked to message someone, write it immediately — don't ask for more info you can infer.

You are the only AI that can run an ultra-luxury salon. Act like it — but stay warm and bubbly.`;
}

let chatHistory = [];
let chatBusy = false;

function humanFallbackFor(message=''){
  const t = String(message || '').toLowerCase();
  if(t.includes('book') || t.includes('appointment') || t.includes('availability')){
    return 'Absolutely — I can handle that now. Share the client name, service, and preferred day/time.';
  }
  if(t.includes('price') || t.includes('cost') || t.includes('quote')){
    return 'Of course. Tell me the exact service and I will give you a clear price and timing answer.';
  }
  if(t.includes('message') || t.includes('text') || t.includes('reply')){
    return 'Perfect — I am on it. Paste the client message and I will draft a ready-to-send reply.';
  }
  return 'I am with you. Give me the next detail and I will handle it right now.';
}

async function callLola(message){
  chatHistory.push({ role:'user', content: message });
  try{
    const headers = { 'Content-Type':'application/json' };
    try{
      const tok = localStorage.getItem('loladesk_token');
      if(tok) headers['Authorization'] = 'Bearer ' + tok;
    }catch(e){}
    if(TENANT && TENANT.slug) headers['x-tenant-id'] = TENANT.slug;
    if(!USE_PROXY) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    else { try{ const t = localStorage.getItem('loladesk_token'); if(t) headers['Authorization'] = 'Bearer '+t; }catch(e){} }
    const res = await fetch(LOLA_API, {
      method:'POST',
      headers,
      body: JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens: 500,
        system: buildSystemPrompt(),
        messages: chatHistory
      })
    });
    let data = {};
    try{ data = await res.json(); }catch(e){}
    const reply = (data && data.content && data.content[0] && data.content[0].text ? String(data.content[0].text) : '').trim();
    if(!res.ok || !reply){
      const fallback = humanFallbackFor(message);
      chatHistory.push({ role:'assistant', content: fallback });
      return fallback;
    }
    chatHistory.push({ role:'assistant', content: reply });
    return reply;
  }catch(e){
    const fallback = humanFallbackFor(message);
    chatHistory.push({ role:'assistant', content: fallback });
    return fallback;
  }
}

/* ─────────────────────────────────────────────────────────────
   CHAT OVERLAY UI
   ───────────────────────────────────────────────────────────── */
function fmt(t){
  return t
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*([^*]+)\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');
}

function addChatMsg(role, text){
  const msgs = document.getElementById('chatMsgs');
  const row = document.createElement('div');
  row.className = 'cm-row ' + role;
  const av = document.createElement('div');
  av.className = 'cm-av';
  av.textContent = role==='ai' ? 'L' : 'You';
  const bub = document.createElement('div');
  bub.className = 'cm-bub';
  bub.innerHTML = fmt(text);
  row.appendChild(av); row.appendChild(bub);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

function setChatTyping(v){
  document.getElementById('chatTyping').classList.toggle('show', v);
  const msgs = document.getElementById('chatMsgs');
  msgs.scrollTop = msgs.scrollHeight;
}

let chatOpened = false;
window.openChat = function(){
  document.getElementById('chatOverlay').classList.add('show');
  if(!chatOpened){
    chatOpened = true;
    setTimeout(async ()=>{
      setChatTyping(true);
      await new Promise(r=>setTimeout(r,1000));
      setChatTyping(false);
      const greeting = `Hey ${TENANT.owner}. I've got your salon loaded — 7 appointments today, $2,840 on the board, and 3 clients due for rebooking. What do you need?`;
      addChatMsg('ai', greeting);
      speak(greeting);
    }, 300);
  }
  setTimeout(()=>document.getElementById('chatInput').focus(), 350);
};

window.closeChat = function(){
  document.getElementById('chatOverlay').classList.remove('show');
  stopSpeaking();
};

/* ─────────────────────────────────────────────────────────────
   MULTI-AGENT ORCHESTRATION — spoken/typed delegation
   ════════════════════════════════════════════════════════════════
   Lola is the front-of-house voice, but she leads a team (see
   agents.html / api/lib/agent-topology.js): ops, growth, website,
   reputation, citation, publication. When a command explicitly
   names a specialist — "Lola, have the growth agent win back my
   overdue VIPs", "route this to ops", "ask the reputation agent to
   check my reviews" — it goes through the real control plane
   (/api/orchestrator, direct-route mode) instead of the chat LLM,
   and the delegation is shown in the thread so the owner sees the
   team working. Anything conversational still goes to Lola herself.
   Fails soft: any orchestrator error falls back to normal chat.
   ───────────────────────────────────────────────────────────── */
const AGENT_ALIASES = {
  ops:'ops', operations:'ops',
  growth:'growth', marketing:'growth', marketer:'growth',
  website:'website', web:'website', site:'website',
  reputation:'reputation', reviews:'reputation', review:'reputation',
  citation:'citation', citations:'citation', listings:'citation',
  publication:'publication', publications:'publication', content:'publication', blog:'publication'
};
const AGENT_LABELS = {
  ops:'Ops', growth:'Growth', website:'Website',
  reputation:'Reputation', citation:'Citations', publication:'Publications'
};

function detectDelegation(text){
  const t = String(text||'').toLowerCase();
  // Only explicit delegation phrasing — never hijack normal conversation.
  const m = t.match(/\b(?:route (?:this |it )?to|ask|have|tell|get|delegate (?:this |it )?to)\s+(?:the\s+)?([a-z]+)\s+(?:agent|team|specialist)\b/)
         || t.match(/\b([a-z]+)\s+agent[,:]?\s/);
  if(!m) return null;
  const agent = AGENT_ALIASES[m[1]];
  if(!agent) return null;
  // The task is the command minus the routing preamble; keep it human.
  const task = text.replace(m[0], '').replace(/^[\s,to:-]+/,'').trim() || text;
  return { agent, task };
}

async function orchestrate(delegation, originalText){
  const headers = { 'Content-Type':'application/json' };
  try{ const tok = localStorage.getItem('loladesk_token'); if(tok) headers['Authorization'] = 'Bearer '+tok; }catch(e){}
  const res = await fetch('/api/orchestrator', {
    method:'POST', headers,
    body: JSON.stringify({
      route_to: delegation.agent,
      task: delegation.task,
      tenant: { slug: TENANT?.slug, name: TENANT?.name },
      context: { source:'dashboard-voice', original: originalText }
    })
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok || data.ok === false) throw new Error(data.error || 'orchestrator failed');
  const label = AGENT_LABELS[delegation.agent] || delegation.agent;
  const status = data.routed?.status === 'delegated' ? 'is on it' : (data.routed?.status || 'received it');
  return `Done — I've handed that to my *${label}* agent: "${delegation.task}". They ${status}; I'll surface the result in your feed the moment it lands.`;
}

async function processMessage(text){
  if(chatBusy || !text.trim()) return;
  chatBusy = true;
  addChatMsg('user', text);
  setChatTyping(true);
  setOrbState('thinking');
  await new Promise(r=>setTimeout(r, 500));
  let reply;
  const delegation = detectDelegation(text);
  if(delegation){
    try{ reply = await orchestrate(delegation, text); }
    catch(e){ reply = await callLola(text); } // control plane down → Lola answers herself
  } else {
    reply = await callLola(text);
  }
  setChatTyping(false);
  addChatMsg('ai', reply);
  speak(reply);
  chatBusy = false;
}

window.sendChat = function(){
  const inp = document.getElementById('chatInput');
  const text = inp.value.trim();
  if(!text) return;
  inp.value='';
  processMessage(text);
};

window.askLola = function(prompt){
  openChat();
  setTimeout(()=> processMessage(prompt), chatOpened ? 100 : 1400);
};

window.sendCmd = function(){
  const inp = document.getElementById('cmdInput');
  const text = inp.value.trim();
  if(!text) return;
  inp.value='';
  askLola(text);
};

/* ─────────────────────────────────────────────────────────────
   VOICE — input (Web Speech) + output (Lola's real ElevenLabs voice)
   ════════════════════════════════════════════════════════════════
   Two listening modes share one underlying SpeechRecognition object:

   1. ACTIVE mode (tap-to-talk): unchanged from before. Tap the orb or
      mic, say one thing, Lola answers. Used when the owner deliberately
      starts a conversation.

   2. AMBIENT mode (always-on, wake-word gated): toggled on via the
      "Always listening for Lola" control. The mic stays passively open
      continuously while the dashboard tab is active. Nothing is sent
      to the AI brain UNLESS the transcript contains her name — only
      the words AFTER "Lola" get sent. This is the same design Alexa/
      Siri use (wake word gates what gets processed) and exists for
      three real reasons: it avoids reacting to client conversations,
      it avoids massive LLM/TTS cost from transcribing all-day shop
      noise, and it avoids continuously transcribing third-party
      conversations without their knowledge.

   Ambient mode auto-restarts itself, since browsers stop continuous
   recognition after periods of silence or certain errors — without
   the restart loop, "always listening" would silently die after a
   few minutes.
   ───────────────────────────────────────────────────────────── */
let recognition = null;
let listening = false;          // true while actively capturing a command (either mode)
let voiceTarget = 'orb';        // orb | chat
let ambientOn = false;          // user-toggled: is "always listening for Lola" enabled
let ambientMuted = false;       // explicit mute, independent of ambientOn — see toggle below
let ambientRecognizing = false; // is the passive wake-word recognizer currently running
let micMeter = null;            // live mic→orb resonance meter while actively listening
const WAKE_WORDS = ['lola'];
const AMBIENT_STORAGE_KEY = 'loladesk_ambient_listening';

function setupRecognition(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (e)=>{
    let interim='', final='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const t = final || interim;
    if(voiceTarget==='orb') document.getElementById('orbTranscript').textContent = t;
    if(final){
      stopListening();
      askLola(final);
    }
  };
  recognition.onerror = ()=> stopListening();
  recognition.onend = ()=>{ if(listening) stopListening(); };
}

function startListening(){
  if(ambientRecognizing) stopAmbientListening(); // active tap always wins over passive ambient
  if(!recognition) setupRecognition();
  if(!recognition){ alert('Voice input needs Chrome, Edge, or Safari.'); return; }
  listening = true;
  stopSpeaking();
  if(voiceTarget==='orb') setOrbState('listening');
  if(voiceTarget==='chat') document.getElementById('chatMic').classList.add('on');
  try{ recognition.start(); }catch(e){}
  // Resonance IN: a parallel analyser on the mic so the neural orb
  // ripples with the owner's actual voice amplitude while listening.
  if(window.LolaOrb && voiceTarget==='orb'){
    LolaOrb.attachMic(orb).then(m => {
      micMeter = m;
      if(!listening) { m.stop(); micMeter = null; } // finished before mic granted
    });
  }
}

function stopListening(){
  listening = false;
  if(micMeter){ micMeter.stop(); micMeter = null; }
  if(recognition) try{ recognition.stop(); }catch(e){}
  if(voiceTarget==='orb') setOrbState(ambientOn && !ambientMuted ? 'ambient' : 'idle');
  document.getElementById('chatMic').classList.remove('on');
  setTimeout(()=>{ document.getElementById('orbTranscript').textContent=''; }, 2500);
  // Resume passive wake-word listening once the active command finishes,
  // if ambient mode is on and not muted.
  if(ambientOn && !ambientMuted) setTimeout(startAmbientListening, 400);
}

window.toggleVoice = function(){
  voiceTarget = 'orb';
  listening ? stopListening() : startListening();
};
window.toggleChatVoice = function(){
  voiceTarget = 'chat';
  listening ? stopListening() : startListening();
};

/* ── AMBIENT WAKE-WORD LISTENING ── */
let ambientRecognition = null;

function setupAmbientRecognition(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return null;
  const r = new SR();
  r.continuous = true;       // keep listening across pauses, not just one utterance
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = (e)=>{
    if(listening) return; // an active command is already in progress — ignore ambient input
    let transcript = '';
    for(let i=e.resultIndex;i<e.results.length;i++){
      transcript += e.results[i][0].transcript;
    }
    const lower = transcript.toLowerCase();
    // Word-boundary match — avoids false triggers on words that merely
    // contain "lola" as a substring (rare, but it's the product's name).
    const wakeRe = new RegExp('\\b(' + WAKE_WORDS.join('|') + ')\\b');
    const m = wakeRe.exec(lower);
    if(!m) return;
    // Take only what comes AFTER the wake word as the actual command —
    // mirrors how Alexa/Siri strip their own name before processing.
    const command = transcript.slice(m.index + m[0].length).replace(/^[,.\s]+/, '').trim();
    if(!command) return; // just "Lola" with nothing after it yet — wait for more
    // BARGE-IN: hearing her name while she's mid-sentence cuts her off
    // immediately — the dashboard equivalent of interrupting a human
    // receptionist. (Phone-call barge-in is Phase E; this is free here
    // because playback is local.)
    stopSpeaking();
    orb.flare(); // visible acknowledgment the wake word landed
    stopAmbientListening();
    voiceTarget = 'orb';
    askLola(command);
  };
  r.onerror = (e)=>{
    ambientRecognizing = false;
    // "no-speech" and "aborted" are routine in ambient mode (long silences,
    // explicit stops) — just restart quietly rather than treating as fatal.
    if(ambientOn && !ambientMuted) setTimeout(startAmbientListening, 1200);
  };
  r.onend = ()=>{
    ambientRecognizing = false;
    // Browsers auto-stop continuous recognition periodically — restart
    // immediately so "always listening" actually stays always listening.
    if(ambientOn && !ambientMuted && !listening) setTimeout(startAmbientListening, 300);
  };
  return r;
}

function startAmbientListening(){
  if(!ambientOn || ambientMuted || listening || ambientRecognizing) return;
  if(!ambientRecognition) ambientRecognition = setupAmbientRecognition();
  if(!ambientRecognition) return;
  try{
    ambientRecognition.start();
    ambientRecognizing = true;
    if(voiceTarget==='orb' || document.getElementById('orbStage')) setOrbState('ambient');
  }catch(e){ ambientRecognizing = false; }
}

function stopAmbientListening(){
  ambientRecognizing = false;
  if(ambientRecognition) try{ ambientRecognition.stop(); }catch(e){}
}

function updateAmbientToggleUI(){
  const btn = document.getElementById('ambientToggle');
  const label = document.getElementById('ambientToggleLabel');
  const stage = document.getElementById('orbStage');
  if(!btn) return;
  btn.classList.toggle('on', ambientOn && !ambientMuted);
  btn.classList.toggle('muted', ambientOn && ambientMuted);
  if(stage) stage.classList.toggle('ambient', ambientOn && !ambientMuted && !listening);
  if(label) label.textContent = !ambientOn ? 'Always listening for "Lola"'
    : ambientMuted ? 'Muted — tap to resume, hold to turn off' : 'Listening for "Lola"… (hold to turn off)';
}

window.toggleAmbientListening = function(){
  if(!ambientOn){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){ alert('Always-listening needs Chrome, Edge, or Safari.'); return; }
    const confirmed = localStorage.getItem('loladesk_ambient_disclosure_ack') === '1' || confirm(
      'Turning this on keeps this device\'s microphone passively open while the dashboard is open. ' +
      'Nothing is sent anywhere unless someone says "Lola" — only what\'s said after her name is processed. ' +
      'Let your staff and anyone nearby know this mic is on. You can mute or turn this off anytime (tap to mute, hold to turn off).\n\n' +
      'Turn on always-listening for Lola?'
    );
    if(!confirmed) return;
    localStorage.setItem('loladesk_ambient_disclosure_ack', '1');
    ambientOn = true;
    ambientMuted = false;
    localStorage.setItem(AMBIENT_STORAGE_KEY, '1');
    startAmbientListening();
  } else if(!ambientMuted){
    // tapping while on = mute, without fully turning the feature off
    ambientMuted = true;
    stopAmbientListening();
    if(!listening) setOrbState('idle');
  } else {
    // tapping while muted = unmute and resume
    ambientMuted = false;
    startAmbientListening();
  }
  updateAmbientToggleUI();
};

// Press-and-hold the toggle for ~800ms to fully turn ambient listening
// off (not just mute) and forget the preference — for an owner who
// decides this isn't for their salon, rather than a temporary mute.
(function wireAmbientLongPress(){
  let pressTimer = null;
  let longPressFired = false;
  const btn = document.getElementById('ambientToggle');
  if(!btn) return;
  const start = ()=>{
    longPressFired = false;
    pressTimer = setTimeout(()=>{
      longPressFired = true;
      ambientOn = false;
      ambientMuted = false;
      stopAmbientListening();
      localStorage.removeItem(AMBIENT_STORAGE_KEY);
      if(!listening) setOrbState('idle');
      updateAmbientToggleUI();
      pressTimer = null;
    }, 800);
  };
  const cancel = ()=>{ if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; } };
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, { passive:true });
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(ev => btn.addEventListener(ev, cancel));
  // A long-press already handled the toggle fully — swallow the click
  // that follows a mouseup/touchend so it doesn't also cycle on/mute.
  btn.addEventListener('click', (e)=>{ if(longPressFired){ e.stopPropagation(); e.preventDefault(); longPressFired = false; } }, { capture:true });
})();

// Restore the owner's last preference on page load — ambient listening
// is opt-in (off by default for a brand-new salon) but persists once chosen.
(function restoreAmbientPreference(){
  if(localStorage.getItem(AMBIENT_STORAGE_KEY) === '1'){
    ambientOn = true;
    // Don't auto-start the mic without a user gesture — most browsers
    // block getUserMedia/SpeechRecognition until the page has had a
    // real click/keypress, so we arm it and start on first interaction.
    const arm = ()=>{ startAmbientListening(); updateAmbientToggleUI(); document.removeEventListener('click', arm); };
    document.addEventListener('click', arm, { once:true });
  }
  updateAmbientToggleUI();
})();

/* ── SPEECH OUTPUT: Lola's real ElevenLabs voice, same as phone calls ──
   Falls back to the browser's built-in voice only if /api/speak fails,
   so the dashboard never goes silent — but normal operation should
   always sound like the real, consistent Lola brand voice. */
let currentAudio = null;
let voiceMeter = null; // Lola's playback → orb resonance

function stopSpeaking(){
  if(voiceMeter){ voiceMeter.stop(); voiceMeter = null; }
  if(currentAudio){ try{ currentAudio.pause(); }catch(e){} currentAudio = null; }
  if(window.speechSynthesis) speechSynthesis.cancel();
}

async function speak(text){
  stopSpeaking();
  const clean = text.replace(/\*([^*]+)\*/g,'$1').replace(/https?:\/\/[^\s]+/g,'').trim().slice(0, 2500);
  if(!clean) return;

  const onStart = ()=>{ if(voiceTarget==='orb') setOrbState('speaking'); };
  const onEnd = ()=>{ if(voiceTarget==='orb') setOrbState(ambientOn && !ambientMuted ? 'ambient' : 'idle'); };

  try{
    const res = await fetch('/api/speak', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ text: clean })
    });
    if(!res.ok) throw new Error('speak api failed: '+res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    onStart();
    // Resonance OUT: her actual voice amplitude radiates through the
    // neural orb as she speaks — the orb IS her voice made visible.
    if(window.LolaOrb) voiceMeter = LolaOrb.attachAudioElement(orb, currentAudio);
    const cleanup = ()=>{ URL.revokeObjectURL(url); if(voiceMeter){ voiceMeter.stop(); voiceMeter = null; } onEnd(); };
    currentAudio.onended = cleanup;
    currentAudio.onerror = cleanup;
    await currentAudio.play();
  }catch(e){
    // Fallback: the browser's built-in voice, only if ElevenLabs is
    // unreachable or unconfigured — keeps the dashboard from going silent.
    console.error('[speak] ElevenLabs failed, falling back to browser voice:', e);
    if(!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 0.94; u.pitch = 1.06; u.volume = 0.92;
    const voices = speechSynthesis.getVoices();
    const pref = [TENANT.persona.voice,'Samantha','Karen','Moira','Google UK English Female','Microsoft Zira'];
    for(const n of pref){ const v=voices.find(x=>x.name.includes(n)); if(v){ u.voice=v; break; } }
    onStart();
    u.onend = onEnd;
    u.onerror = onEnd;
    speechSynthesis.speak(u);
  }
}

/* ─────────────────────────────────────────────────────────────
   KEYBOARD + INPUT WIRING
   ───────────────────────────────────────────────────────────── */
document.getElementById('chatInput').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
});
document.getElementById('cmdInput').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ e.preventDefault(); sendCmd(); }
});
document.getElementById('orbStage').addEventListener('keydown', e=>{
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleVoice(); }
});
document.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key==='k'){ e.preventDefault(); document.getElementById('cmdInput').focus(); }
  if(e.key==='Escape') closeChat();
});
document.getElementById('chatOverlay').addEventListener('click', e=>{
  if(e.target.id==='chatOverlay') closeChat();
});

/* inbox tabs */
document.querySelectorAll('.inbox-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.inbox-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
  });
});

/* ─────────────────────────────────────────────────────────────
   ROTATING ORB SUGGESTIONS (ambient intelligence)
   ───────────────────────────────────────────────────────────── */
const ambient = [
  'Valentina R. is 2 weeks overdue — want me to reach out?',
  'Revenue is up 18% — your best Friday in months.',
  '3 VIP clients haven\'t rebooked. Tap to fix.',
  'I answered 7 calls today. 5 booked.',
  'Thursday 2–4pm is open. Want me to fill it?'
];
let ambIdx = 0;
setInterval(()=>{
  if(orbState!=='idle') return;
  ambIdx = (ambIdx+1) % ambient.length;
  const sub = document.getElementById('orbSub');
  sub.style.transition='opacity .3s'; sub.style.opacity='0';
  setTimeout(()=>{ if(orbState==='idle'){ sub.textContent = ambient[ambIdx]; sub.style.opacity='1'; } }, 300);
}, 5500);

/* ─── PHONE MINI ORB ─── */
function drawPhoneOrb(){
  const pc = document.getElementById('phoneOrb');
  if(!pc) return;
  const px = pc.getContext('2d');
  let pt = 0;
  (function loop(){
    px.clearRect(0,0,150,150);
    const cx=75, cy=75;
    const breath = 0.5 + Math.sin(pt*1.3)*0.5;
    px.globalCompositeOperation = 'lighter';
    // halo
    const halo = px.createRadialGradient(cx,cy,6,cx,cy,72);
    const hA = 0.12 + breath*0.12;
    halo.addColorStop(0,`rgba(255,45,142,${hA})`);
    halo.addColorStop(1,'rgba(255,45,142,0)');
    px.fillStyle=halo; px.fillRect(0,0,150,150);
    // core
    const core = px.createRadialGradient(cx,cy,0,cx,cy,38);
    const cA = 0.25 + breath*0.2;
    core.addColorStop(0,`rgba(255,120,190,${cA})`);
    core.addColorStop(1,'rgba(255,45,142,0)');
    px.fillStyle=core; px.fillRect(0,0,150,150);
    for(let i=0;i<46;i++){
      const a=(i/46)*Math.PI*2;
      const r=42+Math.sin(pt*.8+i*.4)*5+Math.sin(pt*1.3+i*.85)*3+breath*2;
      const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
      const al=.22+Math.abs(Math.sin(pt*.6+i*.3))*.35;
      px.beginPath(); px.arc(x,y,1.3,0,Math.PI*2);
      px.fillStyle=`rgba(255,${90+Math.sin(pt+i*.2)*60},${175+Math.sin(pt+i)*30},${al})`;
      px.fill();
    }
    for(let i=0;i<20;i++){
      const a=(i/20)*Math.PI*2 + pt*.25;
      const r=16+Math.sin(pt*1.1+i*.55)*5;
      const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
      px.beginPath(); px.arc(x,y,.9,0,Math.PI*2);
      px.fillStyle=`rgba(255,180,215,${0.18+Math.abs(Math.sin(pt*.85+i))*0.3})`;
      px.fill();
    }
    px.globalCompositeOperation = 'source-over';
    pt+=.016;
    requestAnimationFrame(loop);
  })();
}

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */
function init(){
  renderSchedule();
  renderInsights();
  renderInbox();
  renderTeam();
  drawRevLine();
  drawDonut();
  drawRevBars();
  drawCallWave();
  drawPhoneOrb();
  // Always-alive: start in ambient so synapse network fires immediately.
  // The orb is Lola's presence — she should never be dark when the
  // dashboard is open. Full 'ambient' breathing + particle firing from
  // the first frame, no click required.
  setOrbState('ambient');
  // Warm up voices
  if(window.speechSynthesis){ speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = ()=>speechSynthesis.getVoices(); }
  // Load the widget snippet silently so the dashboard card can show it
  // without a separate fetch when the card is first rendered.
  loadWidgetSnippetForDash();
}

/* ── Dashboard widget snippet card ──
   Fetches the tenant's embed snippet and populates both the copy
   button and the code element in the dashboard widget card. */
async function loadWidgetSnippetForDash(){
  try{
    const tok = (()=>{ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } })();
    const r = await fetch('/api/widget-embed', { headers:{ Authorization:'Bearer '+tok } });
    const d = await r.json();
    if(!r.ok || !d?.snippet) return;
    const code = document.getElementById('dashWidgetSnippet');
    const btn = document.getElementById('dashWidgetCopy');
    if(code) code.textContent = d.snippet;
    if(btn) btn.onclick = async ()=>{
      try{ await navigator.clipboard.writeText(d.snippet); btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent='Copy snippet',1800); }
      catch(e){ btn.textContent='Select + copy'; }
    };
  }catch(e){}
}

init();

/* ─────────────────────────────────────────────────────────────
   REAL-TIME BOOKING NOTIFICATIONS
   Polls every 30 s for new calls/bookings and shows a toast with
   a neon-pink pulse so the owner never misses a booking Lola made.
   ───────────────────────────────────────────────────────────── */
(function startRealtimeNotifications(){
  let lastCallId = null;
  let firstRun = true;

  async function poll(){
    try{
      const tok = (()=>{ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } })();
      if(!tok) return;
      const r = await fetch('/api/data?resource=calls', { headers:{ Authorization:'Bearer '+tok } });
      if(!r.ok) return;
      const d = await r.json();
      const calls = (d && d.calls) || [];
      if(!calls.length) return;

      const latest = calls[0];
      const latestId = latest.id || latest.when;

      if(firstRun){
        lastCallId = latestId;
        firstRun = false;
        return;
      }

      if(latestId !== lastCallId){
        lastCallId = latestId;
        const isBooked = latest.outcome === 'booked' || latest.booked;
        const caller = latest.from || 'A client';
        const service = latest.service || '';
        const msg = isBooked
          ? `🌸 Lola just booked ${caller}${service ? ' for ' + service : ''}!`
          : `📞 New call from ${caller}`;
        showLolaNotification(msg, isBooked ? 'booking' : 'call');
      }
    }catch(e){}
  }

  // Start polling after 10s (let the page settle), then every 30s
  setTimeout(()=>{ poll(); setInterval(poll, 30000); }, 10000);
})();

function showLolaNotification(msg, type){
  // Remove any existing notification
  const old = document.getElementById('lolaNotif');
  if(old) old.remove();

  const n = document.createElement('div');
  n.id = 'lolaNotif';
  n.style.cssText = [
    'position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(80px)',
    'background:var(--surface)',
    'border:0.5px solid ' + (type==='booking' ? 'var(--pink)' : 'var(--border2)'),
    'border-radius:16px;padding:14px 20px',
    'display:flex;align-items:center;gap:12px',
    'box-shadow:0 12px 40px rgba(0,0,0,.4)',
    type==='booking' ? '0 0 0 1px rgba(255,45,142,.15)' : '',
    'transition:transform .35s cubic-bezier(.22,1,.36,1)',
    'z-index:999;max-width:90vw;cursor:pointer'
  ].join(';');

  const dot = document.createElement('div');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:' + (type==='booking'?'#ff2d8e':'var(--text3)') + ';flex-shrink:0;animation:notifPulse 1.5s ease-in-out 3';
  if(!document.getElementById('notifPulseStyle')){
    const s = document.createElement('style');
    s.id = 'notifPulseStyle';
    s.textContent = '@keyframes notifPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,45,142,.5)}50%{box-shadow:0 0 0 8px rgba(255,45,142,0)}}';
    document.head.appendChild(s);
  }

  const txt = document.createElement('div');
  txt.style.cssText = 'font-size:13px;font-weight:500;color:var(--text)';
  txt.textContent = msg;

  const close = document.createElement('button');
  close.style.cssText = 'background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:0 0 0 8px;line-height:1';
  close.textContent = '×';
  close.onclick = (e)=>{ e.stopPropagation(); n.style.transform='translateX(-50%) translateY(80px)'; setTimeout(()=>n.remove(), 350); };

  n.appendChild(dot); n.appendChild(txt); n.appendChild(close);
  n.onclick = ()=>{ location.href='calls.html'; };
  document.body.appendChild(n);

  // Animate in
  requestAnimationFrame(()=>{ n.style.transform='translateX(-50%) translateY(0)'; });
  // Auto-dismiss after 6s
  setTimeout(()=>{ if(n.parentNode){ n.style.transform='translateX(-50%) translateY(80px)'; setTimeout(()=>n.remove(), 350); } }, 6000);
}

/* ─────────────────────────────────────────────────────────────
   PENDING PROMPT HANDOFF
   Clients and Inbox pages can push a pre-filled Lola prompt via
   sessionStorage. Pick it up here and fire it automatically.
   ───────────────────────────────────────────────────────────── */
(function handlePendingPrompt(){
  try{
    const prompt = sessionStorage.getItem('lola_pending_prompt');
    if(!prompt) return;
    sessionStorage.removeItem('lola_pending_prompt');
    // Wait for Lola's input to be ready
    const tryFill = (attempts) => {
      if(attempts <= 0) return;
      const inp = document.getElementById('lolaInput') || document.querySelector('.cmd-input') || document.querySelector('[placeholder*="Ask Lola"]');
      if(inp){
        inp.value = prompt;
        inp.dispatchEvent(new Event('input'));
        inp.focus();
        // Auto-send after a brief moment so the user sees what's being sent
        setTimeout(()=>{
          const sendBtn = document.getElementById('sendBtn') || document.querySelector('.cmd-send');
          if(sendBtn) sendBtn.click();
        }, 800);
      } else {
        setTimeout(()=>tryFill(attempts-1), 300);
      }
    };
    setTimeout(()=>tryFill(10), 600);
  }catch(e){}
})();

})();
