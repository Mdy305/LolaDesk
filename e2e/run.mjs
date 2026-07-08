/**
 * e2e/run.mjs — LolaDesk launch-readiness end-to-end test
 * ════════════════════════════════════════════════════════════════
 * Runs the REAL api handlers against the REAL schema (local Postgres
 * behind e2e/supabase-emulator.mjs). No LLM / Telnyx / ElevenLabs
 * keys are set on purpose: the deterministic fallbacks are part of
 * what must survive launch.
 *
 * Journey:
 *   1. POST /api/auth/signup      — owner signs up (tenant + link row)
 *   2. POST /api/auth/login       — gets a session token
 *   3. GET  /api/data?overview    — dashboard loads THEIR tenant only
 *   4. POST /api/settings         — saves 'knowledge' (column existed? bug class)
 *   5. inbound SMS webhook        — caller texts; Lola resolves tenant by
 *                                   number, replies, REMEMBERS the caller
 *   6. POST /api/lola             — dashboard brain answers + persists the
 *                                   exchange; fresh session recalls history
 *   7. unauthorized checks        — no token → 401; wrong-tenant isolation
 *
 * Usage: node e2e/run.mjs   (expects local Postgres with schema loaded)
 */
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY = 'e2e-service-key';
process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.TELNYX_API_KEY; delete process.env.TELNYX_PUBLIC_KEY;
delete process.env.ELEVENLABS_API_KEY; delete process.env.ANTHROPIC_API_KEY;

import { start } from './supabase-emulator.mjs';
import pg from 'pg';
const sql = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/loladesk' });

const results = [];
function check(name, ok, detail=''){ results.push({name, ok, detail}); console.log((ok?'PASS':'FAIL').padEnd(5), name, detail?('— '+detail):''); }

function makeRes(){
  return { headers:{}, code:0, body:null,
    setHeader(k,v){ this.headers[k]=v; }, writeHead(c,h){ this.code=c; Object.assign(this.headers,h||{}); return this; },
    status(c){ this.code=c; return this; },
    json(b){ this.body=b; return this; }, send(b){ this.body=b; return this; }, end(b){ if(b!==undefined) this.body=b; return this; } };
}
const post = (body, headers={}) => ({ method:'POST', url:'/x', headers:{'content-type':'application/json',...headers}, body });
const get  = (url, headers={}) => ({ method:'GET', url, headers });

await start();
const TEST_PHONE = '+13055559999';

/* 1 — SIGNUP */
const signup = (await import('../api/auth/signup.js')).default;
let r = makeRes();
await signup(post({ email:'e2e@salon.com', password:'sup3r-secret', name:'Eve', salonName:'E2E Beauty Bar', location:'Miami', hours:'9-6', plan:'pro', websiteUrl:'https://e2e.bar', businessMode:'medspa' }), r);
const signupTok = r.body?.session?.access_token || r.body?.token || r.body?.access_token;
check('signup returns 200 + session', r.code===200 && !!signupTok, `code=${r.code}`);
const t = (await sql.query(`select * from tenants where owner_email='e2e@salon.com'`)).rows[0];
check('tenant row created with website_url/business_mode', !!t && t.website_url==='https://e2e.bar' && t.business_mode==='medspa');
const link = (await sql.query(`select * from tenant_users where tenant_id=$1`, [t?.id])).rows[0];
check('tenant_users owner link created', !!link && link.role==='owner');
await sql.query(`update tenants set phone_number=$1, services='[{"name":"Balayage","price":395,"duration":"2h30"}]'::jsonb where id=$2`, [TEST_PHONE, t.id]);

/* 2 — LOGIN */
const login = (await import('../api/auth/login.js')).default;
r = makeRes();
await login(post({ email:'e2e@salon.com', password:'sup3r-secret' }), r);
const tok = r.body?.session?.access_token || r.body?.token || r.body?.access_token;
check('login returns session token', r.code===200 && !!tok, `code=${r.code}`);

/* 3 — DASHBOARD DATA (tenant isolation) */
const data = (await import('../api/data.js')).default;
r = makeRes();
await data(get('/api/data?resource=overview', { authorization:'Bearer '+tok }), r);
check('overview 200 for authed owner', r.code===200, `code=${r.code}`);
check('overview is THEIR tenant', JSON.stringify(r.body||{}).includes('E2E Beauty Bar'));
r = makeRes();
await data(get('/api/data?resource=overview'), r);
check('overview without token → 401', r.code===401, `code=${r.code}`);

