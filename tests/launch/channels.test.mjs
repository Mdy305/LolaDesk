// Every salon connects Facebook Messenger and WhatsApp (plus Instagram) by talking
// to Lola — and Lola answers there with the same memory and booking hands, per
// salon, never leaking across salons.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INSTAGRAM_APP_ID = 'meta-app'; process.env.INSTAGRAM_APP_SECRET = 'meta-secret'; process.env.META_VERIFY_TOKEN = 'verify-fb';
delete process.env.FACEBOOK_APP_ID; delete process.env.FACEBOOK_APP_SECRET; delete process.env.FACEBOOK_CONFIG_ID; delete process.env.INSTAGRAM_VERIFY_TOKEN;
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-lola'; process.env.ADMIN_EMAILS = 'boss@loladesk.com';
delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ── fake world ──
const graph = [], fbSends = [], telnyx = [], llmCalls = [];
let pagesForCode = {}; let script = [];
const PAGE_TOKENS = { 'PAGE-MMA': 'page-tok-mma', 'PAGE-OTHER': 'page-tok-other', 'PAGE-SPA': 'page-tok-spa' };
let WABA_NUMBERS = [];
let liveTemplates = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const method = init.method || 'GET';
  if (u.includes('chat/completions')) { const b = JSON.parse(init.body); llmCalls.push(b); const next = script.shift() || { content: 'Happy to help!' }; return J({ choices: [{ message: { role: 'assistant', content: next.content || null, tool_calls: next.tool_calls } }] }); }
  if (u.startsWith('https://graph.facebook.com/')) {
    graph.push({ url: u, method, body: init.body || null });
    const p = new URL(u);
    if (p.pathname.endsWith('/oauth/access_token')) {
      if (p.searchParams.get('grant_type') === 'fb_exchange_token') return J({ access_token: 'long-' + p.searchParams.get('fb_exchange_token'), token_type: 'bearer', expires_in: 5184000 });
      return J({ access_token: 'user-' + p.searchParams.get('code') });
    }
    if (p.pathname.endsWith('/me/accounts')) { const tok = p.searchParams.get('access_token'); return J({ data: pagesForCode[tok] || [] }); }
    if (p.pathname.endsWith('/subscribed_apps')) return method === 'GET' ? J({ data: [{ id: 'meta-app', name: 'LolaDesk', subscribed_fields: ['messages'] }] }) : J({ success: true });
    if (p.pathname.endsWith('/messages') && method === 'POST') { fbSends.push({ url: u, page: p.pathname.split('/')[2], token: p.searchParams.get('access_token'), proof: p.searchParams.get('appsecret_proof'), ...JSON.parse(init.body) }); return J({ recipient_id: 'x', message_id: 'mid.out' }); }
    if (/\/PSID-/.test(p.pathname)) return J({ first_name: 'Sarah', last_name: 'Kim' });
    return J({ data: [] });
  }
  if (u.startsWith('https://api.instagram.com/oauth/access_token')) return J({ access_token: 'ig-short', user_id: 'IG-MMA' });
  if (u.startsWith('https://graph.instagram.com/access_token')) return J({ access_token: 'ig-long', expires_in: 5184000 });
  if (u.startsWith('https://graph.instagram.com/v21.0/me?')) return J({ user_id: 'IG-MMA', username: 'mmasalon' });
  if (u.startsWith('https://api.telnyx.com/v2/')) {
    const p = new URL(u); const body = init.body ? JSON.parse(init.body) : null;
    telnyx.push({ path: p.pathname.replace('/v2', ''), query: Object.fromEntries(p.searchParams), method, body });
    if (p.pathname === '/v2/whatsapp/business_accounts') return J({ data: [{ id: 'waba-uuid-1', waba_id: '1221529010180092', name: 'LolaDesk Salons', status: 'ACTIVE', country: 'US' }] });
    if (p.pathname === '/v2/whatsapp/phone_numbers') return J({ data: p.searchParams.get('waba_id') === 'waba-uuid-1' ? WABA_NUMBERS : [] });
    if (p.pathname === '/v2/whatsapp/message_templates' && method === 'GET') return J({ data: liveTemplates });
    if (p.pathname === '/v2/whatsapp/message_templates' && method === 'POST') { const t = { id: 'tpl-' + body.name, waba_id: '1221529010180092', name: body.name, category: body.category, language: body.language, status: 'PENDING', components: body.components }; liveTemplates.push(t); return J({ data: t }); }
    if (p.pathname === '/v2/phone_numbers/actions/verify_ownership') return J({ data: { found: body.phone_numbers.map((n) => ({ phone_number: n, id: 'pn-' + n.slice(-4) })), not_found: [], record_type: 'phone_number_ownership' } });
    if (/^\/v2\/phone_numbers\/[^/]+\/messaging$/.test(p.pathname)) return J({ data: { id: 'x', messaging_profile_id: method === 'PATCH' ? body.messaging_profile_id : 'some-other-profile' } });
    if (p.pathname === '/v2/messages/whatsapp' || p.pathname === '/v2/messages') return J({ data: { id: 'msg-1', type: body.type || 'SMS' } });
    return J({ data: [] });
  }
  return J({ data: [] });
};

