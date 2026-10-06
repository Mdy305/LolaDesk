// Marketing reads a URL again, and the strategist plans from the salon's REAL open chairs and clients.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const ai = []; let fastDown = false;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/openai/chat/completions')) {
    const b = JSON.parse(init.body); ai.push(b);
    if (fastDown && /Llama/.test(b.model)) return J({ error: { message: 'model not found' } }, 404);
    const sys = b.messages[0].content;
    const text = /HEADLINE/.test(sys) ? 'HEADLINE:\nFill Tuesdays with your due clients\nPOSITIONING SHIFT:\nFrom walk-in to booked-out\nTOP PRIORITIES:\nBring back the 2 due clients | They are ready | Text them Tuesday times\nCAMPAIGNS TO RUN:\nDue-back Tuesday | Due clients | sms | once | 2 bookings\nWHAT NOT TO DO:\n- Discount\nNORTH STAR METRIC:\nChair utilization'
      : 'SUMMARY:\nA Miami Beach salon known for color.\nPOSITIONING:\nLuxury color\nTARGET AUDIENCE:\nProfessionals\nSTRENGTHS:\n- Color\nGAPS:\n- No online booking\nSERVICES DETECTED:\n- Balayage\nBRAND TONE:\nWarm\nTOP OPPORTUNITIES:\n- Add a booking link';
    return J({ choices: [{ message: { content: text } }] });
  }
  if (u.startsWith('https://mmasalon.example')) return new Response('<html><title>MMA Salon</title><body>Balayage specialists in Miami Beach</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '44444444-4444-4444-8444-444444444444', TZ = 'America/New_York', DAY = 864e5;
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', city: 'Miami Beach' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.booking_settings = [{ tenant_id: TID, timezone: TZ }];
T.staff = [{ id: 'ana', tenant_id: TID, name: 'Ana', is_active: true }]; T.staff_schedules = []; for (let d = 0; d < 7; d++) T.staff_schedules.push({ tenant_id: TID, staff_id: 'ana', day_of_week: d, start_time: '09:00', end_time: '17:00' });
T.staff_time_off = []; T.blocked_slots = []; T.services = [{ id: 's1', tenant_id: TID, name: 'Balayage', price: 220, duration_minutes: 150, is_active: true }];
T.clients = [{ id: 'c1', tenant_id: TID, name: 'Sarah', phone: '+13055550001' }, { id: 'c2', tenant_id: TID, name: 'Mia', phone: '+13055550002' }];
T.bookings = [{ id: 'b1', tenant_id: TID, client_id: 'c1', service_id: 's1', staff_id: 'ana', start_time: new Date(Date.now() - 50 * DAY).toISOString(), end_time: new Date(Date.now() - 50 * DAY + 3600e3).toISOString(), status: 'completed', total_amount: 220 }];
T.opt_outs = [];
const P = new URL('../../api/', import.meta.url).href;
const h = (await import(P + 'marketer.js')).default;
const run = (body, headers = {}) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } }; h({ method: 'POST', headers, query: {}, body }, res); });

let r = await run({ action: 'analyze', url: 'mmasalon.example' });
ok(!r.ok && ai.length === 0, 'Analyze needs a signed-in owner (no anonymous AI spend / URL fetching)');
r = await run({ action: 'analyze', url: 'mmasalon.example' }, { authorization: 'Bearer tok' });
ok(r.ok && /Miami Beach/.test(r.summary) && r.services_detected?.includes('Balayage'), 'Analyze reads the URL and returns the report');
ok(/Llama/.test(ai.at(-1).model) && ai.at(-1).max_tokens >= 1100, 'long reports are written by the fast model with room to finish (not a 120s Kimi chain that Vercel kills): ' + ai.at(-1).model + ' / ' + ai.at(-1).max_tokens);
fastDown = true; ai.length = 0;
r = await run({ action: 'analyze', url: 'mmasalon.example' }, { authorization: 'Bearer tok' });
ok(r.ok && ai.some((b) => /Kimi/.test(b.model)), 'fast model unavailable → Kimi finishes it inside the same budget');
fastDown = false; ai.length = 0;

r = await run({ action: 'strategy', goals: 'fill Tuesdays' }, { authorization: 'Bearer tok' });
const prompt = ai.at(-1)?.messages?.at(-1)?.content || '';
ok(r.ok && r.grounded && /REAL FACTS/.test(prompt) && /chair-hours/.test(prompt) && /Balayage \$220/.test(prompt) && /Clients: 2 total/.test(prompt), 'the strategist plans from the salon’s real open chairs, clients and menu');
ok(/fill every empty chair/i.test(ai.at(-1).messages[0].content) && r.top_priorities.length && r.campaigns_to_run.length, 'and returns priorities and campaigns to run');
r = await run({ action: 'strategy' });
ok(r.ok && !r.grounded, 'without a session it still writes a strategy (just not grounded)');
const html = (await import('node:fs')).readFileSync(new URL('../../marketer.html', import.meta.url), 'utf8');
ok(/id="fillBtn"/.test(html) && /action:'plan_build'/.test(html) && /action:'plan_approve'/.test(html), 'Strategy tab: “Build my 30-day fill plan” → approve → it runs');
const mig = (await import('node:fs')).readFileSync(new URL('../../api/lib/migrate.js', import.meta.url), 'utf8');
ok(['lola_campaigns', 'lola_campaign_recipients', 'lola_fill_plans', 'marketing_intelligence'].every((x) => mig.includes(`ensureTable(c, '${x}'`)), 'the marketing tables create themselves (no manual SQL)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
