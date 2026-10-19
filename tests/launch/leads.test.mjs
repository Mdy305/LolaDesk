// Lola never loses a request. Every booking attempt, call-back and message — phone, website, text — is kept:
// on the salon's dashboard (Needs you + Clients) with the owner told when it really failed, or, when the
// salon can't be told apart, in the LolaDesk Console. A booking that goes through closes it.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.SENDGRID_API_KEY = 'sg-test'; process.env.EMAIL_FROM = 'lola@loladesk.com'; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const mails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '77777777-7777-4777-8777-777777777777', DUP = '88888888-8888-4888-8888-888888888888', TZ = 'America/New_York';
T.tenants = [
  { id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', owner_email: 'owner@mmasalon.com', services: [{ name: 'Cut', price: 80, duration: 60 }] },
  { id: DUP, name: 'MMA SALON', slug: 'mma2', subscription_status: 'trialing', phone_number: null, owner_email: 'old@x.com' },
];
// One number on two salon rows (duplicate sign-ups) — the one that also holds it as its main number is the salon.
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
for (const k of ['booking_settings', 'services', 'staff', 'staff_services', 'staff_schedules', 'staff_time_off', 'blocked_slots', 'bookings', 'availability_holds', 'clients', 'locations', 'business_hours', 'cached_availability', 'provider_mappings', 'booking_outbox', 'integrations', 'client_memories', 'usage_events', 'deposits', 'tenant_channels', 'opt_outs', 'call_sessions', 'support_tickets', 'calls', 'agent_runs']) T[k] = T[k] || [];
const P = new URL('../../api/', import.meta.url).href;

const tools = (await import(P + 'lola-tools.js')).default;
const { saveLead, bookingOutcome, leadBooked, leadActions } = await import(P + 'lib/lead-inbox.js');

const { toolKey } = await import(P + 'lib/tool-key.js');
const call = (query, body, signed = true) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  tools({ method: 'POST', query: { ...(signed ? { k: toolKey() } : {}), ...query }, headers: {}, body }, res);
});
const leads = () => T.usage_events.filter((e) => e.kind === 'lead');

// 1. A website visitor on a widget with no salon line: nothing booked — and the request reaches the LolaDesk Console.
let r = await call({ tool: 'book_appointment', ch: 'web', call: 'v3:web-9' }, { service: 'Balayage', date: 'friday', time: '2pm', client_name: 'Sofia Reyes', client_phone: '3055551234', client_email: 'sofia@x.com' });
const tk = T.support_tickets.at(-1);
ok(r.booked === false && tk && tk.channel === 'lead_unrouted' && /Sofia Reyes/.test(tk.issue) && /Balayage friday 2pm/.test(tk.issue) && tk.phone === '+13055551234', 'no salon on the request: nothing booked, and the LolaDesk team gets Sofia, her number and what she wanted');

// 2. A take-message on the salon line: on the dashboard + the owner told.
mails.length = 0;
r = await call({ tool: 'take-message', to: '+13055550100', from: '+13055559876' }, { caller_name: 'Dana Cruz', callback_number: '+13055559876', message_summary: 'Wants to know if you do keratin on Sundays' });
const l1 = leads().at(-1);
ok(l1 && l1.tenant_id === TID && l1.metadata.name === 'Dana Cruz' && /keratin/.test(l1.metadata.message), 'a message left with Lola is saved for the salon');
ok(mails.some((m) => /Dana Cruz/.test(JSON.stringify(m))), 'and the owner is told (email; texts too once 10DLC is approved)');
ok(T.clients.some((c) => c.tenant_id === TID && c.phone === '+13055559876'), 'Dana is in Clients');

// 3. The booking can't go through (unsigned / repairing): kept + owner told; never pretends.
mails.length = 0;
r = await call({ tool: 'book_appointment', to: '+13055550100', from: '+13055554444' }, { service: 'Cut', date: 'friday', time: '3pm', client_name: 'Lee Park', client_phone: '+13055554444' }, false);
const l2 = leads().at(-1);
ok(r.booked === false && l2.metadata.name === 'Lee Park' && l2.metadata.reason === 'unsigned' && mails.length === 0 && !T.clients.some((c) => c.phone === '+13055554444'), 'an unverified request: nothing booked, kept on record only — no client, no alert (a forged request can’t spam the salon)');
// A real failure on a verified call: kept, Lee in Clients, owner told once.
await saveLead({ tenant: T.tenants[0], name: 'Lee Park', phone: '+13055554444', service: 'Cut', when: 'friday 3pm', channel: 'phone', ...bookingOutcome({ booked: false, error: 'conflict' }) });
ok(mails.length === 1 && T.clients.some((c) => c.phone === '+13055554444'), 'a booking that really failed: Lee saved to Clients and the owner told once');

// 4. Mid-conversation (she still needs the email): kept quietly, no alert.
mails.length = 0;
const soft = bookingOutcome({ booked: false, needs: ['email'] });
ok(soft.reason === 'unfinished' && soft.alert === false && bookingOutcome({ booked: false, error: 'conflict' }).alert === true, 'unfinished steps are quiet; real failures alert');
await saveLead({ tenant: T.tenants[0], name: 'Mia Lopez', phone: '+13055557777', service: 'Gloss', channel: 'sms', ...soft });
ok(mails.length === 0 && leads().some((e) => e.metadata.name === 'Mia Lopez'), 'Mia’s half-finished booking is kept, without bothering the owner');
const again = await saveLead({ tenant: T.tenants[0], name: 'Mia Lopez', phone: '+13055557777', service: 'Gloss', channel: 'sms', ...soft });
ok(again.duplicate, 'Lola retrying the same step makes one lead, not five');

// 5. She books after all → the lead is closed.
const before = leadActions(T.usage_events).filter((a) => /Mia Lopez/.test(a.detail)).length;
await new Promise((res) => setTimeout(res, 5));
await leadBooked(T.tenants[0], '+13055557777');
const after = leadActions(T.usage_events).filter((a) => /Mia Lopez/.test(a.detail)).length;
ok(before === 1 && after === 0, 'when the booking goes through, her lead leaves Needs you');

// 6. The owner's brief: who needs them, with what they wanted.
const { awayBrief } = await import(P + 'lib/owner-brief.js');
const { db } = await import(P + 'lib/db.js');
const br = await awayBrief(db(), T.tenants[0], new Date(Date.now() - 3600e3).toISOString());
ok(br.counts.needs_you >= 2 && br.needs.some((n) => n.kind === 'lead' && n.name === 'Lee Park' && n.reason === 'not_booked') && br.needs.some((n) => n.name === 'Dana Cruz'), 'Lola’s brief lists Lee (couldn’t finish) and Dana (message) under Needs you: ' + br.say);

// 7. Another salon never sees them.
ok(!leads().some((e) => e.tenant_id === DUP), 'leads stay with their own salon');

console.log(fails ? `\n${fails} FAILED` : '\nall lead checks pass');
process.exit(fails ? 1 : 0);
