/**
 * GET /api/status — "why isn't it working?" in one call, safe to open publicly.
 * Only yes/no answers and plain-language fixes: never a key, number or secret.
 *   release   which LolaDesk update is live (so we know the deploy landed)
 *   settings  each required Vercel variable: set or missing
 *   live      real probes: database, Telnyx key, Telnyx AI brain, salon numbers' texting registration (10DLC),
 *             Lola's voice in the app (a real 'Hi' synthesized), her phone voice, salon numbers ringing Lola
 *   healed    what LolaDesk just repaired by itself (phone voice, numbers not ringing Lola) — at most every 10 min
 *   fixes     what to do, in order
 * Cached 60s per instance.
 */
import { db } from './lib/db.js';

export const RELEASE = 'lola-keypad';
let lastHeal = 0;
let lastLineHeal = 0;
// 0.6s of quiet 16kHz audio: enough for speech-to-text to prove it answers.
function silentWav() {
  const n = 9600, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 7) * 30), 44 + i * 2);
  return b;
}
const clip = (e) => String(e?.message || e || '').replace(/Bearer\s+\S+/g, '').slice(0, 140);
let cache = null;

const has = (...k) => k.some((x) => !!String(process.env[x] || '').trim());
async function tget(path, timeoutMs = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.telnyx.com/v2' + path, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 0, error: String(e?.name === 'AbortError' ? 'timeout' : e?.message || e) }; }
  finally { clearTimeout(t); }
}