/* 4 — SETTINGS knowledge save */
const settings = (await import('../api/settings.js')).default;
r = makeRes();
await settings(post({ knowledge:'We specialize in medspa facials; closed Mondays.' }, { authorization:'Bearer '+tok }), r);
const t2 = (await sql.query(`select knowledge from tenants where id=$1`, [t.id])).rows[0];
check('settings saves knowledge column', r.code===200 && /medspa facials/.test(t2?.knowledge||''), `code=${r.code}`);

/* 5 — INBOUND SMS: Lola answers AND remembers */
const sms = (await import('../api/telnyx-sms.js')).default;
r = makeRes();
await sms(post({ data:{ event_type:'message.received', payload:{ type:'SMS', direction:'inbound', from:{ phone_number:'+13055550777' }, to:[{ phone_number: TEST_PHONE }], text:'Hi! My name is Sarah and I love balayage. What are your prices?' } } }), r);
check('sms webhook 200', r.code===200, `code=${r.code}`);
const msgs = (await sql.query(`select role, content from messages where tenant_id=$1 order by created_at`, [t.id])).rows;
check('sms conversation persisted (user+assistant)', msgs.some(m=>m.role==='user') && msgs.some(m=>m.role==='assistant'), `${msgs.length} msgs`);
const mem = (await sql.query(`select key, value from client_memories where tenant_id=$1 and client_phone='+13055550777'`, [t.id])).rows;
check('Lola REMEMBERS the caller (client_memories row)', mem.length>0, mem.map(m=>m.key).join(','));
const optRow = (await sql.query(`select opted_out from clients where tenant_id=$1 and phone_number='+13055550777'`, [t.id])).rows[0];
check('client row upserted', !!optRow);

/* 5b — STOP compliance */
r = makeRes();
await sms(post({ data:{ event_type:'message.received', payload:{ type:'SMS', direction:'inbound', from:{ phone_number:'+13055550777' }, to:[{ phone_number: TEST_PHONE }], text:'STOP' } } }), r);
const opt2 = (await sql.query(`select opted_out from clients where tenant_id=$1 and phone_number='+13055550777'`, [t.id])).rows[0];
check('STOP sets opted_out', opt2?.opted_out === true);

/* 6 — DASHBOARD BRAIN: answers + persists + recalls */
const lola = (await import('../api/lola.js')).default;
r = makeRes();
await lola(post({ messages:[{ role:'user', content:'what services do you offer' }], system:'You are Lola.' }, { authorization:'Bearer '+tok }), r);
const reply1 = r.body?.content?.[0]?.text || '';
check('dashboard brain replies (deterministic path, no LLM keys)', r.code===200 && reply1.length>0, `code=${r.code}`);
check('reply mentions the salon services', /balayage/i.test(reply1), reply1.slice(0,60));
const dashMsgs = (await sql.query(`select m.role from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='dashboard'`, [t.id])).rows;
check('dashboard exchange persisted to memory substrate', dashMsgs.length>=2, `${dashMsgs.length} rows`);

/* 6b — fresh session recall: a brand-new browser session should still work
       and the persisted history should grow, not reset */
r = makeRes();
await lola(post({ messages:[{ role:'user', content:'what services do you offer' }], system:'You are Lola.' }, { authorization:'Bearer '+tok }), r);
const dashMsgs2 = (await sql.query(`select m.role from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='dashboard'`, [t.id])).rows;
check('fresh session appends to the SAME memory', r.code===200 && dashMsgs2.length > dashMsgs.length, `${dashMsgs.length} → ${dashMsgs2.length}`);

/* 6c — no token → 401 */
r = makeRes();
await lola(post({ messages:[{ role:'user', content:'hi' }] }), r);
check('dashboard brain without token → 401', r.code===401, `code=${r.code}`);

/* 7 — cross-tenant isolation: a second owner cannot see tenant 1 */
r = makeRes();
await signup(post({ email:'other@salon.com', password:'pw-other-1', name:'Ada', salonName:'Other Spa' }), r);
r = makeRes();
await login(post({ email:'other@salon.com', password:'pw-other-1' }), r);
const tok2 = r.body?.session?.access_token || r.body?.token || r.body?.access_token;
r = makeRes();
await data(get('/api/data?resource=overview', { authorization:'Bearer '+tok2 }), r);
const leaked = JSON.stringify(r.body||{}).includes('E2E Beauty Bar');
check('tenant isolation: owner 2 never sees owner 1 data', r.code===200 && !leaked, `code=${r.code}`);


