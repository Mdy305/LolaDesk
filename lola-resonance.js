/* LolaDesk Resonance Runtime — wake, converse, remember, interrupt. */
(function(){
  if(window.LolaResonance) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    enabled:false, awake:false, listening:false, speaking:false, busy:false,
    recognition:null, restartTimer:null, messages:[], lastWakeAt:0,
    ownerName:'there', mode:'idle', turnId:0, controller:null,
    startedAt:0, transcript:'', interim:'', lastError:null,
    audio:null, audioUrl:null, audioContext:null, analyser:null,
    amplitudeFrame:null, sourceNode:null
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
    if(sub&&detail.label) sub.textContent=detail.label;
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
  function cleanSpeechText(text){
    return String(text||'').replace(/https?:\/\/\S+/g,'').replace(/[*_#`>|]/g,' ').replace(/\s+/g,' ').trim().slice(0,2400);
  }
  function stopAmplitude(){
    if(state.amplitudeFrame) cancelAnimationFrame(state.amplitudeFrame);
    state.amplitudeFrame=null;
    emit('lola:amplitude',{value:0,turnId:state.turnId});
  }
  function releaseAudio(){
    stopAmplitude();
    if(state.audio){
      try{ state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load(); }catch{}
      state.audio=null;
    }
    if(state.audioUrl){ try{URL.revokeObjectURL(state.audioUrl);}catch{} state.audioUrl=null; }
    state.sourceNode=null; state.analyser=null;
  }
  function cancelActive(reason='interrupted'){
    state.turnId++;
    try{state.controller?.abort(reason);}catch{}
    state.controller=null;
    releaseAudio();
    try{speechSynthesis.cancel();}catch{}
    state.speaking=false; state.busy=false;
    emit('lola:cancel',{reason,turnId:state.turnId});
  }
  function stopSpeaking(reason='stopped'){ cancelActive(reason); }
  async function startAmplitude(audio,turnId){
    try{
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC) return;
      state.audioContext=state.audioContext||new AC();
      if(state.audioContext.state==='suspended') await state.audioContext.resume();
      const source=state.audioContext.createMediaElementSource(audio);
      const analyser=state.audioContext.createAnalyser();
      analyser.fftSize=256; analyser.smoothingTimeConstant=.72;
      source.connect(analyser); analyser.connect(state.audioContext.destination);
      state.sourceNode=source; state.analyser=analyser;
      const data=new Uint8Array(analyser.frequencyBinCount);
      const draw=()=>{
        if(turnId!==state.turnId||!state.speaking||state.audio!==audio) return stopAmplitude();
        analyser.getByteFrequencyData(data);
        let sum=0; for(const value of data) sum+=value;
        const amplitude=Math.min(1,(sum/data.length)/110);
        document.documentElement.style.setProperty('--lola-amplitude',amplitude.toFixed(3));
        emit('lola:amplitude',{value:amplitude,turnId});
        state.amplitudeFrame=requestAnimationFrame(draw);
      };
      draw();
    }catch(error){
      metric('audio_analyser_error',0,{error:String(error?.message||error)});
    }
  }
  function browserVoiceFallback(text,turnId){
    if(!('speechSynthesis' in window)) return Promise.reject(new Error('No audio playback available'));
    return new Promise((resolve,reject)=>{
      if(turnId!==state.turnId) return resolve();
      const utterance=new SpeechSynthesisUtterance(text);
      utterance.rate=.98; utterance.pitch=1.02; utterance.volume=1;
      const voices=speechSynthesis.getVoices();
      utterance.voice=voices.find(v=>/samantha|ava|zoe|female/i.test(v.name))||voices.find(v=>/^en/i.test(v.lang))||null;
      utterance.onend=resolve;
      utterance.onerror=event=>reject(new Error(event.error||'Browser speech failed'));
      speechSynthesis.speak(utterance);
    });
  }
  async function speak(text,turnId){
    text=cleanSpeechText(text);
    if(!text||turnId!==state.turnId) return;
    state.speaking=true; setOrb('speaking',{label:'Lola is speaking'});
    let usedFallback=false;
    try{
      const response=await fetch('/api/speak-lola',{
        method:'POST', signal:state.controller?.signal,
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+token()},
        body:JSON.stringify({text,voiceType:'lola'})
      });
      if(turnId!==state.turnId) return;
      if(!response.ok){
        const detail=await response.json().catch(()=>({}));
        throw new Error(detail.error||('Voice '+response.status));
      }
      const blob=await response.blob();
      if(turnId!==state.turnId) return;
      if(!blob.size) throw new Error('Voice returned empty audio');
      state.audioUrl=URL.createObjectURL(blob);
      const audio=new Audio(state.audioUrl);
      state.audio=audio; audio.preload='auto'; audio.playsInline=true;
      await startAmplitude(audio,turnId);
      await new Promise((resolve,reject)=>{
        audio.onplaying=()=>metric('time_to_first_audio',now()-state.startedAt,{provider:'elevenlabs'});
        audio.onended=resolve;
        audio.onerror=()=>reject(new Error('Audio playback failed'));
        const play=audio.play(); if(play?.catch) play.catch(reject);
      });
    }catch(error){
      if(error?.name==='AbortError'||turnId!==state.turnId) return;
      usedFallback=true;
      metric('voice_provider_error',0,{provider:'elevenlabs',error:String(error?.message||error)});
      setOrb('degraded',{label:'Using backup voice'});
      await browserVoiceFallback(text,turnId);
      metric('time_to_first_audio',now()-state.startedAt,{provider:'browser-fallback'});
    }finally{
      if(turnId!==state.turnId) return;
      releaseAudio();
      state.speaking=false; state.awake=true;
      setOrb(state.enabled?'ambient':'idle',{label:state.enabled?'Say “Hey Lola”':'Tap Lola to start',degraded:usedFallback});
      scheduleRestart(180);
    }
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
      const response=await fetch('/api/lola',{method:'POST',signal:state.controller.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token()},body:JSON.stringify({system:systemPrompt(),messages:state.messages,channel:'dashboard_voice',assistant:'LolaBrain',turnId})});
      metric('time_to_response_headers',now()-state.startedAt,{status:response.status});
      const data=await response.json().catch(()=>({}));
      if(turnId!==state.turnId) return;
      if(!response.ok) throw new Error(data.error||('Lola '+response.status));
      const reply=cleanText(data.content||data.reply||data.message);
      if(!reply) throw new Error('Lola returned an empty response');
      state.messages.push({role:'assistant',content:reply}); state.messages=state.messages.slice(-24);
      toast(reply); state.busy=false;
      await speak(reply,turnId);
      if(turnId===state.turnId) metric('turn_complete',now()-state.startedAt,{ok:true});
    }catch(error){
      if(error?.name==='AbortError'||turnId!==state.turnId) return;
      state.lastError=String(error.message||error); setOrb('error',{label:'Voice needs attention — tap Lola to retry'});
      toast('I hit a connection issue. Tap Lola and try again.');
      metric('turn_complete',now()-state.startedAt,{ok:false,error:state.lastError});
    }finally{
      if(turnId===state.turnId){state.busy=false; state.controller=null;}
    }
  }
  function commandFrom(transcript){
    const match=transcript.match(/(?:hey|hi|okay|ok)?\s*lola[\s,.:;-]*(.*)$/i);
    return match?match[1].trim():'';
  }
  function scheduleRestart(delay=250){
    clearTimeout(state.restartTimer);
    if(!state.enabled||!state.recognition||state.busy||state.speaking) return;
    state.restartTimer=setTimeout(()=>{try{state.recognition.start();}catch{}},delay);
  }
  function initRecognition(){
    if(!SpeechRecognition) return false;
    const recognition=new SpeechRecognition(); recognition.continuous=true; recognition.interimResults=true; recognition.lang='en-US';
    recognition.onstart=()=>{state.listening=true; setOrb(state.awake?'listening':'ambient',{label:state.awake?'I’m listening':'Say “Hey Lola”'});};
    recognition.onend=()=>{state.listening=false; scheduleRestart(200);};
    recognition.onerror=event=>{
      state.lastError=event.error;
      if(!['no-speech','aborted'].includes(event.error)){
        setOrb('degraded',{label:'Microphone needs attention'}); toast('Microphone: '+event.error+' — tap Lola to retry'); metric('recognition_error',0,{error:event.error});
      }
    };
    recognition.onresult=event=>{
      let finalText='',interim='';
      for(let i=event.resultIndex;i<event.results.length;i++){
        const value=event.results[i][0].transcript.trim();
        if(event.results[i].isFinal) finalText+=' '+value; else interim+=' '+value;
      }
      setTranscript(finalText.trim(),interim.trim());
      const heard=(finalText||interim).trim(); if(!heard) return;
      if(state.speaking||state.busy){cancelActive('barge-in'); state.awake=true; setOrb('listening',{label:'I’m listening'});}
      const hasWake=/\b(?:hey|hi|okay|ok)?\s*lola\b/i.test(heard);
      if(hasWake){
        state.awake=true; state.lastWakeAt=Date.now(); setOrb('listening',{label:'I’m listening'});
        const command=commandFrom(heard);
        if(command&&finalText){try{recognition.stop();}catch{} askLola(command);}
        else if(finalText) toast('I’m listening.');
        return;
      }
      if(state.awake&&finalText&&Date.now()-state.lastWakeAt<20000){try{recognition.stop();}catch{} askLola(finalText.trim());}
    };
    state.recognition=recognition; return true;
  }
  async function enable(){
    if(state.enabled) return;
    state.enabled=true; setOrb('waking',{label:'Starting Lola…'});
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      stream.getTracks().forEach(track=>track.stop());
      if(state.audioContext?.state==='suspended') await state.audioContext.resume();
    }catch(error){state.enabled=false; setOrb('error',{label:'Microphone permission required'}); toast('Allow microphone access, then tap Lola again.'); return;}
    if(!state.recognition&&!initRecognition()){state.enabled=false; setOrb('degraded',{label:'Voice wake is unavailable in this browser'}); toast('Tap Lola to use chat instead.'); return;}
    setOrb('ambient',{label:'Say “Hey Lola”'}); scheduleRestart(0); toast('Lola is with you. Say “Hey Lola”.');
    try{localStorage.setItem('loladesk_resonance','on');}catch{}
  }
  function disable(){
    state.enabled=false; state.awake=false; clearTimeout(state.restartTimer); cancelActive('disabled');
    try{state.recognition&&state.recognition.stop();}catch{}
    setTranscript('',''); setOrb('idle',{label:'Tap Lola to start'}); try{localStorage.removeItem('loladesk_resonance');}catch{}
  }
  function bind(){
    document.addEventListener('click',event=>{
      const target=event.target.closest('.lola-orb,.orb,#lolaOrb,[data-lola-orb],[data-lola-voice]'); if(!target) return;
      if(!state.enabled) enable(); else{cancelActive('manual-wake'); state.awake=true; state.lastWakeAt=Date.now(); setOrb('listening',{label:'I’m listening'}); toast('I’m listening.'); scheduleRestart(0);}
    });
    window.addEventListener('keydown',event=>{
      if((event.metaKey||event.ctrlKey)&&event.code==='Space'){event.preventDefault(); state.enabled?disable():enable();}
      if(event.key==='Escape'&&(state.speaking||state.busy)){cancelActive('escape'); scheduleRestart(100);}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden) cancelActive('backgrounded'); else if(state.enabled) scheduleRestart(150);});
    window.addEventListener('pagehide',()=>cancelActive('pagehide'));
  }
  async function boot(){
    try{const auth=await window.LolaAuth.ready; state.ownerName=(auth?.tenant?.owner_name||auth?.user?.user_metadata?.full_name||'there').split(' ')[0];}catch{}
    bind(); let auto=false; try{auto=localStorage.getItem('loladesk_resonance')==='on';}catch{}
    if(auto) enable(); else setOrb('idle',{label:'Tap Lola to start'});
  }

  window.LolaResonance={enable,disable,ask:askLola,cancel:cancelActive,state};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();