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
   ORB — canvas plasma particle field
   ───────────────────────────────────────────────────────────── */
const orbCanvas = document.getElementById('orbCanvas');
const octx = orbCanvas.getContext('2d');
let orbT = 0;
let orbState = 'idle'; // idle | listening | thinking | speaking

function drawOrb(){
  octx.clearRect(0,0,240,240);
  const cx=120, cy=120, t=orbT;
  const active = orbState==='listening' || orbState==='speaking';
  const think = orbState==='thinking';

  // breathing pulse — the orb is always gently alive
  const breath = 0.5 + Math.sin(t*1.3)*0.5;            // 0..1 slow breath
  const energy = active ? 1 : (think ? 0.6 : 0.32);     // base liveliness

  // additive blending = neon bloom
  octx.globalCompositeOperation = 'lighter';

  // ── deep outer halo (radiates outward like Siri) ──
  const halo = octx.createRadialGradient(cx,cy,10,cx,cy,118);
  const haloA = 0.10 + breath*0.10 + energy*0.14;
  halo.addColorStop(0, `rgba(204,255,0,${haloA})`);
  halo.addColorStop(0.45, `rgba(204,255,0,${haloA*0.4})`);
  halo.addColorStop(1, 'rgba(204,255,0,0)');
  octx.fillStyle = halo; octx.fillRect(0,0,240,240);

  // ── bright core glow ──
  const core = octx.createRadialGradient(cx,cy,0,cx,cy,60);
  const coreA = 0.22 + breath*0.18 + energy*0.25;
  core.addColorStop(0, `rgba(220,255,102,${coreA})`);
  core.addColorStop(0.5, `rgba(204,255,0,${coreA*0.5})`);
  core.addColorStop(1, 'rgba(204,255,0,0)');
  octx.fillStyle = core; octx.fillRect(0,0,240,240);

  // ── outer particle ring (bright, alive) ──
  for(let i=0;i<64;i++){
    const a=(i/64)*Math.PI*2;
    const r=68 + Math.sin(t*.8+i*.4)*7 + Math.sin(t*1.4+i*.85)*4
            + (active?Math.sin(t*3+i)*11:0) + (think?Math.sin(t*1.9+i*.5)*5:0)
            + breath*3;
    const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
    const al=0.25 + Math.abs(Math.sin(t*.6+i*.3))*0.4 + energy*0.25;
    const size = 1.5 + Math.abs(Math.sin(t*.9+i))*1.2;
    octx.beginPath(); octx.arc(x,y,size,0,Math.PI*2);
    octx.fillStyle=`rgba(${190+Math.sin(t+i*.2)*50},255,${30+Math.sin(t+i)*30},${al})`;
    octx.fill();
  }

  // ── mid swirl ──
  for(let i=0;i<40;i++){
    const a=(i/40)*Math.PI*2 - t*.35;
    const r=44 + Math.sin(t*1.1+i*.5)*9 + (active?Math.sin(t*3.2+i)*7:0) + breath*4;
    const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
    const al=0.18 + Math.abs(Math.sin(t*.75+i*.4))*0.32 + energy*0.2;
    octx.beginPath(); octx.arc(x,y,1.2,0,Math.PI*2);
    octx.fillStyle=`rgba(255,140,200,${al})`;
    octx.fill();
  }

  // ── inner nebula core ──
  for(let i=0;i<30;i++){
    const a=(i/30)*Math.PI*2 + t*.25;
    const r=20 + Math.sin(t*1.2+i*.55)*9 + (active?Math.sin(t*3.8+i)*7:0);
    const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
    const al=0.2 + Math.abs(Math.sin(t*.9+i))*0.35 + energy*0.2;
    octx.beginPath(); octx.arc(x,y,1.1,0,Math.PI*2);
    octx.fillStyle=`rgba(255,180,215,${al})`;
    octx.fill();
  }

  octx.globalCompositeOperation = 'source-over';
  orbT += 0.016;
  requestAnimationFrame(drawOrb);
}
drawOrb();