/* 8 — SHARED JARVIS LINE: one number, every tenant */
const OPERATOR_LINE = '+18005551000';   // the shared Jarvis number
const OWNER_CELL    = '+13055551000';   // Eve's registered cell

const opSetup = (await import('../api/operator-setup.js')).default;
r = makeRes();
await opSetup(post({ operator_phone: OWNER_CELL, pin: '4321' }, { authorization:'Bearer '+tok }), r);
const t3 = (await sql.query(`select operator_phone, operator_pin_hash from tenants where id=$1`, [t.id])).rows[0];
check('operator-setup registers cell + PIN hash', r.code===200 && t3?.operator_phone===OWNER_CELL && !!t3?.operator_pin_hash, `code=${r.code}`);

const opVoice = (await import('../api/operator-voice.js')).default;
const opCall = (speech='', qs='') => ({ method:'POST', url:'/api/operator-voice'+qs, headers:{'content-type':'application/json'}, body:{ From: OWNER_CELL, To: OPERATOR_LINE, CallSid:'op-1', SpeechResult: speech } });

r = makeRes();
await opVoice(opCall(), r);
check('Jarvis greets the OWNER by name (tenant by caller)', r.code===200 && /Eve/.test(r.body) && /<Gather/.test(r.body), `code=${r.code}`);

r = makeRes();
await opVoice(opCall('how much did we make this month'), r);
check('Jarvis answers revenue by voice', r.code===200 && /\$/.test(r.body), (r.body.match(/<Say[^>]*>([^<]*)/)||[])[1]);

/* seed a booking for tomorrow, then cancel it by voice with PIN */
const tomorrow = new Date(Date.now()+864e5); tomorrow.setHours(14,0,0,0);
const cl = (await sql.query(`insert into clients (tenant_id, phone_number, name) values ($1,'+13055553333','Sarah Jones') returning id`, [t.id])).rows[0];
const bk = (await sql.query(`insert into bookings (tenant_id, client_id, service, starts_at, price, status) values ($1,$2,'Balayage',$3,395,'confirmed') returning id`, [t.id, cl.id, tomorrow.toISOString()])).rows[0];

r = makeRes();
await opVoice(opCall("cancel sarah's appointment tomorrow"), r);
const stateMatch = String(r.body).match(/state=([A-Za-z0-9_-]+)/);
check('destructive command asks for PIN + carries HMAC state', r.code===200 && /PIN/i.test(r.body) && !!stateMatch, (r.body.match(/<Say[^>]*>([^<]*)/)||[])[1]);

r = makeRes();
await opVoice(opCall('4 3 2 1 confirm', `?state=${stateMatch[1]}`), r);
const bk2 = (await sql.query(`select status from bookings where id=$1`, [bk.id])).rows[0];
check('PIN confirm executes: booking cancelled in DB', r.code===200 && bk2?.status==='cancelled', `status=${bk2?.status}`);

