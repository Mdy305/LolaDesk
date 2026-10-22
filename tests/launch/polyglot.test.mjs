// Lola speaks English, Spanish, French and Russian; every website/phone conversation that didn't end in a
// booking reaches the owner (Needs you + text/email with the transcript link); what she didn't know becomes
// one sentence the owner teaches her — and from then on every channel answers it.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.SENDGRID_API_KEY = 'sg-test'; process.env.EMAIL_FROM = 'lola@loladesk.com'; process.env.APP_URL = 'https://www.loladesk.com';
const BRAIN = 'assistant-55555555-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; delete process.env.LOLA_STT_LANGUAGE;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const mails = [], sttForms = [], texts = [];
let refuseMulti = false;
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', model: 'zai-org/GLM-5.3-Flash', instructions: 'You are Lola.',
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  voice_settings: { voice: 'Telnyx.Ultra.81eeddd4-4185-4ffa-81b9-2cf690fa16c7', expressive_mode: true },
  transcription: { model: 'deepgram/flux', language: 'en', settings: { eot_threshold: 0.7, eot_timeout_ms: 5000, eager_eot_threshold: 0.4 } },
  interruption_settings: { enable: true, disable_greeting_interruption: true, start_speaking_plan: { wait_seconds: 0.3 } },
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  if (u.includes('/ai/audio/transcriptions') || u.includes('/speech-to-text')) { sttForms.push(init.body); return J({ text: 'Bonjour Lola, qu’est-ce que j’ai demain ?' }); }
  if (u.endsWith('/v2/messages')) { texts.push(JSON.parse(init.body)); return J({ data: { id: 'msg-' + texts.length } }); }
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if (refuseMulti && b.transcription?.language === 'multi') return J({ errors: [{ detail: 'transcription.language: unsupported value' }] }, 422);
      const { tools, ...rest } = b; Object.assign(asst, rest);
    }
    return J({ data: { ...asst, tools: [] } });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  if (u.includes('/ai/tools')) return J({ data: [] });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'Do you do keratin treatments on Sundays?' } }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;

// ── 1. Four languages on the phone and the website ──
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');
await wireAssistant({ heal: true });
ok(asst.transcription.language === 'multi' && asst.transcription.settings.eot_threshold === 0.7, 'Flux hears English, Spanish, French and Russian (language "multi"), the owner’s timing kept');
const { HUMAN_RULES, humanCraft } = await import(P + 'lib/human-touch.js');
ok(/English, Spanish, French, Russian/.test(HUMAN_RULES) && /switch the moment they switch/.test(HUMAN_RULES) && String(asst.instructions).includes('switch the moment they switch'), 'her phone/website rules: answer in their language, switch when they switch');
ok(/Spanish, French, Russian/.test(humanCraft({ audience: 'client', channel: 'sms' })) && /Spanish, French, Russian/.test(humanCraft({ audience: 'owner' })), 'same in texts, DMs, website chat and with the owner');
asst.transcription = { model: 'deepgram/flux', language: 'en', settings: { eot_threshold: 0.7, eot_timeout_ms: 5000, eager_eot_threshold: 0.4 } };
refuseMulti = true;
await wireAssistant({ heal: true });
ok(asst.transcription.language === 'auto', 'if Telnyx refuses "multi", Flux’s automatic language detection is used instead');
refuseMulti = false;

// ── 2. The app hears any language (no English pinned) ──
const { transcribeAudio } = await import(P + 'lola/hear.js');
const heard = await transcribeAudio(Buffer.alloc(2000, 1), 'audio/webm');
const form = sttForms.at(-1);
ok(heard.ok && /Bonjour/.test(heard.text) && form && typeof form.get === 'function' && !form.get('language'), 'talking to Lola in the app: French is heard as French (no language pinned)');