const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '00000000-0000-4000-8000-0000000000c1', OTHER = '00000000-0000-4000-8000-0000000000c2', DAY = 864e5, now = Date.now();
T.tenants = [
  { id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Blowout', price: 65, duration: 45 }] },
  { id: OTHER, name: 'Glow Spa', slug: 'glow', subscription_status: 'active', phone_number: '+17865550199', services: [] }
];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', kind: 'primary', status: 'active' }, { tenant_id: OTHER, phone_number: '+17865550199', kind: 'primary', status: 'active' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner' }, { user_id: 'u2', tenant_id: OTHER, role: 'owner' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' }, tok2: { id: 'u2', email: 'o@glow.com' }, boss: { id: 'u9', email: 'boss@loladesk.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York' }, { tenant_id: OTHER, timezone: 'America/New_York' }];
T.clients = [{ id: 'sarah', tenant_id: TID, first_name: 'Sarah', last_name: 'Kim', name: 'Sarah Kim', phone: '+13055554444' }];
T.bookings = []; T.services = []; T.staff = []; T.client_memories = []; T.conversations = []; T.messages = []; T.usage_events = []; T.opt_outs = [];
T.tenant_channels = []; T.whatsapp_templates = []; T.telnyx_events = []; T.integrations = []; T.platform_settings = [];

const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: t }); }, end(t) { resolve({ status: this.statusCode, text: t, headers: this.headers }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, ...req }, res); }); };
const { db } = await import(P + 'lib/db.js');
const fb = await import(P + 'lib/messenger-dm.js');
const ig = await import(P + 'lib/instagram-dm.js');
const { decrypt } = await import(P + 'lib/crypto.js');

// ── 1. The connect link can't be forged ──
const st = fb.signState(TID);
ok(fb.readState(st) === TID, 'a real state names the salon that started it');
const parts = st.split('.');
ok(fb.readState([OTHER, parts[1], parts[2], parts[3]].join('.')) === null, 'swapping in another salon breaks the seal');
ok(fb.readState(st.slice(0, -1) + (st.endsWith('a') ? 'b' : 'a')) === null, 'a tampered signature is refused');
ok(fb.readState(fb.signState(TID, now - 31 * 60e3)) === null, 'a stale (31 min) state is refused');
ok(fb.readState(ig.signState(TID)) === null, 'an Instagram state can’t be replayed to connect Facebook');
const au = new URL(fb.authUrl(TID));
ok(au.origin + au.pathname === 'https://www.facebook.com/v21.0/dialog/oauth' && au.searchParams.get('scope') === 'pages_show_list,pages_messaging,pages_manage_metadata' && au.searchParams.get('redirect_uri') === 'https://www.loladesk.com/api/messenger' && fb.readState(au.searchParams.get('state')) === TID, 'connect goes to Facebook with exactly the Messenger permissions');

