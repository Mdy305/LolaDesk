// Lola sounds like a person on every surface, and the owner reaches LolaDesk support through her:
// "tell support …" → previewed → sent on yes → in the Console; the team's answer comes back in her brief
// and in the Contact support window.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-33333333-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ── 1. humanize: filler out, facts untouched ──
const { humanize, humanCraft, HUMAN_MARK, HUMAN_RULES } = await import(new URL('../../api/lib/human-touch.js', import.meta.url).href);
ok(humanize('Certainly! You have **3 clients** today — $450 locked in. Is there anything else I can help you with?', { channel: 'sms' }) === 'You have 3 clients today — $450 locked in.', 'bot openers, markdown and "anything else?" are gone; the numbers stay');
ok(humanize('Great question! As an AI, I can’t feel, but here’s the deal: Tuesday is slow!!! Want me to text the waitlist?') === 'Here’s the deal: Tuesday is slow! Want me to text the waitlist?', '"As an AI…" disclaimers and exclamation storms are cleaned');
ok(humanize('I apologize for any inconvenience. Maria is booked at 2:30 PM with Ana.') === 'Maria is booked at 2:30 PM with Ana.', 'corporate apologies go, the booking facts stay word for word');
ok(humanize('- Balayage $250\n- Gloss $60') === '- Balayage $250\n- Gloss $60' && humanize('- Balayage $250\n- Gloss $60', { channel: 'voice' }) === 'Balayage $250 Gloss $60', 'lists survive in the app, are spoken plainly on a call');
ok(humanize('Book here: https://www.mmasalon.com/book?x=1. See you Friday!') === 'Book here: https://www.mmasalon.com/book?x=1. See you Friday!', 'links are never touched');
ok(humanize('Absolutely!') === 'Absolutely!', 'a reply that is only a word keeps its word');
ok(/one question at a time/i.test(humanCraft({ audience: 'owner', channel: 'voice' })) && /contact_support/.test(humanCraft({ audience: 'owner' })), 'the owner craft teaches the rhythm and when to call LolaDesk support');

// ── 2. the phone + website Lola gets the human rules once ──
const posts = [];
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); posts.push(b); const { tools, ...rest } = b; Object.assign(asst, rest); }
    return J({ data: { ...asst, tools: [] } });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  if (u.includes('/ai/tools')) return J({ data: [] });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'ready' } }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const { wireAssistant } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
await wireAssistant({ heal: true });
const instr = String(asst.instructions || '');
ok(instr.includes(HUMAN_MARK) && instr.includes('one thought at a time') && instr.startsWith('You are Lola.'), 'her phone/website instructions gain the human rules, her own words kept');
const n = posts.length; await wireAssistant({ heal: true });
ok(instr.split(HUMAN_MARK).length === 2 && !posts.slice(n).some((p) => String(p.instructions || '').split(HUMAN_MARK).length > 2), 'added once, never twice');
ok(HUMAN_RULES.includes('AI assistant'), 'she still says she is an AI when asked');

// ── 3. support through Lola ──
const TID = '66666666-6666-4666-8666-666666666666';
T.tenants = [{ id: TID, name: 'MMA Salon', owner_name: 'Meddy Jerome', owner_email: 'owner@mmasalon.com', owner_phone: '+13053227442' }];
T.support_tickets = []; T.client_memories = [];
const { routeOwnerIntent } = await import(new URL('../../api/lib/owner-intents.js', import.meta.url).href);
const { runOwnerTool, takePendingAction, supportFollowUp, SUPPORT_ASK } = await import(new URL('../../api/lib/owner-tools.js', import.meta.url).href);
const tenant = T.tenants[0];

const hit = routeOwnerIntent('Lola, tell support that texts are not going out to clients');
ok(hit?.tool === 'contact_support' && hit.args.message === 'texts are not going out to clients', '"tell support that …" is understood instantly');
ok(routeOwnerIntent('text Maria I am running late')?.tool === 'text_client', 'texting a client still texts the client');
ok(routeOwnerIntent('did support answer?')?.tool === 'support_status' && routeOwnerIntent('my tickets')?.tool === 'support_status', '"did support answer?" reads the requests');

