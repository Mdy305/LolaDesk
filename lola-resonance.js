/* LolaDesk Resonance Runtime — wake, converse, remember, interrupt. */
(function(){
  if(window.LolaResonance) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    enabled:false,
    awake:false,
    listening:false,
    speaking:false,
    busy:false,
    recognition:null,
    restartTimer:null,
    messages:[],
    lastWakeAt:0,
    ownerName:'there'
  };

  function token(){ try{return localStorage.getItem('loladesk_token')||'';}catch{return '';} }
  function setOrb(mode){
    document.body.dataset.lolaState = mode;
    window.dispatchEvent(new CustomEvent('lola:state',{detail:{mode}}));
    const orb = document.querySelector('.lola-orb,.orb,#lolaOrb,[data-lola-orb]');
    if(orb){ orb.dataset.state=mode; orb.setAttribute('aria-label','Lola is '+mode); }
  }
  function toast(text){
    let el=document.getElementById('lolaResonanceToast');
    if(!el){
      el=document.createElement('div'); el.id='lolaResonanceToast';
      el.style.cssText='position:fixed;left:50%;bottom:94px;transform:translateX(-50%);z-index:99999;max-width:min(680px,88vw);padding:12px 16px;border:1px solid rgba(204,255,0,.24);border-radius:14px;background:rgba(8,8,10,.94);backdrop-filter:blur(18px);color:#f4f4f5;font:500 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35);opacity:0;transition:.2s';
      document.body.appendChild(el);
    }
    el.textContent=text; el.style.opacity='1'; clearTimeout(el._t); el._t=setTimeout(()=>el.style.opacity='0',4200);
  }
  function cleanText(value){
    if(typeof value==='string') return value;
    if(Array.isArray(value)) return value.map(x=>x && (x.text||x.content||'')).join(' ').trim();
    return value && (value.text||value.content) ? String(value.text||value.content) : '';
  }
  function stopSpeaking(){
    try{ speechSynthesis.cancel(); }catch{}
    state.speaking=false;
  }
  function speak(text){
    text=String(text||'').replace(/[*_#`]/g,' ').replace(/\s+/g,' ').trim();
    if(!text || !('speechSynthesis' in window)) return Promise.resolve();
    stopSpeaking(); state.speaking=true; setOrb('speaking');
    return new Promise(resolve=>{
      const u=new SpeechSynthesisUtterance(text);
      u.rate=.98; u.pitch=1.02; u.volume=1;
      const voices=speechSynthesis.getVoices();
      u.voice=voices.find(v=>/samantha|ava|zoe|female/i.test(v.name)) || voices.find(v=>/^en/i.test(v.lang)) || null;
      u.onend=u.onerror=()=>{ state.speaking=false; state.awake=false; setOrb(state.enabled?'ambient':'idle'); scheduleRestart(450); resolve(); };
      speechSynthesis.speak(u);
    });
  }
  function systemPrompt(){
    return `You are Lola, a permanent senior team member inside LolaDesk, powered by the existing LolaDesk and LolaBrain assistants. Speak naturally, warmly and decisively. Address the owner as ${state.ownerName}. Be concise in voice, but take real actions when tools are available. Remember prior context, preferences, team details and unfinished tasks. Never describe yourself as a chatbot. You are the business's always-on front desk teammate and operator.`;
  }
  async function askLola(text){
    text=String(text||'').trim(); if(!text || state.busy) return;
    state.busy=true; setOrb('thinking'); toast('Lola heard: “'+text+'”');
    state.messages.push({role:'user',content:text});
    state.messages=state.messages.slice(-16);
    try{
      const r=await fetch('/api/lola',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token()},body:JSON.stringify({system:systemPrompt(),messages:state.messages,channel:'dashboard_voice',assistant:'LolaBrain'})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error||('Lola '+r.status));
      const reply=cleanText(data.content||data.reply||data.message)||'Done.';
      state.messages.push({role:'assistant',content:reply});
      state.messages=state.messages.slice(-16);
      toast(reply);
      await speak(reply);
    }catch(e){
      const msg='I hit a connection issue, but I am still here. '+String(e.message||e);
      toast(msg); await speak(msg);
    }finally{ state.busy=false; }
  }
  function commandFrom(transcript){
    const lower=transcript.toLowerCase();
    const m=lower.match(/(?:hey|hi|okay|ok)?\s*lola[\s,.:;-]*(.*)$/i);
    return m ? m[1].trim() : '';
  }
  function scheduleRestart(delay){
    clearTimeout(state.restartTimer);
    if(!state.enabled || !state.recognition || state.busy || state.speaking) return;
    state.restartTimer=setTimeout(()=>{ try{state.recognition.start();}catch{} },delay||300);
  }
  function initRecognition(){
    if(!SpeechRecognition) return false;
    const r=new SpeechRecognition();
    r.continuous=true; r.interimResults=true; r.lang='en-US';
    r.onstart=()=>{ state.listening=true; setOrb(state.awake?'listening':'ambient'); };
    r.onend=()=>{ state.listening=false; scheduleRestart(350); };
    r.onerror=e=>{ if(!['no-speech','aborted'].includes(e.error)) toast('Microphone: '+e.error); };
    r.onresult=e=>{
      let finalText='', interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0].transcript.trim();
        if(e.results[i].isFinal) finalText+=' '+t; else interim+=' '+t;
      }
      const heard=(finalText||interim).trim(); if(!heard) return;
      if(state.speaking){ stopSpeaking(); state.awake=true; setOrb('listening'); }
      const hasWake=/\b(?:hey|hi|okay|ok)?\s*lola\b/i.test(heard);
      if(hasWake){
        state.awake=true; state.lastWakeAt=Date.now(); setOrb('listening');
        const cmd=commandFrom(heard);
        if(cmd && finalText){ try{r.stop();}catch{} askLola(cmd); }
        else if(finalText) toast('I’m listening.');
        return;
      }
      if(state.awake && finalText && Date.now()-state.lastWakeAt<14000){ try{r.stop();}catch{} askLola(finalText.trim()); }
    };
    state.recognition=r; return true;
  }
  async function enable(){
    if(state.enabled) return;
    state.enabled=true;
    try{ await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ state.enabled=false; toast('Microphone permission is required to talk with Lola.'); return; }
    if(!state.recognition && !initRecognition()){ state.enabled=false; toast('Voice wake mode is not supported in this browser. Tap Lola to use chat.'); return; }
    setOrb('ambient'); scheduleRestart(0); toast('Lola is with you. Say “Hey Lola”.');
    try{localStorage.setItem('loladesk_resonance','on');}catch{}
  }
  function disable(){
    state.enabled=false; state.awake=false; clearTimeout(state.restartTimer); stopSpeaking();
    try{state.recognition&&state.recognition.stop();}catch{}
    setOrb('idle'); try{localStorage.removeItem('loladesk_resonance');}catch{}
  }
  function bind(){
    document.addEventListener('click',e=>{
      const target=e.target.closest('.lola-orb,.orb,#lolaOrb,[data-lola-orb],[data-lola-voice]');
      if(!target) return;
      if(!state.enabled) enable(); else { state.awake=true; state.lastWakeAt=Date.now(); stopSpeaking(); setOrb('listening'); toast('I’m listening.'); }
    });
    window.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.code==='Space'){ e.preventDefault(); state.enabled?disable():enable(); }
      if(e.key==='Escape'&&state.speaking){ stopSpeaking(); scheduleRestart(250); }
    });
  }
  async function boot(){
    try{
      const auth=await window.LolaAuth.ready;
      state.ownerName=(auth?.tenant?.owner_name||auth?.user?.user_metadata?.full_name||'there').split(' ')[0];
    }catch{}
    bind();
    let auto=false; try{auto=localStorage.getItem('loladesk_resonance')==='on';}catch{}
    if(auto) enable(); else setOrb('idle');
  }

  window.LolaResonance={enable,disable,ask:askLola,state};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
