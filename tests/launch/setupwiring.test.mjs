// Lola does the setup by conversation: her owner tools include the line, texting and channel setup
// tools; anything that spends money or can't be undone waits for the owner's "yes".
import { randomBytes } from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1'; process.env.TELNYX_ORDER_SETTLE_MS = '0'; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64'); process.env.APP_URL = 'https://www.loladesk.com';
process.env.INSTAGRAM_APP_ID = 'ig-app'; process.env.INSTAGRAM_APP_SECRET = 'ig-secret';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const hits = []; let assignedTo = null;
globalThis.fetch = async (url, init = {}) => {
  const u = decodeURIComponent(String(url)), m = (init.method || 'GET').toUpperCase();
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  let body = null; try { body = typeof init.body === 'string' ? JSON.parse(init.body || '{}') : null; } catch (_) {}
  hits.push({ u, m, body });
  if (/\/10dlc\/phone_number_campaigns\/\+1\d{10}$/.test(u)) return assignedTo ? J({ phoneNumber: u.split('/').pop(), campaignId: assignedTo, assignmentStatus: 'ASSIGNED' }) : J({ errors: [{ detail: 'not found' }] }, 404);
  if (/\/ai\/assistants\/assistant-lola$/.test(u)) return J({ data: { id: 'assistant-lola', name: 'Lola', telephony_settings: { default_texml_app_id: 'texml-lola' } } });
  if (/\/available_phone_numbers/.test(u)) return J({ data: [{ phone_number: '+13055550888' }] });
  if (/\/number_orders$/.test(u)) return J({ data: { id: 'ord-1', status: 'pending' } });
  if (/\/phone_numbers\?/.test(u)) return J({ data: [{ id: 'pn-new', phone_number: '+13055550888' }] });
  if (/\/phone_numbers\/[\w-]+(\/messaging)?$/.test(u)) return J({ data: { id: 'pn-new' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const C = '00000000-0000-4000-8000-0000000000c3';
T.tenants = [{ id: C, name: 'New Salon', slug: 'new', owner_email: 'c@new.com', phone_number: null, subscription_status: 'active' }];
T.tenant_numbers = []; T.tenant_channels = []; T.tenant_number_ports = []; T.tenant_compliance = []; T.usage_events = []; T.client_memories = []; T.platform_settings = []; T.tenant_onboarding = [];
const tenant = T.tenants[0];
const OT = await import(P + 'lib/owner-tools.js');
const names = [...OT.OWNER_TOOL_NAMES];
ok(['setup_status', 'get_number', 'forward_my_number', 'port_my_number', 'register_texting', 'texting_status', 'connect_instagram', 'connect_facebook', 'turn_on_whatsapp', 'channels_status'].every((n) => names.includes(n)), 'Lola’s owner tools include line, texting and channel setup');
ok(names.length === new Set(OT.OWNER_TOOLS.map((t) => t.function.name)).size, 'no tool is declared twice');
let r = await OT.runOwnerTool({ tenant, name: 'setup_status', args: {} });
ok(r && typeof r.say === 'string' && r.say.length > 10 && !/assistant-|texml|mp-1|TELNYX_/i.test(r.say), 'setup status in plain words: ' + r.say);
hits.length = 0;
r = await OT.runOwnerTool({ tenant, name: 'get_number', args: { area_code: '305' } });
ok(r.needs_confirmation === true && !hits.some((h) => /number_orders/.test(h.u)), 'getting a number asks first and buys nothing: ' + r.say);
const parked = T.client_memories.find((x) => x.tenant_id === C && x.client_phone === 'owner_pending');
ok(parked && parked.value?.name === 'get_number', 'the action waits for the owner’s yes');
r = await OT.takePendingAction({ tenant, text: 'yes' });
ok(r && r.ok !== false && /\(?305\)?/.test(String(r.say)) , 'saying yes gets the number: ' + (r && r.say));
r = await OT.runOwnerTool({ tenant, name: 'connect_instagram', args: {} });
ok(r.ui?.open === 'oauth' && /^https:\/\/www\.instagram\.com\/oauth\/authorize\?/.test(r.ui.url), 'connect Instagram opens Instagram’s sign-in');
const prompt = await OT.ownerSystemPrompt(tenant);
ok(/set the salon up/i.test(prompt) && /included in their plan/i.test(prompt), 'Lola knows she sets salons up, and never quotes fees');
// A salon already on a platform 10DLC campaign is registered: never asked again, never re-registered.
const M = '00000000-0000-4000-8000-0000000000a9';
T.tenants.push({ id: M, name: 'MMA Salon', slug: 'mma', owner_email: 'm@mma.com', phone_number: '+13055550100', subscription_status: 'active' });
T.tenant_numbers.push({ tenant_id: M, phone_number: '+13055550100', kind: 'primary', status: 'active' });
assignedTo = 'C-PLATFORM'; hits.length = 0;
r = await OT.runOwnerTool({ tenant: T.tenants.find((t) => t.id === M), name: 'setup_status', args: {} });
ok(/already registered for business texting/i.test(r.say), 'a salon already on a texting campaign is told it’s registered: ' + r.say);
r = await OT.runOwnerTool({ tenant: T.tenants.find((t) => t.id === M), name: 'register_texting', args: { legal_name: 'MMA Salon LLC', ein: '12-3456789', confirmed: true } });
ok(/already registered/i.test(r.say) && !hits.some((h) => /\/10dlc\/brand$/.test(h.u) && h.m === 'POST'), 'and is never registered a second time');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
