/**
 * api/lib/client-brain.js — one Lola for clients, on every channel.
 * ════════════════════════════════════════════════════════════════
 * Phone, texts, Instagram DMs and website chat all reach the same Lola, with
 * the same memory and the same hands:
 *
 *   clientStory(c, tenant, client)  → who this is: first name, last visit
 *                                      (service, stylist, how long ago), next
 *                                      appointment, what she's told us before.
 *   welcomeBack(story, { salon })   → "Hey Sarah, welcome back! Loved the ash
 *                                      blonde from last month — refreshing your
 *                                      roots or going for a blowout today?"
 *   answerClient({ … })             → Telnyx brain WITH the booking tools: she
 *                                      really checks times, books, moves and
 *                                      cancels in the salon's calendar (and the
 *                                      connected booking platform) — texts and
 *                                      DMs included, not just calls.
 */
import { db, getClientMemory } from './db.js';
import { chat } from './llm.js';
import { buildLolaSystemPrompt, buildClientMemoryBlock, profileFromMemoryRows } from './lola-skills.js';

const DAY = 86400e3;
export function agoWords(iso, now = Date.now()) {
  const d = Math.floor((now - new Date(iso).getTime()) / DAY);
  if (!(d >= 0)) return '';
  if (d <= 1) return d === 0 ? 'today' : 'yesterday';
  if (d < 7) return 'earlier this week';
  if (d < 14) return 'last week';
  if (d < 28) return `${Math.round(d / 7)} weeks ago`;
  if (d < 45) return 'last month';
  if (d < 330) return `${Math.round(d / 30)} months ago`;
  return 'a while back';
}
const first = (c) => String(c?.first_name || c?.name || '').trim().split(/\s+/)[0] || '';
const fullName = (c) => String(c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || '').trim();
const isPlaceholder = (n) => !n || /^(client|website visitor|instagram|guest|unknown)$/i.test(n);

/** Everything Lola knows about this client, in one small object. */
export async function clientStory(c, tenant, client, { memoryKey = null, now = Date.now() } = {}) {
  const story = { known: false, first: '', name: '', last: null, next: null, visits: 0, profile: null, brief: '' };
  if (!client) return story;
  story.name = fullName(client); story.first = isPlaceholder(story.name) ? '' : first(client);
  const svcName = (b) => b?.service?.name || b?.services?.name || b?.service_name || null;
  if (c && tenant?.id && client.id) {
    try {
      const { data } = await c.from('bookings').select('id,start_time,status,staff_id,service:services(name)')
        .eq('tenant_id', tenant.id).eq('client_id', client.id).order('start_time', { ascending: false }).limit(25);
      const rows = (data || []).filter((b) => b.status !== 'cancelled');
      const past = rows.filter((b) => new Date(b.start_time).getTime() <= now);
      const future = rows.filter((b) => new Date(b.start_time).getTime() > now).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      story.visits = past.filter((b) => b.status !== 'no_show').length;
      const last = past.find((b) => b.status !== 'no_show');
      if (last) {
        story.last = { service: svcName(last) || client.last_service || null, when: last.start_time, ago: agoWords(last.start_time, now), staff_id: last.staff_id || null };
        if (last.staff_id) { try { const { data: st } = await c.from('staff').select('name').eq('id', last.staff_id).maybeSingle(); if (st?.name) story.last.stylist = String(st.name).split(' ')[0]; } catch (_) {} }
      }
      if (future[0]) story.next = { service: svcName(future[0]), when: future[0].start_time };
    } catch (_) {}
  }
  if (!story.last && client.last_service) story.last = { service: client.last_service, when: client.last_visit || null, ago: client.last_visit ? agoWords(client.last_visit, now) : '' };
  try {
    const key = memoryKey || client.phone;
    if (key) story.profile = profileFromMemoryRows(await getClientMemory(tenant.id, key));
  } catch (_) {}
  story.known = !!(story.first && (story.visits || story.last || story.next));
  const bits = [];
  if (story.last?.service) bits.push(`last visit: ${story.last.service}${story.last.stylist ? ' with ' + story.last.stylist : ''}${story.last.ago ? ' (' + story.last.ago + ')' : ''}`);
  if (story.visits > 1) bits.push(`${story.visits} visits`);
  if (story.next?.service || story.next?.when) bits.push(`next: ${story.next.service || 'appointment'} on ${new Date(story.next.when).toDateString()}`);
  if (client.notes) bits.push(`note: ${String(client.notes).slice(0, 160)}`);
  story.brief = story.first ? `${story.name}${bits.length ? ' — ' + bits.join('; ') : ' (new client)'}` : '';
  return story;
}