// ── 2. Callback: one Page → token sealed, Page subscribed ──
pagesForCode['long-user-code1'] = [{ id: 'PAGE-MMA', name: 'MMA Salon Miami', access_token: PAGE_TOKENS['PAGE-MMA'], tasks: ['MESSAGING'] }];
let r = await run('messenger.js', { method: 'GET', url: '/api/messenger?code=code1&state=' + encodeURIComponent(fb.signState(TID)) });
ok(r.status === 302 && r.headers.Location === '/settings?messenger=connected', 'Facebook sends the owner back: connected');
const row = T.tenant_channels.find((x) => x.channel === 'messenger' && x.account_id === 'PAGE-MMA');
ok(row && row.tenant_id === TID && row.status === 'active' && row.username === 'MMA Salon Miami', 'the Page is saved for this salon');
ok(row && /^v1:/.test(row.access_token) && !String(row.access_token).includes('page-tok-mma') && decrypt(row.access_token) === 'page-tok-mma', 'the Page token is stored ENCRYPTED (AES-GCM), never in plaintext');
const sub = graph.find((g) => g.method === 'POST' && /\/v21\.0\/PAGE-MMA\/subscribed_apps/.test(g.url));
ok(sub && new URL(sub.url).searchParams.get('subscribed_fields') === 'messages,messaging_postbacks' && new URL(sub.url).searchParams.get('access_token') === 'page-tok-mma' && new URL(sub.url).searchParams.get('appsecret_proof') === crypto.createHmac('sha256', 'meta-secret').update('page-tok-mma').digest('hex'), 'the Page is subscribed to the app (messages, messaging_postbacks) with appsecret_proof');
ok(graph.some((g) => /fb_exchange_token/.test(g.url)), 'the user token is exchanged for a long-lived one first');
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?code=x&state=forged.' + Date.now() + '.ab.cd' });
ok(r.status === 302 && r.headers.Location === '/settings?messenger=expired' && T.tenant_channels.filter((x) => x.channel === 'messenger').length === 1, 'a forged state connects nothing');

// ── 3. Another salon can't take over the Page ──
pagesForCode['long-user-code2'] = [{ id: 'PAGE-MMA', name: 'MMA Salon Miami', access_token: 'stolen-tok' }];
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?code=code2&state=' + encodeURIComponent(fb.signState(OTHER)) });
ok(r.headers.Location === '/settings?messenger=taken', 'another salon trying the same Page is told plainly: already connected');
ok(T.tenant_channels.find((x) => x.channel === 'messenger' && x.account_id === 'PAGE-MMA').tenant_id === TID && decrypt(T.tenant_channels.find((x) => x.account_id === 'PAGE-MMA').access_token) === 'page-tok-mma', 'the Page still belongs to MMA, token untouched');
const takeIg = await (await import(P + 'lib/channel-store.js')).saveChannelRow(db(), { tenant_id: OTHER, channel: 'messenger', account_id: 'PAGE-MMA', status: 'active' });
ok(takeIg.ok === false && takeIg.taken && /another salon/.test(takeIg.say), 'the shared store refuses a takeover too');
T.tenant_channels.push({ tenant_id: TID, channel: 'instagram', account_id: 'IG-MMA', status: 'active', access_token: 'plain:x' });
let igErr = null; try { await ig.connectInstagram(db(), OTHER, 'c'); } catch (e) { igErr = e; }
ok(igErr?.code === 'taken' && T.tenant_channels.find((x) => x.account_id === 'IG-MMA').tenant_id === TID, 'Instagram too: another salon can’t take over a connected account');
const mine = await ig.connectInstagram(db(), TID, 'c').catch((e) => ({ ok: false, e }));
ok(mine.ok && T.tenant_channels.filter((x) => x.account_id === 'IG-MMA').length === 1, 'the same salon reconnecting its own Instagram is fine');

// ── 4. Several Pages → the owner picks ──
pagesForCode['long-user-code3'] = [{ id: 'PAGE-OTHER', name: 'Glow Spa', access_token: PAGE_TOKENS['PAGE-OTHER'] }, { id: 'PAGE-SPA', name: 'Glow Spa Events', access_token: PAGE_TOKENS['PAGE-SPA'] }];
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?code=code3&state=' + encodeURIComponent(fb.signState(OTHER)) });
ok(r.headers.Location === '/settings?messenger=choose', 'several Pages → the owner is asked which one');
const pend = T.tenant_channels.find((x) => x.channel === 'messenger_pending' && x.tenant_id === OTHER);
ok(pend && /^v1:/.test(pend.access_token) && decrypt(pend.access_token) === 'long-user-code3', 'the waiting sign-in is sealed too');
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?action=status', headers: { authorization: 'Bearer tok2' } });
ok(r.ok && r.choose.length === 2 && r.choose.map((p) => p.name).join('|') === 'Glow Spa|Glow Spa Events' && !r.connected, 'Settings shows Glow Spa’s Pages to pick from');
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?action=status', headers: { authorization: 'Bearer tok' } });
ok(r.connected && r.page === 'MMA Salon Miami' && !r.choose.length, 'MMA sees only its own Page — nothing from Glow Spa');
r = await run('messenger.js', { method: 'POST', url: '/api/messenger?action=choose', headers: { authorization: 'Bearer tok2' }, body: JSON.stringify({ page_id: 'PAGE-OTHER' }) });
ok(r.ok && /Glow Spa/.test(r.say) && T.tenant_channels.find((x) => x.account_id === 'PAGE-OTHER')?.tenant_id === OTHER && !T.tenant_channels.some((x) => x.channel === 'messenger_pending' && x.tenant_id === OTHER), 'picking a Page connects it and clears the choice');
r = await run('messenger.js', { method: 'POST', url: '/api/messenger?action=choose', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ page_id: 'PAGE-SPA' }) });
ok(!r.ok && T.tenant_channels.find((x) => x.channel === 'messenger' && x.tenant_id === TID).account_id === 'PAGE-MMA', 'MMA can’t pick a Page from Glow Spa’s sign-in');

