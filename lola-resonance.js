/* LolaDesk Resonance Runtime — wake, converse, remember, interrupt. */
(function(){
  if(window.LolaResonance) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    enabled:false, awake:false, listening:false, speaking:false, busy:false,
    recognition:null, restartTimer:null, messages:[], lastWakeAt:0,
    ownerName:'there', mode:'idle', turnId:0, controller:null,
    startedAt:0, transcript:'', interim:'', lastError:null
  };

  function token(){ try{return localStorage.getItem('loladesk_token')||'';}catch{return '';} }
  function now(){ return Math.round(performance.now()); }
  function emit(name,detail){ window.dispatchEvent(new CustomEvent(name,{detail})); }
  function metric(name,value,extra){
    const detail={name,value,tenant:window.LolaAuth?.tenant?.id||null,session:window.LolaAuth?.session?.id||null,turnId:state.turnId,mode:state.mode,...extra};
    emit('lola:metric',detail);
    try{ console.debug('[Lola metric]',detail); }catch{}
  }
  function setOrb(mode,detail={}){
    state.mode=mode;
    document.body.dataset.lolaState=mode;
    emit('lola:state',{mode,...detail});
    const orb=document.querySelector('.lola-orb,.orb,#lolaOrb,[data-lola-orb]');
    if(orb){ orb.dataset.state=mode; orb.setAttribute('aria-label','Lola is '+mode); }
    const sub=document.getElementById('orbSub');
    if(sub && detail.label) sub.textContent=detail.label;
  }
  function setTranscript(finalText='',interim=''){
    state.transcript=finalText; state.interim=interim;
    const el=document.getElementById('orbTranscript');
    if(el) el.textContent=(finalText||interim||'').trim();
    emit('lola:transcript',{final:finalText,interim});
  }
  function toast(text){
    let el=document.getElementById('lolaResonanceToast');
    if(!el){
      el=document.createElement('div'); el.id='lolaResonanceToast'; el.setAttribute('role','status'); el.setAttribute('aria-live','polite');
      el.style.cssText='position:fixed;left:50%;bottom:94px;transform:translateX(-50%);z-index:99999;max-width:min(680px,88vw);padding:12px 16px;border:1px solid rgba(204,255,0,.24);border-radius:14px;background:rgba(8,8,10,.94);backdrop-filter:blur(18px);color:#f4f4f5;font:500 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35);opacity:0;transition:.2s';
      document.body.appendChild(el);
    }
    el.textContent=text; el.style.opacity='1'; clearTimeout(el._t); el._t=setTimeout(()=>el.style.opacity='0',4200);
  }
  function cleanText(value){
    if(typeof value==='string') return value;
    if(Array.isArray(value)) return value.map(x=>x&&(x.text||x.content||'')).join(' ').trim();
    return value&&(value.text||value.content)?String(value.text||value.content):'';
  }
  function cancelActive(reason='interrupted'){
    state.turnId++;
    try{ state.controller?.abort(reason); }catch{}
    state.controller=null;
    try{ speechSynthesis.cancel(); }catch{}
    state.speaking=false; state.busy=false;
    emit('lola:cancel',{reason,turnId:state.turnId});
  }
  function stopSpeaking(reason='stopped'){ cancelActive(reason); }
  function speak(text,turnId){
    text=String(text||'').replace(/[*_#`]/g,' ').replace(/\s+/g,' ').trim();
    if(!text || !('speechSynthesis' in window)) return Promise.resolve();
    try{ speechSynthesis.cancel(); }catch{}
    state.speaking=true; setOrb('speaking',{label:'Lola is speaking'});
    const audioStarted=now(); metric('time_to_first_audio',audioStarted-state.startedAt);
    return new Promise(resolve=>{
      const u=new SpeechSynthesisUtterance(text);
      u.rate=.98; u.pitch=1.02; u.volume=1;
      const voices=speechSynthesis.getVoices();
      u.voice=voices.find(v=>/samantha|ava|zoe|female/i.test(v.name))||voices.find(v=>/^en/i.test(v.lang))||null;
      const done=()=>{
        if(turnId!==state.turnId) return resolve();
        state.speaking=false; state.awake=true;
        setOrb(state.enabled?'ambient':'idle',{label:state.enabled?'Say “Hey Lola”':'Tap Lola to start'});
        scheduleRestart(200); resolve();
      };
      u.onend=done; u.onerror=done; speechSynthesis.speak(u);
    });
  }
  function systemPrompt(){
    return `You are Lola, a permanent senior team member inside LolaDesk, powered by LolaBrain. Speak naturally, warmly and decisively. Address the owner as ${state.ownerName}. Be concise in voice, take real actions only when tools confirm success, preserve context, and never claim completion when a downstream action failed. Never call yourself a chatbot.`;
  }
  async function askLola(text){
    text=String(text||'').trim(); if(!text) return;
    cancelActive('new-turn');
    const turnId=state.turnId;
    state.busy=true; state.startedAt=now(); state.controller=new AbortController();
    setOrb('thinking',{label:'Lola is thinking'}); toast('Lola heard: “'+text+'”');
    metric('time_to_visible_feedback',now()-state.startedAt);
    state.messages.push({role:'user',content:text}); state.messages=state.messages.slice(-24);
    try{
      const r=await fetch('/api/lola',{method:'POST',signal:state.controller.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token()},body:JSON.stringify({system:systemPrompt(),messages:state.messages,channel:'dashboard_voice',assistant:'LolaBrain',turnId})});
      metric('time_to_response_headers',now()-state.startedAt,{status:r.status});
      const data=await r.json().catch(()=>({}));
      if(turnId!==state.turnId) return;
      if(!r.ok) throw new Error(data.error||('Lola '+r.status));
      const reply=cleanText(data.content||data.reply||data.message);
      if(!reply) throw new Error('Lola returned an empty response');
      state.messages.push({role:'assistant',content:reply}); state.messages=state.messages.slice(-24);
      toast(reply); await speak(reply,turnId);
      metric('turn_complete',now()-state.startedAt,{ok:true});
    }catch(e){
      if(e?.name==='AbortError'||turnId!==state.turnId) return;
      state.lastError=String(e.message||e); setOrb('error',{label:'Voice needs attention — tap Lola to retry'});
      toast('I hit a connection issue. Tap Lola and try again.');
      metric('turn_complete',now()-state.startedAt,{ok:false,error:state.lastError});
    }finally{
      if(turnId===state.turnId){ state.busy=false; state.controller=null; }
    }
  }
  function commandFrom(transcript){
    const m=transcript.match(/(?:hey|hi|okay|ok)?\s*lola[\s,.:;-]*(.*)$/i);
    return m?m[1].trim():'';
  }
  function scheduleRestart(delay=250){
    clearTimeout(state.restartTimer);
    if(!state.enabled||!state.recognition||state.busy||state.speaking) return;
    state.restartTimer=setTimeout(()=>{ try{state.recognition.start();}catch{} },delay);
  }
  function initRecognition(){
    if(!SpeechRecognition) return false;
    const r=new SpeechRecognition(); r.continuous=true; r.interimResults=true; r.lang='en-US';
    r.onstart=()=>{ state.listening=true; setOrb(state.awake?'listening':'ambient',{label:state.awake?'I’m listening':'Say “Hey Lola”'}); };
    r.onend=()=>{ state.listening=false; scheduleRestart(200); };
    r.onerror=e=>{
      state.lastError=e.error;
      if(!['no-speech','aborted'].includes(e.error)){
        setOrb('degraded',{label:'Microphone needs attention'}); toast('Microphone: '+e.error+' — tap Lola to retry'); metric('recognition_error',0,{error:e.error});
      }
    };
    r.onresult=e=>{
      let finalText='',interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0].transcript.trim();
        if(e.results[i].isFinal) finalText+=' '+t; else interim+=' '+t;
      }
      setTranscript(finalText.trim(),interim.trim());
      const heard=(finalText||interim).trim(); if(!heard) return;
      if(state.speaking||state.busy){ cancelActive('barge-in'); state.awake=true; setOrb('listening',{label:'I’m listening'}); }
      const hasWake=/\b(?:hey|hi|okay|ok)?\s*lola\b/i.test(heard);
      if(hasWake){
        state.awake=true; state.lastWakeAt=Date.now(); setOrb('listening',{label:'I’m listening'});
        const cmd=commandFrom(heard);
        if(cmd&&finalText){ try{r.stop();}catch{} askLola(cmd); }
        else if(finalText) toast('I’m listening.');
        return;
      }
      if(state.awake&&finalText&&Date.now()-state.lastWakeAt<20000){ try{r.stop();}catch{} askLola(finalText.trim()); }
    };
    state.recognition=r; return true;
  }
  async function enable(){
    if(state.enabled) return;
    state.enabled=true; setOrb('waking',{label:'Starting Lola…'});
    try{ await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}}); }
    catch(e){ state.enabled=false; setOrb('error',{label:'Microphone permission required'}); toast('Allow microphone access, then tap Lola again.'); return; }
    if(!state.recognition&&!initRecognition()){ state.enabled=false; setOrb('degraded',{label:'Voice wake is unavailable in this browser'}); toast('Tap Lola to use chat instead.'); return; }
    setOrb('ambient',{label:'Say “Hey Lola”'}); scheduleRestart(0); toast('Lola is with you. Say “Hey Lola”.');
    try{localStorage.setItem('loladesk_resonance','on');}catch{}
  }
  function disable(){
    state.enabled=false; state.awake=false; clearTimeout(state.restartTimer); cancelActive('disabled');
    try{state.recognition&&state.recognition.stop();}catch{}
    setTranscript('',''); setOrb('idle',{label:'Tap Lola to start'}); try{localStorage.removeItem('loladesk_resonance');}catch{}
  }
  function bind(){
    document.addEventListener('click',e=>{
      const target=e.target.closest('.lola-orb,.orb,#lolaOrb,[data-lola-orb],[data-lola-voice]'); if(!target) return;
      if(!state.enabled) enable(); else { cancelActive('manual-wake'); state.awake=true; state.lastWakeAt=Date.now(); setOrb('listening',{label:'I’m listening'}); toast('I’m listening.'); scheduleRestart(0); }
    });
    window.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.code==='Space'){ e.preventDefault(); state.enabled?disable():enable(); }
      if(e.key==='Escape'&&(state.speaking||state.busy)){ cancelActive('escape'); scheduleRestart(100); }
    });
    document.addEventListener('visibilitychange',()=>{ if(document.hidden) cancelActive('backgrounded'); else if(state.enabled) scheduleRestart(150); });
  }
  async function boot(){
    try{ const auth=await window.LolaAuth.ready; state.ownerName=(auth?.tenant?.owner_name||auth?.user?.user_metadata?.full_name||'there').split(' ')[0]; }catch{}
    bind(); let auto=false; try{auto=localStorage.getItem('loladesk_resonance')==='on';}catch{}
    if(auto) enable(); else setOrb('idle',{label:'Tap Lola to start'});
  }

  window.LolaResonance={enable,disable,ask:askLola,cancel:cancelActive,state};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();