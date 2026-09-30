// Every salon gets its OWN booking link — on calls, in texts, on Home,
// in Settings — and a salon without a slug or with a broken stored link
// still gets a working one. Telnyx never receives a value it rejects.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'service-key';
delete process.env.APP_URL;
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const { bookingLinkFor, normalizeBookingUrl, telnyxSafeVariables } = await import(P + 'lib/booking-link.js');

// ── Three salons, three situations ──
const BLVD = 'https://www.joinblvd.com/b/mmasalon/widget#/visit-type';
const salons = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'MMA Salon', slug: 'mma-salon', phone_number: '+13055550101', booking_url: BLVD, owner_email: 'm@mma.salon' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Glow Spa', slug: 'glow-spa', phone_number: '+13055550102', booking_url: null, owner_email: 'o@glow.spa' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'No Slug Studio', slug: null, phone_number: '+13055550103', booking_url: 'https://www.loladesk.com/book.html?t=undefined', owner_email: 'o@noslug.studio' },
];
ok(bookingLinkFor(salons[0]) === BLVD, 'salon on Boulevard → its Boulevard link');
ok(bookingLinkFor(salons[1]) === 'https://www.loladesk.com/book?t=glow-spa', 'salon with no link → its own LolaDesk page');
ok(bookingLinkFor(salons[2]) === 'https://www.loladesk.com/book?t=33333333-3333-4333-8333-333333333333', 'broken stored "?t=undefined" + no slug → healed to a working page by id');
ok(bookingLinkFor({ ...salons[1], booking_url: 'https://www.loladesk.com/book.html?t=' }) === 'https://www.loladesk.com/book?t=glow-spa', 'empty "?t=" stored at provisioning → healed');
ok(bookingLinkFor({ ...salons[1], booking_url: 'not a link' }) === 'https://www.loladesk.com/book?t=glow-spa', 'junk stored value → never said to a caller');
ok(bookingLinkFor({ ...salons[1], booking_url: 'javascript:alert(1)' }) === 'https://www.loladesk.com/book?t=glow-spa', 'non-web link → never used');
process.env.APP_URL = 'https://app.example.com/';
ok(bookingLinkFor(salons[1]) === 'https://app.example.com/book?t=glow-spa', 'APP_URL respected (no double slash)');
delete process.env.APP_URL;

// ── What Settings accepts ──
ok(normalizeBookingUrl(BLVD).value === BLVD, 'Settings keeps a Boulevard link exactly (including #/visit-type)');
ok(normalizeBookingUrl('glowspa.com/book').value === 'https://glowspa.com/book', 'Settings adds https:// when an owner leaves it off');
ok(normalizeBookingUrl('').ok && normalizeBookingUrl('').value === null, 'empty → cleared (use the LolaDesk page)');
ok(normalizeBookingUrl('https://www.loladesk.com/book?t=glow-spa').value === null, "pasting their own LolaDesk page → stored as default, not frozen");
ok(!normalizeBookingUrl('javascript:alert(1)').ok, 'javascript: rejected');
ok(!normalizeBookingUrl('call us').ok, 'plain words rejected with a readable message: ' + normalizeBookingUrl('call us').error);

// ── What Telnyx receives, per salon, on a real call ──
T.tenants = salons.map((s) => ({ ...s, hours: { mon: '10-7' }, location: null, business_mode: 'salon' }));
T.tenant_numbers = []; T.services = [{ tenant_id: salons[1].id, name: 'Facial', price: 95.5, duration_minutes: 60, is_active: true }];
T.staff = []; T.marketing_intelligence = []; T.clients = []; T.client_memory = []; T.call_sessions = []; T.calls = [];
const agentVars = (await import(P + 'agent-variables.js')).default;
const call = (to) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve(null); } };
  agentVars({ method: 'POST', url: '/api/agent-variables', headers: {}, body: { data: { payload: { telnyx_agent_target: to, telnyx_end_user_target: '+13055559999' } } } }, res);
});
const legal = (vars) => Object.entries(vars).every(([, v]) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isInteger(v)));
for (const s of salons) {
  const r = await call(s.phone_number);
  const v = r?.dynamic_variables || {};
  ok(v.company_name === s.name, `${s.name}: Lola answers as ${v.company_name}`);
  ok(v.booking_url === bookingLinkFor(s) && /^https:\/\//.test(v.booking_url), `${s.name}: booking_url = ${v.booking_url}`);
  ok(legal(v), `${s.name}: every value is text, true/false or a whole number (Telnyx accepts it)`);
}
const other = await call('+13055550199');
ok(other?.dynamic_variables?.booking_url === '' && other?.dynamic_variables?.company_name === 'our salon', "unknown number → neutral, never another salon's link");
ok(legal(telnyxSafeVariables({ a: null, b: 9.5, c: { x: 1 }, d: 3, e: true, f: undefined })), 'sanitizer: null / decimals / objects all made Telnyx-safe');

// ── Settings: each owner edits only their own salon's link ──
globalThis.__authUsers = { 'glow-owner-token-000000': { id: 'uG', email: 'o@glow.spa' }, 'mma-owner-token-0000000': { id: 'uM', email: 'm@mma.salon' } };
T.tenant_users = [];
const settings = (await import(P + 'settings.js')).default;
const save = (token, body) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); }, end() { resolve({ status: this.statusCode }); } };
  settings({ method: 'POST', url: '/api/settings', headers: { authorization: 'Bearer ' + token }, body }, res);
});
let r = await save('glow-owner-token-000000', { booking_url: 'glowspa.com/book' });
const glow = () => T.tenants.find((t) => t.id === salons[1].id), mma = () => T.tenants.find((t) => t.id === salons[0].id);
ok(r.status === 200 && glow().booking_url === 'https://glowspa.com/book', 'Glow Spa owner sets their own link');
ok(mma().booking_url === BLVD, "…and MMA Salon's link is untouched");
r = await save('glow-owner-token-000000', { booking_url: 'call us maybe' });
ok(r.status === 400 && r.body.field === 'booking_url' && glow().booking_url === 'https://glowspa.com/book', 'a bad link is refused with a message, nothing saved');
r = await save('glow-owner-token-000000', { booking_url: '' });
ok(r.status === 200 && glow().booking_url === null && bookingLinkFor(glow()) === 'https://www.loladesk.com/book?t=glow-spa', 'clearing it → back to their LolaDesk page');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