r = makeRes();
await opVoice(opCall('9 9 9 9 confirm', `?state=${stateMatch[1]}`), r);
check('wrong PIN changes nothing', /PIN doesn/i.test(r.body) || /didn'?t match/i.test(String(r.body)), (r.body.match(/<Say[^>]*>([^<]*)/)||[])[1]);

r = makeRes();
await opVoice({ method:'POST', url:'/api/operator-voice', headers:{'content-type':'application/json'}, body:{ From:'+19998887777', To: OPERATOR_LINE, SpeechResult:'' } }, r);
check('unknown caller on Jarvis line is refused + hung up', /registered salon owners/i.test(r.body) && /<Hangup\/>/.test(r.body));

/* 9 — CALLS TABLE: the value ledger fills itself */
const voice = (await import('../api/telnyx-voice.js')).default;
const vCall = (speech='') => post({ CallSid:'call-e2e-1', From:'+13055550777', To: TEST_PHONE, SpeechResult: speech });
r = makeRes(); await voice(vCall(), r);           // greeting → row created
r = makeRes(); await voice(vCall('do you have anything friday for a balayage'), r); // turn → transcript
const callRow = (await sql.query(`select direction, transcript, outcome from calls where tenant_id=$1 and telnyx_call_id='call-e2e-1'`, [t.id])).rows[0];
check('calls row created on answer', !!callRow && callRow.direction==='inbound');
check('call transcript accumulates per turn', /Caller: do you have anything friday/.test(callRow?.transcript||''), (callRow?.transcript||'').slice(0,50));


/* 10 — eSIM RESALE: auth walls + graceful unconfigured behavior */
const esim = (await import('../api/telnyx-esim.js')).default;
r = makeRes();
await esim(get('/api/telnyx-esim'), r);
check('esim without token → 401', r.code===401, `code=${r.code}`);
r = makeRes();
await esim(get('/api/telnyx-esim', { authorization:'Bearer '+tok }), r);
check('esim status for tenant with none → pricing offer', r.code===200 && r.body?.esim===null && r.body?.pricing?.retail_monthly>0, `code=${r.code}`);
r = makeRes();
await esim(post({ action:'order' }, { authorization:'Bearer '+tok }), r);
check('esim order without Telnyx key fails SAFELY (no phantom billing)', r.code===503, `code=${r.code}`);
const rent = (await sql.query(`select count(*)::int n from usage_events where tenant_id=$1 and kind='esim_rent'`, [t.id])).rows[0];
check('no esim_rent event logged on failed order', rent.n===0);


/* 11 — FULL CONVERSATION: the owner brain on both channels */
const { buildOwnerSystemPrompt } = await import('../api/lib/owner-brain.js');
const tRow = (await sql.query(`select * from tenants where id=$1`, [t.id])).rows[0];
const ownerPrompt = await buildOwnerSystemPrompt(tRow, { channel:'voice' });
check('owner brain prompt grounds in THIS salon', /E2E Beauty Bar/.test(ownerPrompt) && /Balayage/.test(ownerPrompt), '');
check('owner brain prompt carries LIVE numbers', /this week: \$/.test(ownerPrompt) && /overdue to rebook/.test(ownerPrompt), '');
check('owner brain prompt carries owner knowledge notes', /medspa facials/.test(ownerPrompt), '');

/* voice: off-grammar question degrades gracefully (no LLM keys here) */
const opMsgsBefore = (await sql.query(`select count(*)::int n from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='operator'`, [t.id])).rows[0].n;
r = makeRes();
await opVoice(opCall('should i raise my balayage prices'), r);
check('Jarvis voice: open question answered gracefully (LLM down → help, never dead air)', r.code===200 && /<Gather/.test(r.body), `code=${r.code}`);
const opMsgsAfter = (await sql.query(`select count(*)::int n from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='operator'`, [t.id])).rows[0].n;
check('open-question exchange persisted to operator audit trail', opMsgsAfter > opMsgsBefore, `${opMsgsBefore} → ${opMsgsAfter}`);

/* sms: owner texts the shared Jarvis number → owner chat, not demo salon */
const JARVIS_SMS = '+18005551000';
r = makeRes();
await sms(post({ data:{ event_type:'message.received', payload:{ type:'SMS', direction:'inbound', from:{ phone_number: OWNER_CELL }, to:[{ phone_number: JARVIS_SMS }], text:'how are we doing this month?' } } }), r);
check('owner texting Jarvis line → owner chat mode (never the demo salon)', r.code===200 && r.body?.handled==='owner_chat', JSON.stringify(r.body));
const opSms = (await sql.query(`select count(*)::int n from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='operator' and m.agent='jarvis'`, [t.id])).rows[0].n;
check('owner SMS exchange persisted to the same Jarvis memory', opSms >= 2, `${opSms} rows`);

/* a stranger texting the Jarvis number is ignored, not routed anywhere */
r = makeRes();
await sms(post({ data:{ event_type:'message.received', payload:{ type:'SMS', direction:'inbound', from:{ phone_number:'+17775551234' }, to:[{ phone_number: JARVIS_SMS }], text:'hi' } } }), r);
check('stranger texting Jarvis line is ignored', r.code===200 && (r.body?.ignored==='no_tenant' || r.body?.handled!=='owner_chat'), JSON.stringify(r.body));


/* 12 — WIDGET: Lola on the tenant's own website, strictly isolated */
const { widgetKeyFor } = await import('../api/widget-chat.js');
const widgetChat = (await import('../api/widget-chat.js')).default;
const widgetEmbed = (await import('../api/widget-embed.js')).default;

r = makeRes();
await widgetEmbed(get('/api/widget-embed'), r);
check('widget-embed without token → 401', r.code===401, `code=${r.code}`);
r = makeRes();
await widgetEmbed(get('/api/widget-embed', { authorization:'Bearer '+tok }), r);
const embKey = r.body?.key, embSlug = r.body?.slug;
check('widget-embed returns snippet for THIS tenant', r.code===200 && r.body?.snippet?.includes(embSlug) && r.body?.snippet?.includes('widget.js'), `slug=${embSlug}`);

r = makeRes();
await widgetChat(post({ slug: embSlug, key: 'wrong-key-000000000000000000000000', visitor_id:'vTest1', message:'hi' }), r);
check('widget with wrong key → 401', r.code===401, `code=${r.code}`);

/* tenant A's key can never open tenant B's Lola */
const otherSlug = (await sql.query(`select slug from tenants where owner_email='other@salon.com'`)).rows[0].slug;
r = makeRes();
await widgetChat(post({ slug: otherSlug, key: embKey, visitor_id:'vTest1', message:'hi' }), r);
check('cross-tenant widget key rejected (isolation)', r.code===401, `code=${r.code}`);

r = makeRes();
await widgetChat(get(`/api/widget-chat?slug=${embSlug}&key=${embKey}`), r);
check('widget config greets with the RIGHT salon', r.code===200 && /E2E Beauty Bar/.test(JSON.stringify(r.body)), '');

r = makeRes();
await widgetChat(post({ slug: embSlug, key: embKey, visitor_id:'vTest1', message:'what services do you offer?' }), r);
check('website visitor gets a real answer', r.code===200 && /balayage/i.test(r.body?.reply||''), (r.body?.reply||'').slice(0,60));

r = makeRes();
await widgetChat(post({ slug: embSlug, key: embKey, visitor_id:'vTest1', message:'my name is Nina and I love balayage' }), r);
const webMem = (await sql.query(`select key from client_memories where tenant_id=$1 and client_phone='web:vTest1'`, [t.id])).rows;
check('Lola REMEMBERS the website visitor', r.code===200 && webMem.length>0, webMem.map(x=>x.key).join(','));
const webConv = (await sql.query(`select count(*)::int n from messages m join conversations c on c.id=m.conversation_id where c.tenant_id=$1 and c.channel='web'`, [t.id])).rows[0];
check('web conversations persist to the shared substrate', webConv.n >= 4, `${webConv.n} msgs`);


/* 13 — ADMIN COMMAND: platform control, hard-gated */
const admin = (await import('../api/admin.js')).default;
r = makeRes();
await admin(get('/api/admin'), r);
check('admin without token → 401', r.code===401, `code=${r.code}`);
delete process.env.ADMIN_EMAILS;
r = makeRes();
await admin(get('/api/admin', { authorization:'Bearer '+tok }), r);
check('admin with owner token but no allowlist → 403', r.code===403, `code=${r.code}`);
process.env.ADMIN_EMAILS = 'ops@loladesk.com, E2E@salon.com';
r = makeRes();
await admin(get('/api/admin', { authorization:'Bearer '+tok }), r);
check('allowlisted email sees platform metrics + roster', r.code===200 && r.body?.metrics?.tenants>=2 && JSON.stringify(r.body.tenants).includes('E2E Beauty Bar'), `tenants=${r.body?.metrics?.tenants}`);
const otherId = (await sql.query(`select id from tenants where owner_email='other@salon.com'`)).rows[0].id;
r = makeRes();
await admin(post({ action:'suspend', tenant_id: otherId }, { authorization:'Bearer '+tok }), r);
const susp = (await sql.query(`select billing_status from tenants where id=$1`, [otherId])).rows[0];
check('suspend flips billing_status (data untouched)', r.code===200 && susp.billing_status==='suspended', susp.billing_status);
r = makeRes();
await admin(post({ action:'activate', tenant_id: otherId }, { authorization:'Bearer '+tok }), r);
const act2 = (await sql.query(`select billing_status from tenants where id=$1`, [otherId])).rows[0];
check('activate restores instantly', r.code===200 && act2.billing_status==='active', act2.billing_status);

/* ── summary ── */
const fails = results.filter(x=>!x.ok);
console.log('\n' + '─'.repeat(50));
console.log(`${results.length - fails.length}/${results.length} checks passed`);
if(fails.length){ console.log('FAILURES:'); fails.forEach(f=>console.log(' ✗', f.name, f.detail)); process.exit(1); }
console.log('LAUNCH-READY: full journey green.');
process.exit(0);
