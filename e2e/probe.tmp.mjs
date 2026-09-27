process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY = 'e2e-service-key';
process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.TELNYX_API_KEY; delete process.env.TELNYX_PUBLIC_KEY;
process.env.ELEVENLABS_API_KEY = 'e2e-eleven-key';
process.env.ELEVENLABS_VOICE_ID = 'e2e-voice';
import { start } from './supabase-emulator.mjs';
import crypto from 'node:crypto';
import { db } from '../api/lib/db.js';
await start();
const text = "This line is reserved for registered salon owners. Add your cell as the operator phone in your LolaDesk settings, then call me right back.";
const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
const key = crypto.createHash('sha1').update(`${voiceId}|${text}`).digest('hex');
const supabase = db();
const { data: pubData } = supabase.storage.from('voice-audio').getPublicUrl(`cached/${key}.mp3`);
console.log('URL:', pubData?.publicUrl);
const c1 = new AbortController(); const t1 = setTimeout(()=>c1.abort(), 3000);
try { const r = await fetch(pubData.publicUrl, { method:'HEAD', signal:c1.signal }); clearTimeout(t1); console.log('direct HEAD:', r.status, r.ok); }
catch(e){ clearTimeout(t1); console.log('direct HEAD THREW:', e.message); }

// now the real handler path
const opVoice = (await import('../api/operator-voice.js')).default;
const makeRes = () => ({ headers:{}, code:0, body:null, setHeader(){}, writeHead(c,h){ this.code=c; Object.assign(this.headers,h||{}); return this; }, status(c){ this.code=c; return this; }, json(b){ this.body=b; return this; }, send(b){ this.body=b; return this; }, end(b){ if(b!==undefined) this.body=b; return this; } });
const r = makeRes();
try { await opVoice({ method:'POST', url:'/api/operator-voice', headers:{'content-type':'application/json'}, body:{ From:'+19998887777', To:'+18005551000', SpeechResult:'' } }, r); }
catch(e){ console.log('handler THREW:', e.message); }
console.log('handler code:', r.code);
process.exit(0);