export async function buildStatus() {
  const settings = {
    TELNYX_API_KEY: has('TELNYX_API_KEY'),
    TELNYX_ASSISTANT: has('TELNYX_LOLA_BRAIN_ID', 'TELNYX_ASSISTANT_ID'),
    TELNYX_VOICE_APP_ID: has('TELNYX_VOICE_APP_ID'),
    TELNYX_PUBLIC_KEY: has('TELNYX_PUBLIC_KEY'),
    SUPABASE: has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    CRON_SECRET: has('CRON_SECRET'),
    ADMIN_EMAILS: has('ADMIN_EMAILS'),
    INTEGRATION_ENCRYPTION_KEY: has('INTEGRATION_ENCRYPTION_KEY'),
    STRIPE_SECRET_KEY: has('STRIPE_SECRET_KEY'),
    GOOGLE_PLACES_API_KEY: has('GOOGLE_PLACES_API_KEY'),
  };
  const live = {};
  const fixes = [];
  // Database
  try { const c = db(); const { error } = c ? await c.from('tenants').select('id').limit(1) : { error: { message: 'not configured' } }; live.database = !error; } catch (_) { live.database = false; }
  // Telnyx key + AI brain
  if (settings.TELNYX_API_KEY) {
    const bal = await tget('/balance');
    live.telnyx_key = bal.ok;
    if (bal.ok) live.telnyx_balance_ok = Number(bal.j?.data?.available_credit ?? bal.j?.data?.balance ?? 1) > 0;
    let models = await tget('/ai/openai/models');            // documented (GET /ai/models is deprecated)
    if (!models.ok || !(models.j?.data || []).length) models = await tget('/ai/models');
    const ids = (models.j?.data || []).map((m) => m.id || m.name).filter(Boolean);
    live.telnyx_ai = models.ok && ids.length > 0;
    live.fast_model = ids.some((x) => /Llama-3\.3-70B/i.test(x));
    // Her brain and her ears, for real: one tiny thought, one tiny transcription (the exact paths the app uses).
    if (live.telnyx_key) {
      const [brain, ears] = await Promise.all([
        (async () => { try { const { chat } = await import('./lib/llm.js'); const r = await chat({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 20, temperature: 0, deadlineMs: 12000 }); return r.ok && r.text ? { ok: true, model: r.model } : { ok: false, error: clip(r.error || 'empty answer') }; } catch (e) { return { ok: false, error: clip(e) }; } })(),
        (async () => { try { const { transcribeAudio } = await import('./lola/hear.js'); const r = await transcribeAudio(silentWav(), 'audio/wav', { deadline: Date.now() + 12000 }); return r.ok ? { ok: true, model: r.model } : { ok: false, error: clip(r.detail || r.error) }; } catch (e) { return { ok: false, error: clip(e) }; } })(),
      ]);
      live.brain = brain.ok; if (brain.ok) live.brain_model = brain.model; else live.brain_error = brain.error;
      live.hearing = ears.ok; if (ears.ok) live.hearing_model = ears.model; else live.hearing_error = ears.error;
    }
    // Texting registration (10DLC) for every number on the account
    const nums = await tget('/phone_numbers?page[size]=100');
    const list = (nums.j?.data || []).map((n) => n.phone_number).filter(Boolean);
    live.numbers = list.length;
    // Documented paging: page + recordsPerPage; only ASSIGNED numbers can text (pending/failed can't).
    const reg = await tget('/10dlc/phone_number_campaigns?recordsPerPage=500&page=1');
    if (reg.ok) {
      const recs = Array.isArray(reg.j?.records) ? reg.j.records : Array.isArray(reg.j?.data?.records) ? reg.j.data.records : Array.isArray(reg.j?.data) ? reg.j.data : [];
      const registered = new Set(recs.filter((r) => !r.assignmentStatus || r.assignmentStatus === 'ASSIGNED').map((r) => r.phoneNumber || r.phone_number).filter(Boolean));
      live.numbers_pending_10dlc = recs.filter((r) => r.assignmentStatus === 'PENDING_ASSIGNMENT').length;
      live.numbers_registered_10dlc = list.filter((n) => registered.has(n)).length;
    } else live.numbers_registered_10dlc = null;
  }
  // ── Her ONE voice: the valet-girl Lola from ElevenLabs, in the app and on the phone ──
  const healed = [];
  const vfix = [];
  const optedOut = process.env.VOICE_PROVIDER === 'telnyx';
  live.voice_key = has('ELEVENLABS_API_KEY'); live.voice_id = has('ELEVENLABS_VOICE_ID', 'LOLA_VOICE_ID');
  {
    const el = await import('./lib/elevenlabs.js');
    if (live.voice_key && !optedOut) {
      try { const s = await el.getUserSubscription({ timeoutMs: 6000 }); live.elevenlabs = s.quotaExhausted ? 'out_of_credit' : 'ok'; if (s.characterLimit) live.elevenlabs_left_pct = Math.round(100 * (s.remaining || 0) / s.characterLimit); }
      catch (e) { live.elevenlabs = /\b(401|403)\b/.test(String(e?.message)) ? 'key_refused' : 'unreachable'; }
    }
    // In the app: a real two-letter sentence, the exact path the app uses.
    if ((live.voice_key && live.voice_id) || optedOut) {
      try {
        const buf = await Promise.race([el.synthesize('Hi'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
        live.voice_app = !!(buf && buf.length > 200);
        if (!live.voice_app) live.voice_app_error = 'empty audio';
      } catch (e) { live.voice_app = false; live.voice_app_error = clip(e); }
    } else live.voice_app = false;
  }
  // Live conversation in the app (the Railway relay): reachable, configured, same secret.
  const relayUrl = String(process.env.LOLA_VOICE_RELAY_URL || '').trim();
  if (relayUrl) {
    live.voice_relay_secret = has('LOLA_VOICE_SECRET');
    try {
      const h = relayUrl.replace(/^ws/i, 'http').replace(/\/api\/voice-relay\/?$/, '').replace(/\/+$/, '') + '/health';
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 6000);
      const r = await fetch(h, { signal: ac.signal }).finally(() => clearTimeout(tm));
      const j = await r.json().catch(() => ({}));
      live.voice_relay = r.ok && j.ok === true;
      if (!live.voice_relay) live.voice_relay_error = j.ok === false ? `relay is missing ${['telnyx_key', 'secret', 'assistant'].filter((k) => j[k] === false).join(', ') || 'settings'}` : `HTTP ${r.status}`;
    } catch (e) { live.voice_relay = false; live.voice_relay_error = clip(e?.name === 'AbortError' ? 'no answer in 6s' : e); }
  }
  // Which line answers salon calls: LolaDesk's own (default — Lola's brain, tools and ElevenLabs voice
  // run in LolaDesk) or the Telnyx AI assistant. Numbers are checked and healed against that line.
  let phoneMode = 'loladesk';
  try { const pv = await import('./lib/telnyx-provision.js'); phoneMode = await pv.phoneMode(); } catch (_) {}
  live.phone_line = phoneMode === 'assistant' ? 'telnyx_assistant' : 'loladesk';
  // On the phone: every assistant speaks with her voice; the greeting is set; the salon numbers ring her.
  if (settings.TELNYX_API_KEY) {
    // Which assistant IS Lola: the Vercel id if Telnyx knows it, otherwise found on the account.
    const { resolveAssistant } = await import('./lib/assistant-wiring.js');
    const found = await resolveAssistant({ force: true }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    const a = found.assistant || null;
    live.assistant = !!(found.ok && a?.id);
    live.assistant_source = found.source || null;
    if (found.ok && found.source !== 'env') { live.assistant_id = found.id; live.assistant_name = found.name; live.assistant_env_id_ok = false; }
    if (!found.ok && found.error === 'no_assistant_on_account') live.assistant_missing = true;
    if (live.assistant) {
      const ov = await import('./lib/one-voice.js');
      const voices = await ov.unifyAssistantVoices({ heal: false });
      live.phone_assistants = voices.total;
      live.phone_assistants_in_lola_voice = voices.lola;
      live.phone_greeting = !!String(a.greeting || '').trim();
      const brainApp = a.telephony_settings?.default_texml_app_id || null;
      const good = new Set([brainApp, process.env.TELNYX_VOICE_APP_ID].filter(Boolean));
      const salon = new Set();
      try { const c = db(); const [{ data: tn }, { data: tt }] = await Promise.all([c.from('tenant_numbers').select('phone_number,status').limit(1000), c.from('tenants').select('phone_number').limit(1000)]);
        for (const r of tn || []) if (r.phone_number && r.status !== 'released') salon.add(r.phone_number);
        for (const r of tt || []) if (r.phone_number) salon.add(r.phone_number); } catch (_) {}
      const nums = await tget('/phone_numbers?page[size]=250');
      const onAcct = (nums.j?.data || []).filter((n) => salon.has(n.phone_number));
      if (phoneMode === 'assistant') {
        live.salon_numbers = onAcct.length;
        live.salon_numbers_ringing_lola = onAcct.filter((n) => good.has(n.connection_id)).length;
      }
      // Self-repair, at most every 10 minutes per server.
      const voiceOff = voices.possible && voices.lola < voices.total;
      // Her wiring as Telnyx documents it: signed tools, signed salon-details webhook, website calls allowed.
      const { diagnoseTool, toolUrl } = await import('./lib/assistant-wiring.js');
      const { toolKeyOk } = await import('./lib/tool-key.js');
      const unsignedTools = (Array.isArray(a.tools) ? a.tools : []).filter((t) => { const d = diagnoseTool(t); return d && d.fixable; }).length;
      const { dedupeTools, sharedToolCollisions } = await import('./lib/assistant-wiring.js');
      const dups = dedupeTools(a.tools).removed;
      try { const sh = await sharedToolCollisions(a, a.tools); if (sh) dups.push(...sh.detached.map((n) => n + ' (shared copy)')); } catch (_) {}
      if (dups.length) live.duplicate_tools = dups;
      let varsSigned = false; try { varsSigned = toolKeyOk(new URL(String(a.dynamic_variables_webhook_url || '')).searchParams.get('k'), 'variables'); } catch (_) {}
      live.phone_tools_ok = unsignedTools === 0;
      live.salon_details_ok = varsSigned;
      live.website_calls = a.telephony_settings?.supports_unauthenticated_web_calls === true;
      // Booking honesty: she collects first + last name, mobile and email, and never says "booked" unless it is.
      const { BOOKING_MARK } = await import('./lib/assistant-wiring.js');
      const bookTool = (Array.isArray(a.tools) ? a.tools : []).find((t) => /^book_appointment$/i.test(String(t?.webhook?.name || '')));
      const bookProps = bookTool?.webhook?.body_parameters?.properties || {};
      live.booking_rules = String(a.instructions || '').includes(BOOKING_MARK) || !a.instructions;
      live.booking_asks_details = !bookTool || !!(bookProps.client_email && bookProps.client_phone && bookProps.client_name);
      const wiringOff = unsignedTools > 0 || dups.length > 0 || !varsSigned || !live.website_calls || !live.booking_rules || !live.booking_asks_details;
      const rewire = found.source !== 'env' || wiringOff;   // a different assistant than Vercel's id, or wiring that drifted: re-wire
      // A stored default Telnyx can't accept (booking_url: null) blocks every save of the assistant.
      const dvRaw = (a.dynamic_variables && typeof a.dynamic_variables === 'object') ? a.dynamic_variables : {};
      const dvBad = Object.keys(dvRaw).filter((k) => { const v = dvRaw[k]; return v == null || typeof v === 'object' || (typeof v === 'number' && !Number.isInteger(v)); });
      if (dvBad.length) live.assistant_bad_values = dvBad;
      const needs = rewire || dvBad.length > 0 || voiceOff || !live.phone_greeting || (phoneMode === 'assistant' && live.salon_numbers_ringing_lola < live.salon_numbers);
      if (needs && Date.now() - lastHeal > 10 * 60e3) {
        lastHeal = Date.now();
        if (dvBad.length) {
          try { const { wireAssistant } = await import('./lib/assistant-wiring.js'); const w = await wireAssistant({ heal: true }); if (w.healed && !w.error) { healed.push(`Lola’s phone settings cleaned (${dvBad.join(', ')} had an empty value Telnyx refuses).`); delete live.assistant_bad_values; } } catch (_) {}
        }
        if (voiceOff) {
          const u = await ov.unifyAssistantVoices({ heal: true });
          if (u.fixed.length) healed.push(`${u.fixed.length} phone assistant${u.fixed.length > 1 ? 's now speak' : ' now speaks'} in Lola’s own voice (was: ${[...new Set(u.fixed.map((f) => f.from))].join(', ')}).`);
          if (u.errors.length) live.phone_voice_error = clip(u.errors[0]);
          live.phone_assistants_in_lola_voice = u.lola;
        }
        if (!live.phone_greeting || rewire) {
          try {
            const { wireAssistant } = await import('./lib/assistant-wiring.js'); const w = await wireAssistant({ heal: true });
            if (w.healed && w.disclosure?.greeting_set_to) { healed.push('Phone greeting restored.'); live.phone_greeting = true; }
            if (w.healed && !w.error && dups.length) { healed.push(`Removed ${dups.length} duplicate tool${dups.length > 1 ? 's' : ''} from Lola’s Telnyx assistant (${dups.slice(0, 4).join(', ')}) — Telnyx accepts changes to her again.`); delete live.duplicate_tools; }
            if (w.healed && !w.error && (!live.booking_rules || !live.booking_asks_details)) { healed.push('Lola now asks every client for first and last name, mobile and email before booking — and only says “booked” when it really is.'); live.booking_rules = true; live.booking_asks_details = true; }
            if (w.healed && !w.error && wiringOff) {
              const secured = [unsignedTools ? `${unsignedTools} tool${unsignedTools > 1 ? 's' : ''} signed` : '', !varsSigned ? 'salon details signed' : '', !live.website_calls ? 'salon websites can now talk to her' : ''].filter(Boolean);
              if (secured.length) healed.push(`Lola’s phone wiring secured: ${secured.join(', ')}.`);
              live.phone_tools_ok = true; live.salon_details_ok = true; live.website_calls = w.web_calls !== false;
            }
            if (w.web_calls_error) { live.website_calls = false; live.website_calls_error = clip(w.web_calls_error); }
            if (w.error) {
              live.wiring_error = clip(w.error);
              // Still refused for duplicate names: show exactly what Telnyx holds, so it can be fixed in one look.
              if (/unique/i.test(String(w.error))) live.tools_inventory = { inline: (Array.isArray(a.tools) ? a.tools : []).map((t) => t?.webhook?.name || t?.function?.name || t?.type).filter(Boolean), shared_ids: Array.isArray(a.tool_ids) ? a.tool_ids : [] };
            }
          } catch (_) {}
        }
        if (phoneMode === 'assistant' && live.salon_numbers_ringing_lola < live.salon_numbers) {
          // Point every salon number that doesn't reach Lola (no connection, or a dead/other one) at her phone app.
          let n = 0;
          if (brainApp) {
            const { telnyxRequest } = await import('./lib/telnyx-client.js');
            for (const num of onAcct.filter((x) => !good.has(x.connection_id) && x.id)) {
              try { const r = await telnyxRequest(`/phone_numbers/${encodeURIComponent(num.id)}`, { method: 'PATCH', body: { connection_id: brainApp }, timeoutMs: 8000 }); const got = r?.data?.connection_id ?? r?.connection_id; if (!got || got === brainApp) n++; }
              catch (e) { live.numbers_heal_error = clip(e); }
            }
          } else {
            try { const { wireTenantNumbers } = await import('./lib/tenant-wiring.js'); const r = await wireTenantNumbers(db(), { heal: true }); n = (r.numbers || []).filter((x) => x.healed.includes('calls')).length; } catch (_) {}
          }
          if (n) { healed.push(`${n} salon number${n > 1 ? 's now ring' : ' now rings'} Lola.`); live.salon_numbers_ringing_lola = Math.min(live.salon_numbers, live.salon_numbers_ringing_lola + n); }
        }
      }
    }
  }
  // LolaDesk's own call line (default): the line exists and points here, the voice cache works,
  // and every salon number rings it — repaired by itself at most every 10 minutes.
  if (settings.TELNYX_API_KEY && phoneMode === 'loladesk' && live.telnyx_key !== false) {
    try {
      const pv = await import('./lib/telnyx-provision.js');
      const lineApp = await pv.getLolaDeskVoiceAppId().catch(() => null);
      live.phone_line_ready = !!lineApp;
      const salon = new Set();
      try { const c = db(); const [{ data: tn }, { data: tt }] = await Promise.all([c.from('tenant_numbers').select('phone_number,status').limit(1000), c.from('tenants').select('phone_number').limit(1000)]);
        for (const r of tn || []) if (r.phone_number && r.status !== 'released') salon.add(r.phone_number);
        for (const r of tt || []) if (r.phone_number) salon.add(r.phone_number); } catch (_) {}
      const nums = await tget('/phone_numbers?page[size]=250');
      const onAcct = (nums.j?.data || []).filter((n) => salon.has(n.phone_number));
      live.salon_numbers = onAcct.length;
      live.salon_numbers_ringing_lola = lineApp ? onAcct.filter((n) => n.connection_id === lineApp).length : 0;
      // Her phone voice is cached in Supabase Storage ('voice-audio', public): make sure the bucket is there.
      try {
        const c = db();
        const { data: bucket } = await c.storage.getBucket('voice-audio');
        if (!bucket) { const { error } = await c.storage.createBucket('voice-audio', { public: true }); live.phone_voice_cache = !error; if (!error) healed.push('Lola’s phone-voice storage created.'); }
        else { live.phone_voice_cache = true; if (bucket.public === false) { const { error } = await c.storage.updateBucket('voice-audio', { public: true }); if (!error) healed.push('Lola’s phone-voice storage made playable for calls.'); else live.phone_voice_cache = false; } }
      } catch (_) { live.phone_voice_cache = false; }
      if (lineApp && live.salon_numbers_ringing_lola < live.salon_numbers && Date.now() - lastLineHeal > 10 * 60e3) {
        lastLineHeal = Date.now();
        let n = 0;
        const { telnyxRequest } = await import('./lib/telnyx-client.js');
        for (const num of onAcct.filter((x) => x.connection_id !== lineApp && x.id)) {
          try { const r = await telnyxRequest(`/phone_numbers/${encodeURIComponent(num.id)}`, { method: 'PATCH', body: { connection_id: lineApp }, timeoutMs: 8000 }); const got = r?.data?.connection_id ?? r?.connection_id; if (!got || got === lineApp) n++; }
          catch (e) { live.numbers_heal_error = clip(e); }
        }
        if (n) { healed.push(`${n} salon number${n > 1 ? 's now ring' : ' now rings'} Lola on LolaDesk’s own line (her brain, her tools, her voice).`); live.salon_numbers_ringing_lola = Math.min(live.salon_numbers, live.salon_numbers_ringing_lola + n); }
      }
    } catch (e) { live.phone_line_ready = false; live.phone_line_error = clip(e); }
  }
  if (!optedOut) {
    if (!live.voice_key) vfix.push('Add ELEVENLABS_API_KEY in Vercel (ElevenLabs → Profile → API key), then Redeploy — it carries Lola’s own voice to the app and the phone.');
    if (!live.voice_id) vfix.push('Add ELEVENLABS_VOICE_ID in Vercel = the id of Lola’s voice (ElevenLabs → Voices → Lola → ID), then Redeploy.');
    if (live.elevenlabs === 'out_of_credit') vfix.push('ElevenLabs is out of credit, so Lola can’t speak — not in the app, not on the phone (she never switches to a different voice). ElevenLabs → Subscription: upgrade or add credits.');
    else if (live.elevenlabs === 'key_refused') vfix.push('ElevenLabs refuses ELEVENLABS_API_KEY — create a new key in ElevenLabs → Profile → API keys, paste it in Vercel, Redeploy.');
    else if (live.voice_app === false && live.voice_key && live.voice_id) vfix.push(`Lola’s voice didn’t come out (${live.voice_app_error || 'no audio'}). If it says 404 or voice_not_found: ELEVENLABS_VOICE_ID isn’t on this ElevenLabs account — copy the ID from ElevenLabs → Voices → Lola into Vercel, Redeploy.`);
    else if (typeof live.elevenlabs_left_pct === 'number' && live.elevenlabs_left_pct < 10) vfix.push(`ElevenLabs is almost out of credit (${live.elevenlabs_left_pct}% left) — when it hits zero Lola goes quiet. ElevenLabs → Subscription.`);
  }
  if (live.assistant_missing) vfix.push('There is no AI assistant on your Telnyx account, so nobody answers calls — Telnyx → AI → Assistants → Create → name it “Lola” → Save, then run this file again (LolaDesk wires the rest).');
  else if (live.assistant === false) vfix.push('LolaDesk couldn’t read your Telnyx assistants right now — run this file again in a minute.');
  if (live.assistant && live.assistant_source === 'discovered') healed.unshift(`Lola’s phone assistant found on your Telnyx account: “${live.assistant_name || 'Lola'}” (${live.assistant_id}) — LolaDesk now uses it everywhere. To make it permanent: Vercel → TELNYX_LOLA_BRAIN_ID = ${live.assistant_id} → Redeploy.`);
  else if (live.assistant && live.assistant_source === 'env_fixed') healed.unshift(`The assistant id in Vercel was missing “assistant-” — using ${live.assistant_id}.`);
  if (live.phone_assistants > live.phone_assistants_in_lola_voice && !optedOut && live.voice_key && live.voice_id) vfix.push(`${live.phone_assistants - live.phone_assistants_in_lola_voice} of ${live.phone_assistants} phone assistants still use a different voice${live.phone_voice_error ? ' (Telnyx said: ' + live.phone_voice_error + ')' : ''}. Telnyx → AI → Assistants → each one → Voice: ElevenLabs, Lola’s voice → Save.`);
  if (live.phone_greeting === false) vfix.push('Lola’s assistant has no greeting, so callers hear silence first — Telnyx → AI → Assistants → Lola → Greeting: {{lola_greeting}} → Save.');
  if (live.salon_numbers > 0 && live.salon_numbers_ringing_lola < live.salon_numbers) vfix.push(phoneMode === 'assistant'
    ? `${live.salon_numbers - live.salon_numbers_ringing_lola} of ${live.salon_numbers} salon numbers don’t ring Lola — Telnyx → Numbers → each number → Voice: connection = Lola’s assistant app → Save.`
    : `${live.salon_numbers - live.salon_numbers_ringing_lola} of ${live.salon_numbers} salon numbers don’t ring Lola yet${live.numbers_heal_error ? ' (Telnyx said: ' + live.numbers_heal_error + ')' : ''} — open this page again in 10 minutes; LolaDesk moves them itself. If it stays: Telnyx → Numbers → each number → Voice: connection = “LolaDesk” → Save.`);
  if (phoneMode === 'loladesk' && live.phone_line_ready === false) vfix.push(`LolaDesk couldn’t open its own call line on Telnyx${live.phone_line_error ? ' (' + live.phone_line_error + ')' : ''} — Telnyx → Voice → Programmable Voice → TeXML Applications: create one named “LolaDesk” with voice URL ${String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '')}/api/telnyx-voice (POST), then open this page again.`);
  if (phoneMode === 'loladesk' && live.phone_voice_cache === false) vfix.push('Lola’s phone voice can’t be stored for calls — Supabase → Storage → New bucket “voice-audio”, Public: on → Save.');
  // Can a new salon sign up right now? (the Auth admin API that creates accounts answers)
  try {
    const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (base && key) {
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 6000);
      const r = await fetch(base + '/auth/v1/admin/users?page=1&per_page=1', { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal: ac.signal }).catch(() => null);
      clearTimeout(tm);
      live.signup = !!(r && r.ok);
    } else live.signup = false;
  } catch (_) { live.signup = false; }
  if (!has('SENDGRID_API_KEY') && !(has('AWS_SES_REGION') && has('AWS_ACCESS_KEY_ID')) && !(has('MAILGUN_API_KEY') && has('MAILGUN_DOMAIN'))) fixes.push('Booking confirmation emails can’t go out yet (texts do) — add SENDGRID_API_KEY in Vercel (SendGrid → Settings → API Keys; verify the sender lola@loladesk.com, or set EMAIL_FROM to your verified address), then Redeploy.');
  if (live.signup === false) fixes.push('New salons can’t sign up: Supabase refuses the service key for accounts — Vercel: check SUPABASE_URL and SUPABASE_SERVICE_KEY (Supabase → Project Settings → API → service_role), then Redeploy.');
  if (!live.database) fixes.push('LolaDesk can’t reach its database — Vercel → Settings → Environment Variables: check SUPABASE_URL and SUPABASE_SERVICE_KEY, then Redeploy.');
  if (!settings.TELNYX_API_KEY) fixes.push('Add TELNYX_API_KEY in Vercel (Telnyx → API Keys), then Redeploy — without it Lola can’t think, speak, call or text.');
  else if (live.telnyx_key === false) fixes.push('Telnyx refuses the TELNYX_API_KEY in Vercel — create a new key in Telnyx → API Keys, paste it in Vercel, Redeploy.');
  if (live.telnyx_balance_ok === false) fixes.push('Your Telnyx balance is empty — calls, texts and Lola’s brain stop. Top up in Telnyx → Billing.');
  if (live.brain === false) fixes.push(`Lola can’t think right now — Telnyx inference refused her (${live.brain_error}). Telnyx → AI → Inference: make sure it’s enabled and your balance is above $0; then say “Lola, run a check”.`);
  if (live.hearing === false) fixes.push(`Lola can’t hear in the app — Telnyx speech-to-text refused her (${live.hearing_error}). Telnyx → AI: make sure speech-to-text is enabled for your account (set LOLA_STT_MODEL in Vercel if Telnyx names a different model).`);
  if (settings.TELNYX_API_KEY && live.telnyx_key && !live.telnyx_ai) fixes.push('Telnyx AI isn’t enabled on your account — Telnyx → AI → Inference: turn it on (Lola’s brain and hearing run there).');
  if (!settings.TELNYX_ASSISTANT && !live.assistant) fixes.push('Add TELNYX_LOLA_BRAIN_ID in Vercel = your Telnyx AI assistant id (assistant-…), then Redeploy.');
  if (!settings.TELNYX_VOICE_APP_ID) fixes.push('Add TELNYX_VOICE_APP_ID in Vercel = your Telnyx Voice API application id, then Redeploy — needed for “Call me” and calling clients.');
  if (live.numbers > 0 && live.numbers_registered_10dlc === 0) fixes.push('None of your Telnyx numbers is registered for business texting (10DLC) — US carriers block the texts. Telnyx → Messaging → 10DLC: register your brand + campaign and assign your salon number.');
  else if (live.numbers > 0 && live.numbers_registered_10dlc != null && live.numbers_registered_10dlc < live.numbers) fixes.push(`${live.numbers - live.numbers_registered_10dlc} of your ${live.numbers} Telnyx numbers aren’t on a 10DLC campaign — texts from them get blocked. Assign them in Telnyx → Messaging → 10DLC.`);
  if (!settings.CRON_SECRET) fixes.push('Add CRON_SECRET in Vercel (any long random word), then Redeploy — without it calendar sync, reminders, deposits and Boulevard writes never run.');
  if (!settings.INTEGRATION_ENCRYPTION_KEY) fixes.push('Add INTEGRATION_ENCRYPTION_KEY in Vercel (run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"), then Redeploy — needed to connect Boulevard/Square/calendar links securely.');
  if (!settings.ADMIN_EMAILS) fixes.push('Add ADMIN_EMAILS in Vercel = your login email, then Redeploy — unlocks Admin and the full “Lola, run a check”.');
  if (live.assistant_bad_values) fixes.push(`Lola’s Telnyx assistant still has ${live.assistant_bad_values.length} empty default value${live.assistant_bad_values.length > 1 ? 's' : ''} (${live.assistant_bad_values.slice(0, 4).join(', ')}${live.assistant_bad_values.length > 4 ? '…' : ''}). LolaDesk cleans them automatically on the next check (in about 10 minutes). If this stays: Telnyx → AI → Assistants → Lola → Dynamic Variables → delete the empty rows → Save.`);
  if (live.duplicate_tools) fixes.push(`Lola’s Telnyx assistant has the same tool twice (${live.duplicate_tools.slice(0, 4).join(', ')}) — Telnyx refuses every change to her until each name is unique. LolaDesk removes the extra copies automatically on the next check; if this stays: Telnyx → AI → Assistants → Lola → Tools → delete the duplicate → Save.`);
  if (live.website_calls_error) fixes.push('Salon websites can’t talk to Lola yet — Telnyx refused the setting. Telnyx → AI → Assistants → Lola → Widget: turn on “unauthenticated web calls” → Save.');
  if (live.assistant && (live.phone_tools_ok === false || live.salon_details_ok === false || live.website_calls === false) && !live.wiring_error) fixes.push('Lola’s Telnyx wiring is being secured (signed tools, salon details, website calls) — check again in a minute.');
  if (live.wiring_error) fixes.push(`Telnyx refused Lola’s wiring update (${live.wiring_error}). Say “Lola, run a check” — or Telnyx → AI → Assistants → Lola → save once, then check again.`);
  if (!process.env.TELNYX_PUBLIC_KEY) fixes.push('Add TELNYX_PUBLIC_KEY in Vercel (Telnyx → Keys & Credentials → Public Key), then Redeploy — LolaDesk then rejects any forged call or text webhook.');
  if (relayUrl && live.voice_relay === false) fixes.push(`Lola’s live voice relay (Railway) isn’t answering (${live.voice_relay_error}). Railway → the relay service → check it’s running and its variables TELNYX_API_KEY, TELNYX_LOLA_BRAIN_ID, LOLA_VOICE_SECRET. Meanwhile the app uses her direct voice.`);
  if (relayUrl && live.voice_relay_secret === false) fixes.push('Add LOLA_VOICE_SECRET in Vercel — the SAME long word as on the Railway relay — then Redeploy. Until then the app uses her direct voice.');
  fixes.push(...vfix);
  return { ok: fixes.length === 0, release: RELEASE, settings, live, healed, fixes, checked_at: new Date().toISOString() };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (cache && Date.now() - cache.at < 60e3) return res.status(200).json(cache.body);
  const body = await buildStatus().catch((e) => ({ ok: false, release: RELEASE, error: String(e?.message || e) }));
  cache = { at: Date.now(), body };
  return res.status(200).json(body);
}