/** The opening a returning client hears/reads. Natural, never a database read-out. */
export function welcomeBack(story, { salon = '', voice = false } = {}) {
  if (!story?.known) return '';
  const svc = story.last?.service ? String(story.last.service).replace(/\s+/g, ' ').trim() : '';
  const lower = svc.toLowerCase();
  const color = /color|colour|balayage|highlight|blonde|ombre|gloss|toner|root/.test(lower);
  const ask = story.next ? `Is this about your ${story.next.service || 'appointment'} coming up, or something else?`
    : color ? 'are we refreshing your roots or going for a blowout today?'
    : svc ? `same ${lower} again, or trying something new today?`
    : 'what can I do for you today?';
  const hello = `Hey ${story.first}, welcome back${salon && voice ? ' to ' + salon : ''}!`;
  if (svc && story.last?.ago && !story.next) return `${hello} Loved the ${lower} from ${story.last.ago} — ${ask}`;
  return `${hello} ${ask.charAt(0).toUpperCase() + ask.slice(1)}`;
}

// ── Her hands with clients (the same skills the phone uses) ──
export const CLIENT_TOOLS = [
  { name: 'list_services', description: 'The salon menu with prices.', parameters: { type: 'object', properties: {} } },
  { name: 'check_availability', description: 'Open times for a service on a date (YYYY-MM-DD).', parameters: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' } }, required: ['date'] } },
  { name: 'book_appointment', description: 'Book the client. Only after they chose a service, date and time.', parameters: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'e.g. 3:30pm' }, client_name: { type: 'string' }, stylist: { type: 'string' }, client_phone: { type: 'string', description: 'Only if the client gave a mobile number in this chat' } }, required: ['service', 'date', 'time'] } },
  { name: 'confirm_booking', description: 'Look up the client’s next appointment.', parameters: { type: 'object', properties: {} } },
  { name: 'reschedule_appointment', description: 'Move the client’s next appointment.', parameters: { type: 'object', properties: { new_date: { type: 'string', description: 'YYYY-MM-DD' }, new_time: { type: 'string' } }, required: ['new_date', 'new_time'] } },
  { name: 'cancel_appointment', description: 'Cancel the client’s next appointment, only after they clearly confirm.', parameters: { type: 'object', properties: {} } },
  { name: 'take_message', description: 'Pass a message to the salon team (questions you can’t answer, complaints, special requests).', parameters: { type: 'object', properties: { message: { type: 'string' }, client_name: { type: 'string' } }, required: ['message'] } },
].map((f) => ({ type: 'function', function: f }));

let _skills = null;
async function skills() { if (!_skills) _skills = (await import('../lola-tools.js')).SKILLS; return _skills; }

function todayIn(tz, now = Date.now()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(new Date(now)).reduce((o, p) => (o[p.type] = p.value, o), {}); } catch (_) { return null; }
}

/**
 * One turn with a client. identity: { phone } for calls/texts, { key:'ig:<id>' } for Instagram, { key:'web:<id>' } for the site.
 * Returns { ok, reply, actions:[{tool, result}] }.
 */