// ── 3. Every conversation that didn't end in a booking reaches the owner ──
const TID = '99999999-9999-4999-8999-999999999999';
T.tenants = [{ id: TID, name: 'MMA Salon', owner_email: 'owner@mmasalon.com', owner_phone: '+13053227442' }];
for (const k of ['calls', 'usage_events', 'clients', 'booking_settings', 'client_memories']) T[k] = [];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
const cr = await import(P + 'lib/conversation-report.js');
const { db } = await import(P + 'lib/db.js');
ok(cr.contactFromWords([{ role: 'user', content: 'Soy Ana, mi número es 305-555-1212 y mi correo ana@gmail.com' }]).phone === '3055551212' && cr.contactFromWords([{ role: 'user', content: 'ana@gmail.com' }]).email === 'ana@gmail.com', 'a number or email said out loud (any language) is captured');
const web = [
  { role: 'assistant', content: 'Hi! I’m Lola at MMA Salon. How can I help?' },
  { role: 'user', content: '¿Hacen balayage? Me llamo Ana, mi número es 305-555-1212' },
  { role: 'assistant', content: '¡Claro! El balayage empieza en $250. ¿Qué día te viene bien?' },
  { role: 'user', content: 'Lo pienso y te escribo' },
];
mails.length = 0;
const r1 = await cr.reportConversation(db(), T.tenants[0], { turns: web, summary: 'Ana asked about balayage ($250) and will decide later (in Spanish).', booked: false, key: 'conv:w1', channel: 'web', who: '' });
const lead = T.usage_events.find((e) => e.kind === 'lead');
ok(r1.lead && lead && lead.metadata.phone === '+13055551212' && /balayage/.test(lead.metadata.message) && lead.metadata.channel === 'website', 'a website chat that didn’t book becomes a lead (Ana, her number, what she wanted)');
const tmail = mails.find((m) => /calls\?id=/.test(JSON.stringify(m)) && /balayage/.test(JSON.stringify(m)));
ok(tmail && mails.length === 1, 'the owner gets ONE email: the summary, the full transcript and a link to it (no duplicate alert)');
const alertTxt = texts.find((t) => /Transcript: https:\/\/www\.loladesk\.com\/calls\?id=/.test(t.text || ''));
ok(alertTxt && alertTxt.to === '+13053227442', 'and a text to the owner’s phone with the summary + transcript link (delivered once 10DLC is approved)');
ok(T.calls.some((c) => c.insight_id === 'conv:w1' && /balayage/.test(c.recording_url || '')), 'and the whole transcript is on the Calls screen');
mails.length = 0;
const n = T.usage_events.filter((e) => e.kind === 'lead').length;
await cr.reportConversation(db(), T.tenants[0], { turns: web, summary: 'Ana again.', booked: false, key: 'conv:w2', channel: 'web' });
ok(T.usage_events.filter((e) => e.kind === 'lead').length === n, 'the same person again within hours: no second alert');
await cr.reportConversation(db(), T.tenants[0], { turns: web, summary: 'Booked.', booked: true, key: 'conv:w3', channel: 'web' });
ok(T.usage_events.filter((e) => e.kind === 'lead').length === n, 'a booked conversation is on the calendar — no lead');
await cr.reportConversation(db(), T.tenants[0], { turns: [{ role: 'assistant', content: 'Hi!' }, { role: 'user', content: 'hi' }], summary: 'Said hi.', booked: false, key: 'conv:w4', channel: 'web' });
ok(T.usage_events.filter((e) => e.kind === 'lead').length === n, 'a one-word hello is not a lead');

// ── 4. What she didn't know → the owner teaches her → every channel knows ──
const kg = await import(P + 'lib/knowledge-gaps.js');
const fr = [
  { role: 'user', content: 'Vous faites la kératine le dimanche ?' },
  { role: 'assistant', content: 'Je ne sais pas, je vais demander au salon de vous recontacter.' },
];
const noted = await kg.noteGaps(db(), T.tenants[0], fr, { callId: 'c1' });
ok(noted.length === 1 && /keratin/i.test(noted[0]), 'a question she couldn’t answer (in French) is noted in English: ' + noted[0]);
const again = await kg.noteGaps(db(), T.tenants[0], fr, { callId: 'c2' });
ok(again.length === 0, 'asked again: noted once');
const open = await kg.openGaps(db(), T.tenants[0].id);
ok(open.length === 1 && /didn't know/.test(kg.gapsBriefLine(open)), 'her briefing: "Clients asked me something I didn’t know… tell me the answer"');
const { runOwnerTool } = await import(P + 'lib/owner-tools.js');
const { routeOwnerIntent } = await import(P + 'lib/owner-intents.js');
ok(routeOwnerIntent('what did clients ask you?')?.tool === 'open_questions', '"What did clients ask you?" lists them');
const taught = await runOwnerTool({ tenant: T.tenants[0], name: 'teach_lola', args: { answer: 'Yes — keratin on Sundays, $300, book 3 hours.' } });
ok(taught.ok && /keratin/i.test(taught.question) && /\$300/.test(taught.say), 'the owner answers in one sentence: ' + taught.say);
const { tenantKnowledgePrompt } = await import(P + 'lib/db.js');
const fresh = T.tenants[0];
ok(/keratin/i.test(tenantKnowledgePrompt(fresh)) && /\$300/.test(tenantKnowledgePrompt(fresh)), 'from now on it’s in what every channel reads (phone, website, texts, DMs)');
ok((await kg.openGaps(db(), TID)).length === 0, 'and the question is closed');

console.log(fails ? `\n${fails} FAILED` : '\nall polyglot checks pass');
process.exit(fails ? 1 : 0);