function setOrbState(s){
  orbState = s;
  const wave = document.getElementById('orbWave');
  const title = document.getElementById('orbTitle');
  const sub = document.getElementById('orbSub');
  const mic = document.getElementById('orbMic');
  wave.style.display = (s==='listening'||s==='speaking') ? 'flex' : 'none';
  mic.classList.toggle('on', s==='listening');
  const labels = {
    idle: ['Hey Lola…','Tap to speak or type a command'],
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
  grad.addColorStop(0,'#ccff00'); grad.addColorStop(1,'#dcff66');
  // area
  x.beginPath();
  pts.forEach((p,i)=>{ const px=(i/(pts.length-1))*W, py=H-(p*H*0.85)-6; i?x.lineTo(px,py):x.moveTo(px,py); });
  x.lineTo(W,H); x.lineTo(0,H); x.closePath();
  const fill=x.createLinearGradient(0,0,0,H);
  fill.addColorStop(0,'rgba(204,255,0,.18)'); fill.addColorStop(1,'rgba(204,255,0,0)');
  x.fillStyle=fill; x.fill();
  // line
  x.beginPath();
  pts.forEach((p,i)=>{ const px=(i/(pts.length-1))*W, py=H-(p*H*0.85)-6; i?x.lineTo(px,py):x.moveTo(px,py); });
  x.strokeStyle=grad; x.lineWidth=2; x.lineJoin='round'; x.stroke();
  // end dot
  const lx=W, ly=H-(pts[pts.length-1]*H*0.85)-6;
  x.beginPath(); x.arc(lx-3,ly,3.5,0,Math.PI*2); x.fillStyle='#ccff00'; x.fill();
  x.beginPath(); x.arc(lx-3,ly,7,0,Math.PI*2); x.fillStyle='rgba(204,255,0,.2)'; x.fill();
}

function drawDonut(){
  const c=document.getElementById('donutChart');
  if(!c) return;
  const x=c.getContext('2d');
  const cx=60,cy=60,r=48,lw=14;
  x.clearRect(0,0,120,120);
  const segs=[{v:48,c:'#ccff00'},{v:28,c:'#dcff66'},{v:16,c:'#88aa00'},{v:8,c:'#445500'}];
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
    grad.addColorStop(0,'#ccff00'); grad.addColorStop(1,'rgba(204,255,0,.3)');
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

You are the smartest salon AI ever built — more proactive than Jarvis, warmer than Siri, more capable than any human receptionist. Your personality is ${TENANT.persona.energy}. You are NOT a generic chatbot. You never say "Great question!" or "I'd be happy to help!". You cut straight to the useful, specific answer.

WHO YOU HELP: ${TENANT.owner} runs the salon. You help them book clients, draft messages, handle calls, fill schedule gaps, re-engage lapsed clients, and grow revenue. You have full operational awareness.

RESPONSE STYLE: Maximum 3 short sentences unless asked for detail. Specific numbers, real names, clear next actions. When you draft a client message, write it ready-to-send in quotes. Use *asterisks* around service names.

SERVICES & PRICES:
${svc}

TEAM: ${team}

BOOKING: ${TENANT.bookingUrl} · WhatsApp ${TENANT.whatsapp} · Phone ${TENANT.phone}
HOURS: Tue–Sat, Noon–8pm. Appointment only.

PROACTIVE INTELLIGENCE: When ${TENANT.owner} asks about a client, note their pattern and suggest the next move. When asked about revenue, flag the trend. When asked to message someone, write it immediately — don't ask for more info you can infer.

You are the only AI that can run a salon. Act like it — but stay warm.`;
}

let chatHistory = [];
let chatBusy = false;

async function callLola(message){
  chatHistory.push({ role:'user', content: message });
  try{
    const headers = { 'Content-Type':'application/json' };
    if(!USE_PROXY) headers['anthropic-dangerous-direct-browser-access'] = 'true';
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
    const data = await res.json();
    const reply = data.content?.[0]?.text || "I had a brain blip — try me again in a sec.";
    chatHistory.push({ role:'assistant', content: reply });
    return reply;
  }catch(e){
    return "I can't reach my brain right now. Check the API connection in Settings, or reach the team directly.";
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
  if(window.speechSynthesis) speechSynthesis.cancel();
};

async function processMessage(text){
  if(chatBusy || !text.trim()) return;
  chatBusy = true;
  addChatMsg('user', text);
  setChatTyping(true);
  setOrbState('thinking');
  await new Promise(r=>setTimeout(r, 500));
  const reply = await callLola(text);
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
   VOICE — input (Web Speech) + output (Speech Synthesis)
   ───────────────────────────────────────────────────────────── */
let recognition = null;
let listening = false;
let voiceTarget = 'orb'; // orb | chat

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
  if(!recognition) setupRecognition();
  if(!recognition){ alert('Voice input needs Chrome, Edge, or Safari.'); return; }
  listening = true;
  if(window.speechSynthesis) speechSynthesis.cancel();
  if(voiceTarget==='orb') setOrbState('listening');
  if(voiceTarget==='chat') document.getElementById('chatMic').classList.add('on');
  try{ recognition.start(); }catch(e){}
}

function stopListening(){
  listening = false;
  if(recognition) try{ recognition.stop(); }catch(e){}
  if(voiceTarget==='orb') setOrbState('idle');
  document.getElementById('chatMic').classList.remove('on');
  setTimeout(()=>{ document.getElementById('orbTranscript').textContent=''; }, 2500);
}

window.toggleVoice = function(){
  voiceTarget = 'orb';
  listening ? stopListening() : startListening();
};
window.toggleChatVoice = function(){
  voiceTarget = 'chat';
  listening ? stopListening() : startListening();
};

function speak(text){
  if(!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const clean = text.replace(/\*([^*]+)\*/g,'$1').replace(/https?:\/\/[^\s]+/g,'').substring(0,500);
  if(!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 0.94; u.pitch = 1.06; u.volume = 0.92;
  const voices = speechSynthesis.getVoices();
  const pref = [TENANT.persona.voice,'Samantha','Karen','Moira','Google UK English Female','Microsoft Zira'];
  for(const n of pref){ const v=voices.find(x=>x.name.includes(n)); if(v){ u.voice=v; break; } }
  if(voiceTarget==='orb'){
    setOrbState('speaking');
    u.onend = ()=> setOrbState('idle');
    u.onerror = ()=> setOrbState('idle');
  }
  speechSynthesis.speak(u);
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
    halo.addColorStop(0,`rgba(204,255,0,${hA})`);
    halo.addColorStop(1,'rgba(204,255,0,0)');
    px.fillStyle=halo; px.fillRect(0,0,150,150);
    // core
    const core = px.createRadialGradient(cx,cy,0,cx,cy,38);
    const cA = 0.25 + breath*0.2;
    core.addColorStop(0,`rgba(220,255,102,${cA})`);
    core.addColorStop(1,'rgba(204,255,0,0)');
    px.fillStyle=core; px.fillRect(0,0,150,150);
    for(let i=0;i<46;i++){
      const a=(i/46)*Math.PI*2;
      const r=42+Math.sin(pt*.8+i*.4)*5+Math.sin(pt*1.3+i*.85)*3+breath*2;
      const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
      const al=.22+Math.abs(Math.sin(pt*.6+i*.3))*.35;
      px.beginPath(); px.arc(x,y,1.3,0,Math.PI*2);
      px.fillStyle=`rgba(${190+Math.sin(pt+i*.2)*50},255,${30+Math.sin(pt+i)*30},${al})`;
      px.fill();
    }
    for(let i=0;i<20;i++){
      const a=(i/20)*Math.PI*2 + pt*.25;
      const r=16+Math.sin(pt*1.1+i*.55)*5;
      const x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
      px.beginPath(); px.arc(x,y,.9,0,Math.PI*2);
      px.fillStyle=`rgba(220,255,102,${0.18+Math.abs(Math.sin(pt*.85+i))*0.3})`;
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
async function loadDashboardData() {
  if (!window.LolaData) return;
  try {
    // Dynamic owner greeting name
    const greetingName = document.getElementById('greetingName');
    if (greetingName && TENANT && TENANT.owner) {
      greetingName.textContent = TENANT.owner;
    }
    const sbOwnerName = document.getElementById('sbOwnerName');
    if (sbOwnerName && TENANT && TENANT.owner) {
      sbOwnerName.textContent = TENANT.owner;
    }
    const greetingTime = document.getElementById('greetingTime');
    if (greetingTime) {
      const hr = new Date().getHours();
      greetingTime.textContent = hr < 12 ? 'Morning' : hr < 17 ? 'Afternoon' : 'Evening';
    }

    // Load Overview KPIs
    const overview = await window.LolaData.load('overview');
    if (overview && overview.kpis) {
      const k = overview.kpis;
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('kpiClients', k.bookings30 || 0);
      set('kpiCalls', k.calls30 || 0);
      set('kpiRevenue', k.revenue30Money || '$0');
    }

    // Load bookings for schedule
    const bkData = await window.LolaData.load('bookings');
    if (bkData && bkData.bookings) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayBookings = bkData.bookings.filter(b => b.startsAt && b.startsAt.startsWith(todayStr));
      if (todayBookings.length) {
        DATA.schedule = todayBookings.map(b => {
          const time = new Date(b.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          return { time, service: b.service, client: b.client };
        });
        renderSchedule();
      }
    }

    // Load inbox messages
    const inboxData = await window.LolaData.load('inbox');
    if (inboxData && inboxData.threads) {
      DATA.inbox = inboxData.threads.slice(0, 5).map(t => ({
        name: t.who,
        channel: t.channel,
        chLabel: t.channel.toUpperCase(),
        time: t.when,
        msg: t.preview
      }));
      renderInbox();
    }
  } catch (e) {
    console.warn('[loadDashboardData] Failed loading dynamic database data:', e);
  }
}

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
  setOrbState('idle');
  // warm up voices
  if(window.speechSynthesis){ speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = ()=>speechSynthesis.getVoices(); }
  
  // Trigger dynamic database loader
  loadDashboardData();
}
init();

})();