// ── 5. Webhook ──
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?hub.mode=subscribe&hub.verify_token=verify-fb&hub.challenge=777' });
ok(r.text === '777', 'Meta’s webhook check passes with META_VERIFY_TOKEN');
r = await run('messenger.js', { method: 'GET', url: '/api/messenger?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=777' });
ok(r.status === 403, 'a wrong verify token is refused');
const msg = (text, { page = 'PAGE-MMA', psid = 'PSID-SARAH', mid = 'm.' + Math.random() } = {}) => ({ object: 'page', entry: [{ id: page, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: page }, timestamp: Date.now(), message: { mid, text } }] }] });
const sig = (b) => 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(b).digest('hex');
let raw = JSON.stringify(msg('hi, do you have time saturday?'));
r = await run('messenger.js', { url: '/api/messenger', headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) }, body: raw });
ok(r.status === 401 && fbSends.length === 0, 'a badly signed webhook is refused, nothing sent');
r = await run('messenger.js', { url: '/api/messenger', headers: { 'x-hub-signature-256': sig(raw + ' ') }, body: raw });
ok(r.status === 401, 'a signature over different bytes is refused');
script = [{ content: 'Hi Sarah! Saturday works — morning or afternoon?' }];
r = await run('messenger.js', { url: '/api/messenger', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
const sent = fbSends.at(-1);
ok(r.ok && sent && sent.page === 'PAGE-MMA' && sent.token === 'page-tok-mma' && sent.recipient.id === 'PSID-SARAH' && sent.messaging_type === 'RESPONSE' && /Saturday works/.test(sent.message.text), 'a Messenger DM gets Lola’s answer via the Send API (RESPONSE), from MMA’s Page');
const sys = llmCalls.at(-1)?.messages?.[0]?.content || '';
ok(/MMA Salon/.test(sys) && !/Glow Spa/.test(sys) && /FACEBOOK MESSENGER/.test(sys) && llmCalls.at(-1).tools?.some((t) => t.function.name === 'book_appointment'), 'it’s MMA’s Lola (not Glow Spa’s), on Messenger, with her booking hands');
const fbc = T.clients.find((x) => x.phone === 'fb:PSID-SARAH');
ok(fbc && fbc.tenant_id === TID && fbc.first_name === 'Sarah', 'the person is a client of MMA, keyed fb:<PSID>');
ok(T.client_memories.some((m) => m.tenant_id === TID && m.client_phone === 'fb:PSID-SARAH' && m.key === 'messenger'), 'her 24-hour window is remembered under fb:<PSID>');
ok(T.conversations.some((cv) => cv.tenant_id === TID && cv.channel === 'messenger' && cv.client_id === fbc.id) && T.messages.some((m) => m.tenant_id === TID && m.content === 'hi, do you have time saturday?'), 'the thread lands in MMA’s inbox');
const n0 = fbSends.length;
r = await run('messenger.js', { url: '/api/messenger', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
ok(fbSends.length === n0, 'Meta retrying the same message never double-replies');
raw = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE-MMA', messaging: [{ sender: { id: 'PAGE-MMA' }, recipient: { id: 'PSID-SARAH' }, message: { mid: 'echo1', text: 'echo', is_echo: true } }] }] });
await run('messenger.js', { url: '/api/messenger', headers: { 'x-hub-signature-256': sig(raw) }, body: raw });
ok(fbSends.length === n0, 'her own messages never loop');

// The memory key and the salon, exactly.
const seen = [];
const spy = async (a) => { seen.push(a); return { reply: 'ok ' + a.tenant.name }; };
const sends2 = []; const send2 = async (...a) => { sends2.push(a); return {}; };
await fb.handleMessengerEvent(db(), msg('hello again', { psid: 'PSID-SARAH' }), { answer: spy, send: send2 });
ok(seen[0]?.memoryKey === 'fb:PSID-SARAH' && seen[0]?.tenant.id === TID && seen[0]?.channel === 'messenger', 'answerClient gets memoryKey fb:<psid> and the right salon');
await fb.handleMessengerEvent(db(), msg('hola', { page: 'PAGE-OTHER', psid: 'PSID-ANA' }), { answer: spy, send: send2 });
ok(seen[1]?.tenant.id === OTHER && sends2[1][0] === 'PAGE-OTHER' && sends2[1][1] === 'page-tok-other' && T.clients.find((x) => x.phone === 'fb:PSID-ANA')?.tenant_id === OTHER, 'a message to Glow Spa’s Page goes to Glow Spa’s Lola only, from Glow Spa’s Page');
const before = seen.length;
await fb.handleMessengerEvent(db(), msg('hey', { page: 'PAGE-UNKNOWN' }), { answer: spy, send: send2 });
ok(seen.length === before, 'a Page no salon owns is ignored');
await fb.handleMessengerEvent(db(), msg('my number is 305-555-4444', { psid: 'PSID-SARAH' }), { answer: spy, send: send2 });
ok(T.clients.find((x) => x.phone === 'fb:PSID-SARAH').notes === 'linked:+13055554444' && seen.at(-1).memoryKey === '+13055554444' && seen.at(-1).client.id === 'sarah', 'she shares her number → Messenger Sarah IS phone Sarah: one memory');

// ── 6. The owner replies from the inbox (24-hour window respected) ──
const conv = T.conversations.find((cv) => cv.tenant_id === TID && cv.channel === 'messenger');
const n1 = fbSends.length;
r = await run('inbox-reply.js', { headers: { authorization: 'Bearer tok' }, body: { conversation_id: conv.id, text: 'See you Saturday! — Ana' } });
ok(r.ok && fbSends.length === n1 + 1 && fbSends.at(-1).message.text === 'See you Saturday! — Ana' && fbSends.at(-1).recipient.id === 'PSID-SARAH' && fbSends.at(-1).page === 'PAGE-MMA', 'the owner’s inbox reply goes out through Messenger');
r = await run('inbox-reply.js', { headers: { authorization: 'Bearer tok2' }, body: { conversation_id: conv.id, text: 'hijack' } });
ok(r.status === 404 && fbSends.length === n1 + 1, 'another salon can’t reply into MMA’s thread');
const mem = T.client_memories.find((m) => m.client_phone === 'fb:PSID-SARAH' && m.key === 'messenger');
mem.value = { ...mem.value, last_inbound_at: new Date(now - 30 * 3600e3).toISOString() };
r = await run('inbox-reply.js', { headers: { authorization: 'Bearer tok' }, body: { conversation_id: conv.id, text: 'Big sale this weekend!' } });
ok(r.status === 400 && /24 hours/.test(r.error) && fbSends.length === n1 + 1 && T.messages.some((m) => /Not sent/.test(m.content) && /Big sale/.test(m.content)), 'outside 24 hours nothing is sent — the note is just logged');

// ── 7. WhatsApp: WABA numbers → the right salon only ──
const wa = await import(P + 'lib/whatsapp-setup.js');
WABA_NUMBERS = [
  { phone_number: '+13055550100', number_id: '111', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
  { phone_number: '+17865550199', number_id: '222', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
  { phone_number: '+19995550000', number_id: '333', quality_rating: 'GREEN' }
];
let s = await wa.syncWhatsApp(db(), { tenantId: TID });
const waRows = T.tenant_channels.filter((x) => x.channel === 'whatsapp');
ok(s.matched.length === 1 && waRows.length === 1 && waRows[0].tenant_id === TID && waRows[0].account_id === '+13055550100' && waRows[0].meta.waba_id === 'waba-uuid-1', 'a sweep for MMA matches only MMA’s number');
ok(T.tenants.find((t) => t.id === TID).whatsapp_enabled === true && !T.tenants.find((t) => t.id === OTHER).whatsapp_enabled, 'MMA is WhatsApp-ready; Glow Spa untouched');
const patch = telnyx.find((t) => t.method === 'PATCH' && /\/phone_numbers\/pn-0100\/messaging$/.test(t.path));
ok(telnyx.some((t) => t.path === '/whatsapp/phone_numbers' && t.query.waba_id === 'waba-uuid-1') && patch && patch.body.messaging_profile_id === 'mp-lola', 'the number is listed via the documented endpoint and put on LolaDesk’s messaging profile');
const posts = telnyx.filter((t) => t.path === '/whatsapp/message_templates' && t.method === 'POST');
const docOk = posts.length === 3 && posts.every((p) => {
  const b = p.body; const comp = b.components[0];
  const vars = (comp.text.match(/\{\{\d+\}\}/g) || []).length;
  return b.waba_id === 'waba-uuid-1' && /^[a-z_]+$/.test(b.name) && b.category === 'UTILITY' && b.language === 'en_US' && comp.type === 'BODY' && Array.isArray(comp.example?.body_text?.[0]) && comp.example.body_text[0].length === vars && vars > 0 && Object.keys(b).sort().join(',') === 'category,components,language,name,waba_id';
});
ok(docOk && posts.map((p) => p.body.name).sort().join(',') === 'appointment_reminder,booking_confirmation,missed_call_followup', 'template creation is exactly the documented request (waba_id, name, UTILITY, en_US, BODY + realistic samples)');
ok(T.whatsapp_templates.length === 3 && T.whatsapp_templates.every((t) => t.status === 'PENDING' && t.waba_id === 'waba-uuid-1'), 'the templates are tracked (pending Meta)');
ok(T.usage_events.filter((u) => u.kind === 'cost_whatsapp_template' && u.tenant_id === TID).length === 3, 'the platform cost is recorded for the admin’s margins');
s = await wa.syncWhatsApp(db());
ok(T.tenant_channels.find((x) => x.channel === 'whatsapp' && x.account_id === '+17865550199')?.tenant_id === OTHER && s.unmatched.some((u) => u.phone_number === '+19995550000') && !T.tenant_channels.some((x) => x.account_id === '+19995550000'), 'the full sweep gives Glow Spa its own number; an unknown number goes to no one');
T.tenant_numbers.push({ tenant_id: OTHER, phone_number: '+19995550000', status: 'active' }, { tenant_id: TID, phone_number: '+19995550000', status: 'active' });
s = await wa.syncWhatsApp(db());
ok(s.conflicts.some((x) => x.phone_number === '+19995550000') && !T.tenant_channels.some((x) => x.account_id === '+19995550000'), 'a number claimed by two salons is never guessed — flagged for the admin');
T.tenant_numbers = T.tenant_numbers.filter((x) => x.phone_number !== '+19995550000');
liveTemplates = liveTemplates.map((t) => ({ ...t, status: 'APPROVED' }));
const ts = await wa.syncTemplateStatuses(db());
ok(ts.updated === 3 && T.whatsapp_templates.every((t) => t.status === 'APPROVED'), 'the nightly sync picks up Meta’s approvals');
let ws = await wa.whatsappStatus(db(), T.tenants[0]);
ok(ws.on && /WhatsApp is on for \(305\) 555-0100/.test(ws.say) && /Reminders go out on WhatsApp/.test(ws.say) && !/waba|telnyx|uuid/i.test(ws.say), 'the salon hears it in plain words: ' + ws.say);

// ── 8. Outside 24h → approved template only; inside → free text ──
const sms = await import(P + 'lib/sms.js');
const waClient = { id: 'wa-1', tenant_id: TID, first_name: 'Maya', name: 'Maya Chen', phone: '+13055551234', whatsapp_enabled: true };
T.clients.push(waClient);
let plan = await wa.planWhatsApp(db(), { tenantId: TID, clientId: 'wa-1', templateName: 'appointment_reminder', params: ['Maya', 'Blowout', 'MMA Salon', 'Tue 11:00 AM'] });
ok(plan && plan.type === 'WHATSAPP' && plan.template.name === 'appointment_reminder' && plan.template.template_id === 'tpl-appointment_reminder', 'no message from her in 24h → the approved template');
const tN = telnyx.length;
await sms.sendSms({ from: '+13055550100', to: '+13055551234', tenantId: TID, type: 'WHATSAPP', text: 'Reminder…', template: plan.template });
const tsend = telnyx.slice(tN).find((t) => t.path === '/messages/whatsapp');
ok(tsend && tsend.body.type === 'WHATSAPP' && tsend.body.whatsapp_message.type === 'template' && tsend.body.whatsapp_message.template.template_id === 'tpl-appointment_reminder' && tsend.body.whatsapp_message.template.components[0].type === 'body' && tsend.body.whatsapp_message.template.components[0].parameters.map((p) => p.text).join('|') === 'Maya|Blowout|MMA Salon|Tue 11:00 AM' && !('text' in tsend.body.whatsapp_message), 'the template goes out exactly as documented (POST /messages/whatsapp, type template)');
T.conversations.push({ id: 'cv-wa-1', tenant_id: TID, client_id: 'wa-1', channel: 'whatsapp' });
T.messages.push({ id: 'mm', conversation_id: 'cv-wa-1', tenant_id: TID, role: 'user', content: 'hi', created_at: new Date(now - 3600e3).toISOString() });
plan = await wa.planWhatsApp(db(), { tenantId: TID, clientId: 'wa-1', templateName: 'appointment_reminder', params: [] });
ok(plan && plan.type === 'WHATSAPP' && !plan.template, 'she wrote an hour ago → free text is allowed');
const old = await wa.planWhatsApp(db(), { tenantId: OTHER, clientId: 'nobody', templateName: 'nope', params: [] });
ok(old === null, 'no window and no approved template → it goes by SMS');
// The reminder engine end to end.
T.messages = T.messages.filter((m) => m.id !== 'mm');
T.services.push({ id: 'svc-b', tenant_id: TID, name: 'Blowout' });
T.bookings.push({ id: 'bk-wa', tenant_id: TID, client_id: 'wa-1', service_id: 'svc-b', status: 'confirmed', start_time: new Date(now + 24 * 3600e3).toISOString(), end_time: new Date(now + 25 * 3600e3).toISOString() });
T.booking_reminders = [];
const { runReminders } = await import(P + 'lib/booking-reminders.js');
const rem = []; await runReminders(new Date(), { send: async (m) => { rem.push(m); } });
const r24 = rem.find((m) => m.to === '+13055551234');
ok(r24 && r24.type === 'WHATSAPP' && r24.template?.name === 'appointment_reminder' && r24.template.params[0] === 'Maya' && r24.template.params[2] === 'MMA Salon', 'the 24h reminder to a WhatsApp client (outside the window) uses the approved template');

// ── 9. Lola's tools ──
const tools = await import(P + 'lib/setup/channel-tools.js');
const names = tools.SETUP_TOOLS.map((t) => t.function.name).sort().join(',');
ok(names === 'channels_status,choose_facebook_page,connect_facebook,connect_instagram,disconnect_channel,turn_on_whatsapp,whatsapp_status' && tools.SETUP_CONFIRM.has('disconnect_channel') && tools.SETUP_CONFIRM.size === 1, 'the seven channel tools, disconnect is confirm-gated');
const mma = T.tenants[0], glow = T.tenants[1];
let t = await tools.runSetupTool({ tenant: mma, name: 'connect_facebook', args: {} });
ok(t.ok && t.ui?.open === 'oauth' && /facebook\.com\/v21\.0\/dialog\/oauth/.test(t.ui.url) && fb.readState(new URL(t.ui.url).searchParams.get('state')) === TID && !/v21|oauth|token/i.test(t.say), 'connect_facebook → Lola opens Facebook’s sign-in for THIS salon: ' + t.say);
t = await tools.runSetupTool({ tenant: mma, name: 'connect_instagram', args: {} });
ok(t.ok && t.ui?.open === 'oauth' && /instagram\.com\/oauth\/authorize/.test(t.ui.url), 'connect_instagram → Instagram’s sign-in');
t = await tools.runSetupTool({ tenant: mma, name: 'disconnect_channel', args: { channel: 'facebook' } });
ok(t.ok && t.needs_confirmation && T.tenant_channels.find((x) => x.channel === 'messenger' && x.tenant_id === TID).status === 'active', 'disconnect without a yes only asks: ' + t.say);
t = await tools.runSetupTool({ tenant: mma, name: 'disconnect_channel', args: { channel: 'facebook', confirmed: true } });
ok(t.ok && !t.needs_confirmation && T.tenant_channels.find((x) => x.channel === 'messenger' && x.tenant_id === TID).status === 'disconnected' && T.tenant_channels.find((x) => x.account_id === 'PAGE-OTHER').status === 'active', 'after yes, MMA’s Messenger is off — Glow Spa’s untouched');
t = await tools.runSetupTool({ tenant: mma, name: 'channels_status', args: {} });
ok(t.ok && /Instagram is connected/.test(t.say) && /Messenger isn’t connected/.test(t.say) && /WhatsApp is on/.test(t.say), 'channels_status in plain words: ' + t.say);
// A salon whose number isn't on WhatsApp yet asks Lola.
T.tenants.push({ id: 'ten-3', name: 'Curl Bar', phone_number: '+13055557777' });
T.tenant_numbers.push({ tenant_id: 'ten-3', phone_number: '+13055557777', kind: 'primary', status: 'active' });
t = await tools.runSetupTool({ tenant: T.tenants[2], name: 'whatsapp_status', args: {} });
ok(/Ask LolaDesk to turn on WhatsApp for your number/.test(t.say) && t.suggestions.includes('Turn on WhatsApp'), 'WhatsApp off → ' + t.say);
t = await tools.runSetupTool({ tenant: T.tenants[2], name: 'turn_on_whatsapp', args: {} });
const req3 = T.tenant_channels.find((x) => x.channel === 'whatsapp_request' && x.tenant_id === 'ten-3');
ok(t.ok && req3?.status === 'pending' && /asked the LolaDesk team/.test(t.say) && !T.tenant_channels.some((x) => x.channel === 'whatsapp' && x.tenant_id === 'ten-3'), 'not on WhatsApp yet → a request the admin sees: ' + t.say);
WABA_NUMBERS.push({ phone_number: '+13055557777', number_id: '444', quality_rating: 'GREEN' });
t = await tools.runSetupTool({ tenant: T.tenants[2], name: 'turn_on_whatsapp', args: {} });
ok(t.ok && /WhatsApp is on/.test(t.say) && T.tenant_channels.find((x) => x.channel === 'whatsapp' && x.account_id === '+13055557777')?.tenant_id === 'ten-3' && T.tenant_channels.find((x) => x.channel === 'whatsapp_request' && x.tenant_id === 'ten-3').status === 'done', 'once the number is on the WABA, turning it on finishes automatically');
t = await tools.runSetupTool({ tenant: mma, name: 'no_such_tool', args: {} });
ok(t.ok === false && typeof t.say === 'string', 'unknown tools never throw');
t = await tools.runSetupTool({ tenant: null, name: 'channels_status' });
ok(t.ok === false && typeof t.say === 'string', 'no salon → a plain answer, no crash');

// ── 10. Endpoints ──
r = await run('channels.js', { method: 'GET', headers: { authorization: 'Bearer tok2' } });
ok(r.ok && r.messenger.on && /Glow Spa/.test(r.messenger.say) && /WhatsApp is on for \(786\)/.test(r.whatsapp.say) && !JSON.stringify(r).includes('PAGE-') && !JSON.stringify(r).includes('waba-uuid'), 'GET /api/channels: Glow Spa’s own channels, plain words, no IDs');
r = await run('channels.js', { method: 'POST', headers: { authorization: 'Bearer tok2' }, body: { action: 'disconnect', channel: 'messenger' } });
ok(r.needs_confirmation && T.tenant_channels.find((x) => x.account_id === 'PAGE-OTHER').status === 'active', 'POST disconnect without confirmed:true changes nothing');
r = await run('channels.js', { method: 'GET', headers: {} });
ok(r.status === 401, 'signed-out → 401');
r = await run('admin/channels.js', { method: 'GET', headers: { authorization: 'Bearer tok' } });
ok(r.status === 403, 'a salon owner can’t open the admin channels view');
T.tenant_channels.push({ tenant_id: 'ten-9', channel: 'whatsapp_request', account_id: 'ten-9', status: 'pending', meta: { phone_number: '+13055558888', requested_at: new Date().toISOString() } });
T.tenants.push({ id: 'ten-9', name: 'Nail Nook', phone_number: '+13055558888' });
r = await run('admin/channels.js', { method: 'GET', headers: { authorization: 'Bearer boss' } });
const glowRow = r.tenants?.find((x) => x.tenant.id === OTHER);
ok(r.ok && glowRow.messenger[0].page_id === 'PAGE-OTHER' && glowRow.whatsapp[0].waba_id === 'waba-uuid-1' && glowRow.whatsapp[0].templates.length === 3 && r.pending_whatsapp.some((p) => p.tenant.name === 'Nail Nook' && /embedded signup/.test(p.portal_step)), 'admin sees Page ids, WABA, template statuses and pending requests with the exact portal step');

// ── 11. UI ──
const fsx = await import('node:fs');
const settings = fsx.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
ok(/id="igCard"/.test(settings) && /id="fbCard"/.test(settings) && /Lola on Facebook Messenger/.test(settings) && /\/api\/messenger\?action=connect/.test(settings), 'Settings has the Facebook Messenger card next to Instagram (Instagram kept)');
const icc = fsx.readFileSync(new URL('../../integration-command-center.js', import.meta.url), 'utf8');
ok(/turn_on_whatsapp/.test(icc) && /\/api\/channels/.test(icc), 'the WhatsApp “Connect” button runs the real flow');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