export async function answerClient({ tenant, client = null, channel = 'sms', text, history = [], phone = null, memoryKey = null, tz = 'America/New_York', extra = '', now = Date.now(), budgetMs = 0 }) {
  const started = Date.now();
  const left = () => (budgetMs ? budgetMs - (Date.now() - started) : 12000);
  const c = db();
  const story = await clientStory(c, tenant, client, { memoryKey, now });
  const fresh = !history.length;
  const d = todayIn(tz, now);
  const greet = fresh ? welcomeBack(story, { salon: tenant?.name }) : '';
  const channelName = { sms: 'text message', whatsapp: 'WhatsApp', instagram: 'Instagram DM', messenger: 'Facebook Messenger', web: 'website chat', voice: 'phone call' }[channel] || channel;
  const system = buildLolaSystemPrompt({ tenant, channel, memoryBlock: buildClientMemoryBlock(story.profile) }) + `

TODAY: ${d ? `${d.weekday} ${d.year}-${d.month}-${d.day}` : new Date(now).toDateString()} (salon time zone ${tz}).
YOU ARE ANSWERING BY ${channelName.toUpperCase()}: 1–3 short sentences, plain text, no lists, no markdown.${channel === 'voice' ? ' Your words are spoken aloud: no emojis, no links, say times and prices the way a person says them.' : ''}
WHO THIS IS: ${story.brief || (phone ? 'A new client (texting from their phone).' : 'A new client — you don’t have their phone number yet.')}
${greet ? `OPEN WITH THIS WELCOME (in your own words, then answer what they asked): "${greet}"` : ''}
YOU CAN REALLY DO THINGS — use the tools, never pretend:
- To book: find the service, check_availability for the day, offer 2–3 real times, then book_appointment once they pick.
- To move or cancel: reschedule_appointment / cancel_appointment (cancel only after they clearly confirm).
- Never say a time is open or that something is booked/moved/cancelled unless a tool just told you so.
${phone ? '' : '- Before booking, ask for their mobile number so the salon can text the confirmation; pass it as client_phone.'}
${extra}`.trim();

  const msgs = [...history.slice(-10), { role: 'user', content: String(text || '').slice(0, 1500) }];
  const S = await skills();
  const actions = [];
  for (let round = 0; round < 4; round++) {
    if (left() < 3000) break;   // a live call can't wait: answer with what the tools already said
    const r = await chat({ system, messages: msgs, tools: CLIENT_TOOLS, maxTokens: 300, temperature: 0.5, fast: true, deadlineMs: Math.min(12000, left()) }).catch(() => null);
    if (!r || !r.ok) break;
    const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    if (!calls.length) {
      const reply = String(r.text || '').replace(/[*_#`]/g, '').trim();
      if (reply) return { ok: true, reply, actions, story };
      break;
    }
    msgs.push({ role: 'assistant', content: r.text || null, tool_calls: calls });
    for (const call of calls) {
      const name = call?.function?.name; let args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch (_) {}
      const skill = name === 'take_message' ? 'takeMessage' : name;
      let result;
      if (!S[skill]) result = { speak: 'That tool isn’t available.' };
      else {
        const clientPhone = phone || args.client_phone || null;
        const body = { ...args, client_phone: clientPhone, from: clientPhone, client_name: args.client_name || (story.first ? story.name : undefined), channel };
        // Same gate as the phone (an expired trial can't take new bookings; cancels always work).
        try { const { executeSkill } = await import('./orchestrator.js'); result = await executeSkill(tenant, clientPhone, skill, body, S); }
        catch (e) { result = { speak: 'That didn’t go through — offer to have the salon follow up.', error: String(e?.message || e) }; }
      }
      actions.push({ tool: name, args, result });
      msgs.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result).slice(0, 2500) });
    }
  }
  // The brain is down: never leave a client unanswered.
  const fallback = greet || `Thanks for reaching out to ${tenant?.name || 'us'}! Tell me the service and day you’d like, and I’ll find you a time.`;
  return { ok: false, reply: actions.at(-1)?.result?.speak || fallback, actions, story };
}