const prev = await runOwnerTool({ tenant, name: hit.tool, args: hit.args });
ok(prev.needs_confirmation && /texts are not going out/.test(prev.say) && T.support_tickets.length === 0, 'she previews the request and sends nothing yet');
const sent = await takePendingAction({ tenant, text: 'yes' });
const tk = T.support_tickets[0];
ok(sent?.ok && T.support_tickets.length === 1 && tk.tenant_id === TID && tk.channel === 'lola_in_app' && /texts are not going out/.test(tk.issue), 'on yes it lands in the Console with the salon attached');
ok(tk.email === 'owner@mmasalon.com' && tk.phone === '+13053227442' && tk.business === 'MMA Salon', 'the team can answer by text or email');
ok(/ticket [A-Z0-9]{6}/.test(sent.say) && /tell you here the moment they do/.test(sent.say), 'she gives the ticket number and promises to bring back the answer');

const ask = await runOwnerTool({ tenant, name: 'contact_support', args: { message: '' } });
ok(ask.say === SUPPORT_ASK, '"contact support" with no detail: she asks what is going on');
const follow = supportFollowUp([{ role: 'user', content: 'contact support' }, { role: 'assistant', content: SUPPORT_ASK }, { role: 'user', content: 'the calendar shows Ana twice on Friday' }], 'the calendar shows Ana twice on Friday');
ok(follow?.tool === 'contact_support' && follow.args.message === 'the calendar shows Ana twice on Friday', 'and the next thing the owner says becomes the request');
ok(supportFollowUp([{ role: 'assistant', content: SUPPORT_ASK }, { role: 'user', content: 'yes' }], 'yes') === null, 'a bare yes after the question is not a request');

const st = await runOwnerTool({ tenant, name: 'support_status', args: {} });
ok(/waiting for the team/.test(st.say) && /texts are not going out/.test(st.say), 'status: waiting for the team, in plain words');

// The team answers from the Console …
tk.replies = [{ at: new Date(Date.now() + 1000).toISOString(), by: 'm@loladesk.com', via: 'sms', text: 'Your texting registration is pending carrier review — texts start the day it is approved.' }];
tk.status = 'in_progress';
const sd = await import(new URL('../../api/lib/support-desk.js', import.meta.url).href);
const { db } = await import(new URL('../../api/lib/db.js', import.meta.url).href);
const line = await sd.supportBriefLine(db(), tenant, { owner: tenant.owner_name });
ok(line && line.startsWith('Meddy, LolaDesk support answered') && /pending carrier review/.test(line), '… and Lola brings the answer to the owner by name');
await new Promise((r) => setTimeout(r, 1100));
await sd.markSupportSeen(db(), TID);
ok(!(await sd.supportBriefLine(db(), tenant, {})), 'once heard, she does not repeat it');
const st2 = await runOwnerTool({ tenant, name: 'support_status', args: {} });
ok(/The team answered/.test(st2.say) && /pending carrier review/.test(st2.say), 'status shows the team’s latest answer');

// Another salon never sees it.
T.tenants.push({ id: 'other', name: 'Other Salon' });
ok((await sd.ticketsFor(db(), 'other')).length === 0, 'tickets are per salon');

// Rate cap: a flood is held politely.
for (let i = 0; i < 5; i++) T.support_tickets.push({ id: 'x' + i, tenant_id: TID, issue: 'x', created_at: new Date().toISOString() });
const capped = await sd.openSupportTicket(db(), tenant, { message: 'again', diagnose: false });
ok(capped.limited && T.support_tickets.length === 6, 'more than five in an hour: held, with a kind word');

console.log(fails ? `\n${fails} FAILED` : '\nall human checks pass');
process.exit(fails ? 1 : 0);
