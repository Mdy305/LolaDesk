// Every salon gets its phone line and business-texting registration through Lola — per salon,
// with live status — and only LolaDesk's admins see (and touch) the platform-wide telecom registry.
import { randomBytes } from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1'; process.env.TELNYX_ORDER_SETTLE_MS = '0'; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.ADMIN_EMAILS = 'admin@loladesk.com'; process.env.TELECOM_WEBHOOK_WAIT_MS = '20000'; process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.TELNYX_PUBLIC_KEY; delete process.env.TELNYX_LOA_CONFIGURATION_ID;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ── Fake Telnyx (documented endpoints only) ──
const hits = [];
const state = { portStatus: 'draft', campaignStatus: 'TCR_PENDING', brandStatus: 'OK', brandIdentity: 'VERIFIED', docs: 0, brandSeq: 0, owned: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = decodeURIComponent(String(url)), m = (init.method || 'GET').toUpperCase();
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  let body = null; try { body = typeof init.body === 'string' ? JSON.parse(init.body || '{}') : null; } catch (_) {}
  hits.push({ u, m, body });
  if (/\/v2\/messages$/.test(u)) return J({ data: { id: 'msg-1' } });
  if (/\/portability_checks$/.test(u)) return J({ data: (body.phone_numbers || []).map((p) => ({ phone_number: p, portable: !/0000$/.test(p), fast_portable: true, not_portable_reason: /0000$/.test(p) ? 'Rate center not supported' : null, record_type: 'portability_check_result' })) });
  if (/\/porting\/loa_configurations$/.test(u)) return J({ data: [{ id: 'loa-cfg-1', name: 'LolaDesk' }] });
  if (/\/porting_orders\/po-1\/loa_template/.test(u)) return new Response(Buffer.from('%PDF-1.4 fake loa'), { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (/\/porting_orders\/po-1\/requirements$/.test(u)) return J({ data: [] });
  if (/\/porting_orders\/po-1\/actions\/confirm$/.test(u)) { state.portStatus = 'in-process'; return J({ data: { id: 'po-1', status: { value: 'in-process' } } }); }
  if (/\/porting_orders\/po-1$/.test(u) && m === 'PATCH') return J({ data: { id: 'po-1' } });
  if (/\/porting_orders\/po-1$/.test(u)) return J({ data: { id: 'po-1', status: { value: state.portStatus, details: state.portStatus === 'exception' ? [{ code: 'PASSCODE_PIN_INVALID', description: 'PIN invalid' }] : [] }, requirements_met: true, activation_settings: { foc_datetime_actual: state.portStatus === 'foc-date-confirmed' ? '2026-10-20T15:00:00Z' : null } } });
  if (/\/porting_orders$/.test(u) && m === 'POST') return J({ data: { id: 'po-1', status: { value: 'draft' }, requirements_met: false } });
  if (/\/documents$/.test(u) && m === 'POST') return J({ data: { id: 'doc-' + (++state.docs) } });
  if (/\/10dlc\/brand$/.test(u) && m === 'POST') { const id = 'B' + (++state.brandSeq); return J({ brandId: id, status: state.brandStatus, identityStatus: body.entityType === 'PRIVATE_PROFIT' ? state.brandIdentity : 'UNVERIFIED', displayName: body.displayName }); }
  if (/\/10dlc\/brand\/B\d+\/smsOtp$/.test(u) && m === 'POST') return J({ brandId: u.match(/brand\/(B\d+)/)[1], referenceId: 'otp-ref-1' });
  if (/\/10dlc\/brand\/B\d+\/smsOtp$/.test(u) && m === 'PUT') return J({});
  if (/\/10dlc\/brand\/B\d+$/.test(u)) return J({ brandId: u.match(/brand\/(B\d+)/)[1], status: state.brandStatus, identityStatus: state.brandIdentity });
  if (/\/10dlc\/campaignBuilder$/.test(u)) return J({ campaignId: 'C-' + body.brandId, brandId: body.brandId, campaignStatus: 'TCR_PENDING', usecase: body.usecase });
  if (/\/10dlc\/campaign\/C-B\d+$/.test(u)) return J({ campaignId: u.split('/').pop(), campaignStatus: state.campaignStatus });
  if (/\/10dlc\/phone_number_campaigns$/.test(u) && m === 'POST') return J({ phoneNumber: body.phoneNumber, campaignId: body.campaignId, assignmentStatus: 'PENDING_ASSIGNMENT' });
  if (/\/10dlc\/phone_number_campaigns\/\+1\d{10}$/.test(u)) return J({ phoneNumber: u.split('/').pop(), assignmentStatus: 'ASSIGNED' });
  if (/\/ai\/assistants\/assistant-lola$/.test(u)) return J({ data: { id: 'assistant-lola', name: 'Lola', telephony_settings: { default_texml_app_id: 'texml-lola' } } });
  if (/\/available_phone_numbers/.test(u)) return J({ data: [{ phone_number: '+13055550888' }] });
  if (/\/number_orders$/.test(u)) { state.owned.push({ id: 'pn-bought', phone_number: body.phone_numbers[0].phone_number }); return J({ data: { id: 'ord-1', status: 'pending' } }); }
  if (/\/phone_numbers\?.*filter\[phone_number\]=/.test(u)) { const p = u.match(/filter\[phone_number\]=([^&]+)/)[1]; const all = [{ id: 'pn-port', phone_number: '+13055550111' }, { id: 'pn-pool', phone_number: '+13055550999' }, ...state.owned]; return J({ data: all.filter((n) => n.phone_number === p) }); }
  if (/\/phone_numbers\?/.test(u)) return J({ data: [{ id: 'pn-a', phone_number: '+13055550100', connection_id: 'texml-lola', messaging_profile_id: 'mp-1' }, { id: 'pn-pool', phone_number: '+13055550999', connection_id: null }] });
  if (/\/phone_numbers\/[\w-]+(\/messaging)?$/.test(u)) return J({ data: { id: 'x' } });
  if (/\/calls$/.test(u)) return J({ data: { call_control_id: 'cc-1' } });
  return J({ data: [] });
};

const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2', C = '00000000-0000-4000-8000-0000000000c3', ADM = '00000000-0000-4000-8000-0000000000d4';
T.tenants = [
  { id: A, name: 'MMA Salon', slug: 'mma', owner_email: 'owner@mma.com', owner_phone: '+17865550001', phone_number: '+13055550100', subscription_status: 'active' },
  { id: B, name: 'Glow Studio', slug: 'glow', owner_email: 'b@glow.com', owner_phone: '+17865550002', phone_number: '+13055550200', subscription_status: 'active' },
  { id: C, name: 'New Salon', slug: 'new', owner_email: 'c@new.com', owner_phone: '+17865550003', phone_number: null, subscription_status: 'active' },
  { id: ADM, name: 'Platform', slug: 'platform', owner_email: 'admin@loladesk.com', phone_number: null },
];
T.tenant_numbers = [{ tenant_id: A, phone_number: '+13055550100', kind: 'primary', status: 'active' }, { tenant_id: B, phone_number: '+13055550200', kind: 'primary', status: 'active' }];
T.tenant_channels = []; T.tenant_number_ports = []; T.tenant_compliance = []; T.usage_events = []; T.tenant_users = []; T.platform_settings = []; T.tenant_onboarding = []; T.opt_outs = [];
globalThis.__authUsers = { 'tok-owner': { id: 'u-owner', email: 'owner@mma.com' }, 'tok-c': { id: 'u-c', email: 'c@new.com' }, 'tok-admin': { id: 'u-admin', email: 'admin@loladesk.com' } };
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: t }); }, end(t) { resolve({ status: this.statusCode, text: t }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, ...req }, res); }); };
const E = await import(P + 'lib/setup/telecom.js');
const tools = await import(P + 'lib/setup/telecom-tools.js');
const { decrypt } = await import(P + 'lib/crypto.js');
const tA = () => T.tenants.find((t) => t.id === A);
const tool = (tenant, name, args = {}) => tools.runSetupTool({ tenant, name, args });

// ── 1. Forwarding: another salon can never take over a salon's forwarding row ──
T.tenant_channels.push({ id: 'ch-1', tenant_id: B, channel: 'forwarding', account_id: '+13055557777', status: 'verified', updated_at: new Date(Date.now() - 864e5).toISOString() });
hits.length = 0;
let r = await E.forwarding(tA(), { salonNumber: '(305) 555-7777', test: true });
ok(r.ok === false && /another salon/i.test(r.say), 'a number verified for another salon is refused in plain words: ' + r.say);
ok(T.tenant_channels.find((x) => x.account_id === '+13055557777').tenant_id === B && T.tenant_channels.find((x) => x.account_id === '+13055557777').status === 'verified', 'the other salon keeps its verified forwarding row');
ok(!hits.some((h) => /\/calls$/.test(h.u)), 'no test call is placed for a taken number');
r = await E.forwarding(tA(), { salonNumber: '+13055550200', test: true });
ok(r.ok === false && /another salon/i.test(r.say), 'another salon’s Lola line can’t be used as "my salon number"');
r = await E.forwarding(tA(), { salonNumber: '+13055558888', test: true });
ok(r.ok === true && T.tenant_channels.some((x) => x.account_id === '+13055558888' && x.tenant_id === A && x.status === 'testing'), 'the salon’s own number gets its own testing row and a test call');
r = await tool(tA(), 'forward_my_number', { carrier: 'Verizon' });
ok(r.ok && /\*71/.test(r.say) && r.data.steps.length === 1, 'forward_my_number gives the exact Verizon code: ' + r.say.slice(0, 80));

// ── 2. Lola collects the port details conversationally and gates on confirmation ──
hits.length = 0;
r = await tool(tA(), 'port_my_number', {});
ok(r.ok && /salon number you want to move/.test(r.say), 'port: first asks for the number: ' + r.say);
r = await tool(tA(), 'port_my_number', { phone_number: '(305) 555-0000' });
ok(r.ok === false && /can’t be moved/.test(r.say) && r.suggestions.includes('forward_my_number'), 'an unportable number is caught right away, forwarding offered');
r = await tool(tA(), 'port_my_number', { phone_number: '(305) 555-0111', carrier: 'AT&T' });
ok(/name on the phone account/.test(r.say) && /authorizing/.test(r.say), 'then asks for exactly two missing things: ' + r.say);
r = await tool(tA(), 'port_my_number', { entity_name: 'MMA Salon LLC', auth_person_name: 'Meddy Jerome' });
ok(/account number/.test(r.say) && /PIN/.test(r.say), 'then the account number and PIN: ' + r.say);
r = await tool(tA(), 'port_my_number', { account_number: '99887766', pin: '4321', street: '1500 Alton Rd', city: 'Miami Beach', state: 'fl', zip: '33139' });
ok(/phone bill/.test(r.say), 'then a recent bill: ' + r.say);
r = await tool(tA(), 'port_my_number', { bill_url: 'https://files.example.com/bill.pdf' });
ok(r.needs_confirmation === true && /authorize LolaDesk/.test(r.say) && !hits.some((h) => /\/porting_orders$/.test(h.u)), 'complete details → a preview needing confirmation; no order created yet');
let row = T.tenant_number_ports.find((x) => x.tenant_id === A);
ok(row && /^v1:/.test(row.pin_enc) && decrypt(row.pin_enc) === '4321' && !JSON.stringify(row).includes('"4321"') && row.account_pin == null && row.account_number == null, 'the PIN is stored only encrypted (no plaintext column)');
ok(/^v1:/.test(row.account_number_enc) && decrypt(row.account_number_enc) === '99887766' && !JSON.stringify(row).includes('99887766'), 'the carrier account number is stored only encrypted');

// ── 3. portStart: documented create → PATCH details → documents → confirm ──
hits.length = 0;
r = await tool(tA(), 'port_my_number', { confirmed: true });
const iCreate = hits.findIndex((h) => h.m === 'POST' && /\/porting_orders$/.test(h.u));
const iDetails = hits.findIndex((h) => h.m === 'PATCH' && /\/porting_orders\/po-1$/.test(h.u) && h.body?.end_user);
const iDocs = hits.findIndex((h) => h.m === 'POST' && /\/documents$/.test(h.u));
const iDocPatch = hits.findIndex((h) => h.m === 'PATCH' && /\/porting_orders\/po-1$/.test(h.u) && h.body?.documents);
const iConfirm = hits.findIndex((h) => /\/actions\/confirm$/.test(h.u));
ok(r.ok && /Sent!/.test(r.say), 'port submitted, owner told in plain words: ' + r.say);
ok(iCreate >= 0 && iCreate < iDetails && iDetails < iDocs && iDocs < iDocPatch && iDocPatch < iConfirm, `sequence create(${iCreate}) → details(${iDetails}) → documents(${iDocs},${iDocPatch}) → confirm(${iConfirm})`);
ok(hits.findIndex((h) => /\/portability_checks$/.test(h.u)) < iCreate, 'portability check runs first');
const created = hits[iCreate].body, det = hits[iDetails].body;
ok(JSON.stringify(created.phone_numbers) === '["+13055550111"]' && created.customer_reference === 'tenant:' + A, 'order: the salon number + tenant reference');
ok(det.end_user.admin.entity_name === 'MMA Salon LLC' && det.end_user.admin.auth_person_name === 'Meddy Jerome' && det.end_user.admin.account_number === '99887766' && det.end_user.admin.pin_passcode === '4321' && det.end_user.admin.billing_phone_number === '+13055550111', 'end_user.admin carries entity/auth person/account/PIN/BTN');
ok(det.end_user.location.street_address === '1500 Alton Rd' && det.end_user.location.locality === 'Miami Beach' && det.end_user.location.administrative_area === 'FL' && det.end_user.location.postal_code === '33139' && det.end_user.location.country_code === 'US', 'end_user.location = the billing address');
ok(det.phone_number_configuration?.connection_id === 'texml-lola' && det.phone_number_configuration?.messaging_profile_id === 'mp-1' && det.webhook_url === 'https://www.loladesk.com/api/telecom-webhook', 'the ported number lands routed to Lola, events come to the signed webhook');
const docUploads = hits.filter((h) => h.m === 'POST' && /\/documents$/.test(h.u));
ok(docUploads.some((h) => h.body.url === 'https://files.example.com/bill.pdf') && docUploads.some((h) => h.body.file && h.body.filename === 'loa.pdf') && hits.some((h) => /loa_template\?loa_configuration_id=loa-cfg-1/.test(h.u)), 'bill uploaded from its URL; LOA generated from the LOA configuration and uploaded');
ok(hits[iDocPatch].body.documents.invoice && hits[iDocPatch].body.documents.loa, 'documents.loa + documents.invoice attached to the order');
row = T.tenant_number_ports.find((x) => x.tenant_id === A);
ok(row.status === 'submitted' && row.telnyx_order_id === 'po-1' && !row.metadata.bill && T.usage_events.some((e) => e.tenant_id === A && e.kind === 'cost_port'), 'row submitted, no copy of the bill kept, cost_port logged');
r = await tool(tA(), 'port_status');
ok(r.ok && /1–2 weeks/.test(r.say) && !/po-1/.test(JSON.stringify(r)), 'port_status: plain words, no ids: ' + r.say);

// exception → owner told exactly what's wrong
state.portStatus = 'exception';
r = await E.portStatus(tA());
ok(/PIN or passcode is wrong/.test(r.say), 'a carrier exception is explained in plain words: ' + r.say);
ok(hits.some((h) => /\/v2\/messages$/.test(h.u) && h.body.to === '+17865550001' && /snag/.test(h.body.text)), 'the owner is texted about the snag once');

// ── 4. Completion via the signed webhook: number swapped to Lola, connection_id patched, owner texted ──
state.portStatus = 'ported'; hits.length = 0;
r = await run('telecom-webhook.js', { body: { data: { id: 'ev-1', event_type: 'porting_order.status_changed', payload: { id: 'po-1', customer_reference: 'tenant:' + A, status: { value: 'ported' } } } } });
ok(r.status === 200 && r.received === true, 'webhook acknowledged');
const pnPatch = hits.find((h) => h.m === 'PATCH' && /\/phone_numbers\/pn-port$/.test(h.u));
ok(pnPatch?.body?.connection_id === 'texml-lola', 'ported number pointed at Lola: PATCH /phone_numbers/{id} {connection_id}');
ok(hits.some((h) => h.m === 'PATCH' && /\/phone_numbers\/pn-port\/messaging$/.test(h.u) && h.body.messaging_profile_id === 'mp-1'), 'ported number linked to the messaging profile');
const ported = T.tenant_numbers.find((x) => x.phone_number === '+13055550111'), old = T.tenant_numbers.find((x) => x.phone_number === '+13055550100');
ok(ported?.tenant_id === A && ported.kind === 'primary' && old.kind === 'secondary' && old.status === 'active', 'ported number is the primary line; the old Lola number stays as secondary');
ok(tA().phone_number === '+13055550111', 'tenant phone_number is the ported number');
const sms = hits.find((h) => /\/v2\/messages$/.test(h.u));
ok(sms && sms.body.to === '+17865550001' && sms.body.from === '+13055550111' && /now answered by Lola/.test(sms.body.text), 'owner texted: ' + (sms && sms.body.text));
ok(T.tenant_number_ports.find((x) => x.tenant_id === A).status === 'ported', 'port row completed');
hits.length = 0;
await run('telecom-webhook.js', { body: { data: { id: 'ev-2', event_type: 'porting_order.status_changed', payload: { id: 'po-1', customer_reference: 'tenant:' + A } } } });
ok(!hits.some((h) => /\/v2\/messages$/.test(h.u)), 'a replayed completion event never texts twice');
const forged = await E.handleTelecomEvent({ data: { event_type: 'porting_order.status_changed', payload: { id: 'po-1', customer_reference: 'tenant:' + B } } });
ok(forged.handled === false && forged.reason === 'tenant-mismatch', 'an event naming another salon is ignored');

// ── 5. 10DLC PRIVATE_PROFIT: Lola collects, previews, then brand → campaign ──
hits.length = 0;
r = await tool(tA(), 'register_texting', {});
ok(/legal name/.test(r.say) && /EIN/.test(r.say), 'texting: asks for legal name + EIN: ' + r.say);
r = await tool(tA(), 'register_texting', { legal_name: 'MMA Salon LLC', ein: '12-3456789' });
ok(/street/.test(r.say) && /city/.test(r.say), 'then the address: ' + r.say);
r = await tool(tA(), 'register_texting', { street: '1500 Alton Rd', city: 'Miami Beach', state: 'FL', zip: '33139', email: 'hello@mmasalon.com', website: 'mmasalon.com' });
ok(r.needs_confirmation === true && /EIN ending 6789/.test(r.say) && !hits.some((h) => /\/10dlc\/brand$/.test(h.u)), 'preview before anything is registered: ' + r.say);
let comp = T.tenant_compliance.find((x) => x.tenant_id === A);
ok(/^v1:/.test(comp.ein_enc) && decrypt(comp.ein_enc) === '123456789' && !JSON.stringify(comp).includes('123456789'), 'EIN stored only encrypted');
r = await tool(tA(), 'register_texting', { confirmed: true });
const brandReq = hits.find((h) => h.m === 'POST' && /\/10dlc\/brand$/.test(h.u))?.body;
ok(brandReq && brandReq.entityType === 'PRIVATE_PROFIT' && brandReq.companyName === 'MMA Salon LLC' && brandReq.ein === '123456789' && brandReq.displayName === 'MMA Salon' && brandReq.country === 'US' && brandReq.email === 'hello@mmasalon.com' && brandReq.vertical && brandReq.postalCode === '33139' && brandReq.website === 'https://mmasalon.com' && brandReq.webhookURL === 'https://www.loladesk.com/api/telecom-webhook', 'brand: the salon’s OWN PRIVATE_PROFIT brand with documented fields');
const camp = hits.find((h) => /\/10dlc\/campaignBuilder$/.test(h.u))?.body;
ok(camp && camp.brandId === 'B1' && camp.usecase === 'MIXED' && JSON.stringify(camp.subUsecases) === '["CUSTOMER_CARE","ACCOUNT_NOTIFICATION"]', 'campaign: MIXED (care + appointment notifications) on the salon’s brand');
ok([camp.sample1, camp.sample2, camp.sample3].every((s) => /^MMA Salon:/.test(s) && /STOP/.test(s)) && /HELP/.test(camp.sample1) && /STOP/.test(camp.helpMessage), 'samples carry the salon name and STOP/HELP language');
ok(camp.subscriberOptin === true && camp.subscriberOptout === true && camp.subscriberHelp === true && camp.optinKeywords === 'START,UNSTOP' && /^STOP,/.test(camp.optoutKeywords) && camp.helpKeywords === 'HELP,INFO' && /book/.test(camp.messageFlow), 'opt-in/out/help keywords match /api/telnyx-sms; message flow says how clients opt in');
comp = T.tenant_compliance.find((x) => x.tenant_id === A);
ok(comp.brand_id === 'B1' && comp.campaign_id === 'C-B1' && comp.campaign_status === 'TCR_PENDING' && ['cost_10dlc_brand', 'cost_10dlc_campaign_month'].every((k) => T.usage_events.some((e) => e.tenant_id === A && e.kind === k)), 'brand + campaign tracked in tenant_compliance; costs logged');
r = await tool(tA(), 'texting_status');
ok(/carriers for review/.test(r.say) && /keep going out/.test(r.say), 'texting never blocks; status explains: ' + r.say);

// ── 6. Campaign approved (10DLC webhook) → the salon's numbers are assigned ──
state.campaignStatus = 'MNO_PROVISIONED'; hits.length = 0;
r = await run('telecom-webhook.js', { body: { data: { event_type: '10dlc.campaign.update', payload: { campaignId: 'C-B1', brandId: 'B1', type: 'MNO_REVIEW', status: 'ACCEPTED' } } } });
const assigns = hits.filter((h) => h.m === 'POST' && /\/10dlc\/phone_number_campaigns$/.test(h.u)).map((h) => h.body);
ok(assigns.length === 2 && assigns.every((a) => a.campaignId === 'C-B1') && assigns.some((a) => a.phoneNumber === '+13055550111') && assigns.some((a) => a.phoneNumber === '+13055550100'), 'both salon lines assigned with {phoneNumber, campaignId}');
comp = T.tenant_compliance.find((x) => x.tenant_id === A);
ok(comp.numbers.length === 2 && comp.numbers.every((n) => n.status === 'ASSIGNED'), 'assignmentStatus tracked (PENDING → ASSIGNED via GET /10dlc/phone_number_campaigns/{phoneNumber})');
r = await tool(tA(), 'texting_status');
ok(/approved by the carriers/.test(r.say), 'owner hears it’s approved: ' + r.say);

// ── 7. Sole proprietor: no EIN → brand → SMS OTP → verify → CUSTOMER_CARE campaign ──
const tB = T.tenants.find((t) => t.id === B); hits.length = 0;
r = await tool(tB, 'register_texting', { ein: 'no EIN' });
ok(/first name/.test(r.say) && /last name/.test(r.say), 'no EIN → sole proprietor questions: ' + r.say);
r = await tool(tB, 'register_texting', { first_name: 'Ana', last_name: 'Diaz', mobile: '786-555-0002', street: '10 Ocean Dr', city: 'Miami Beach', state: 'FL', zip: '33139', email: 'ana@glow.com' });
ok(r.needs_confirmation === true && /sole proprietor/.test(r.say), 'sole-prop preview: ' + r.say);
r = await tool(tB, 'register_texting', { confirmed: true });
const sb = hits.find((h) => h.m === 'POST' && /\/10dlc\/brand$/.test(h.u))?.body;
ok(sb && sb.entityType === 'SOLE_PROPRIETOR' && sb.firstName === 'Ana' && sb.lastName === 'Diaz' && sb.mobilePhone === '+17865550002' && !sb.ein && !sb.companyName, 'sole-prop brand: names + mobile, no EIN');
const otp = hits.find((h) => h.m === 'POST' && /\/10dlc\/brand\/B2\/smsOtp$/.test(h.u))?.body;
ok(otp && /@OTP_PIN@/.test(otp.pinSms) && otp.successSms && /code/.test(r.say), 'OTP triggered (pinSms + successSms): ' + r.say);
ok(!hits.some((h) => /campaignBuilder/.test(h.u)) && T.tenant_compliance.find((x) => x.tenant_id === B).otp_reference === 'otp-ref-1', 'no campaign until the owner verifies');
r = await tool(tB, 'verify_texting_code', { code: '123 456' });
const put = hits.find((h) => h.m === 'PUT' && /\/10dlc\/brand\/B2\/smsOtp$/.test(h.u));
const sc = hits.find((h) => /campaignBuilder/.test(h.u))?.body;
ok(put?.body?.otpPin === '123456' && sc && sc.usecase === 'CUSTOMER_CARE' && !sc.subUsecases && sc.brandId === 'B2' && /^Glow Studio:/.test(sc.sample1), 'code verified (PUT otpPin) → CUSTOMER_CARE campaign: ' + r.say);

// ── 8. get_number: free platform number offered first, only taken after confirmation ──
const tC = T.tenants.find((t) => t.id === C); hits.length = 0;
r = await tool(tC, 'get_number', {});
ok(r.needs_confirmation === true && /\(305\) 555-0999/.test(r.say) && /included/.test(r.say) && !hits.some((h) => h.m === 'PATCH' || /number_orders/.test(h.u)), 'preview offers the free platform number; nothing attached yet: ' + r.say);
r = await tool(tC, 'get_number', { confirmed: true, phone_number: r.data.phone_number });
ok(r.ok && T.tenant_numbers.some((x) => x.tenant_id === C && x.phone_number === '+13055550999' && x.kind === 'primary') && !hits.some((h) => /number_orders/.test(h.u)), 'confirmed → pool number attached (no purchase), routing row created');
ok(T.usage_events.some((e) => e.tenant_id === C && e.kind === 'cost_number_month'), 'cost_number_month logged');
r = await tool(tC, 'setup_status');
ok(r.ok && /\(305\) 555-0999/.test(r.say) && r.data.next === 'register_texting' && !/pn-|mp-1|texml/.test(JSON.stringify(r)), 'setup_status: plain words + next step: ' + r.say);

// ── 9. /api/setup (owner of THIS salon) ──
r = await run('setup.js', { method: 'GET', headers: { authorization: 'Bearer tok-owner' } });
ok(r.status === 200 && r.ok && r.telecom.line.number === '(305) 555-0111' && !/po-1|B1|C-B1|v1:/.test(JSON.stringify(r)), 'GET /api/setup: the salon’s own progress, no ids or secrets');
r = await run('setup.js', { method: 'GET', headers: {} });
ok(r.status === 401, '/api/setup needs sign-in');

// ── 10. Lock-down: platform telecom controls are admin-only ──
hits.length = 0;
r = await run('telecom.js', { method: 'GET', headers: { authorization: 'Bearer tok-owner' }, query: { action: 'numbers.list' } });
ok(r.status === 403, '/api/telecom refuses a salon owner: ' + r.status);
r = await run('telnyx-numbers.js', { method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'buy', phone_number: '+13055550777' } });
ok(r.status === 403 && !hits.some((h) => /number_orders/.test(h.u)), 'telnyx-numbers buy refuses a salon owner (nothing ordered)');
r = await run('telnyx-numbers.js', { method: 'POST', headers: {}, body: { action: 'buy', phone_number: '+13055550777' } });
ok(r.status === 401 && !hits.some((h) => /number_orders/.test(h.u)), 'telnyx-numbers buy refuses anonymous callers');
r = await run('telecom.js', { method: 'GET', headers: { authorization: 'Bearer tok-admin' }, query: { action: 'numbers.list' } });
ok(r.status === 200 && r.ok, 'an admin still reaches /api/telecom');

// ── 11. /api/admin/telecom: refuses non-admins; the registry for admins ──
r = await run('admin/telecom.js', { method: 'GET', headers: { authorization: 'Bearer tok-owner' } });
ok(r.status === 403, '/api/admin/telecom refuses a salon owner');
r = await run('admin/telecom.js', { method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
const regA = r.tenants?.find((t) => t.tenant.id === A);
ok(r.status === 200 && regA && regA.ports[0].telnyx_order_id === 'po-1' && regA.ports[0].status === 'ported' && regA.texting.campaign_id === 'C-B1' && regA.texting.numbers.length === 2, 'registry: Telnyx order + 10DLC ids/status per salon');
ok(regA.costs.cost_port === 1 && regA.costs.cost_10dlc_brand === 1 && regA.costs.cost_10dlc_campaign_month === 1 && r.totals.cost_number_month >= 2, 'registry: this month’s cost ledger per salon + totals');
ok(regA.numbers.some((n) => n.phone_number === '+13055550100' && n.drift.length === 0) && regA.numbers.some((n) => n.phone_number === '+13055550111' && n.drift.includes('not_on_telnyx_account')), 'registry: Telnyx connection drift per number');
ok(!/v1:|4321|99887766|123456789/.test(JSON.stringify(r)) && regA.ports[0].has_pin === true && regA.texting.has_ein === true, 'registry never leaks PINs, account numbers or EINs');
r = await run('admin/telecom.js', { method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: { action: 'resync', tenant_id: A } });
ok(r.status === 200 && r.ok && r.tenant?.tenant?.id === A, 'admin resync works');
r = await run('admin/telecom.js', { method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'resync', tenant_id: A } });
ok(r.status === 403, 'owners can’t run admin actions');

// ── 12. Cron: CRON_SECRET-gated bounded sync ──
r = await run('cron/telecom-sync.js', { method: 'GET', headers: {} });
ok(r.status === 503 || r.status === 401, 'cron refuses without the secret');
process.env.CRON_SECRET = 'cs';
r = await run('cron/telecom-sync.js', { method: 'GET', headers: { authorization: 'Bearer cs' } });
ok(r.status === 200 && r.ok && typeof r.texting === 'number', 'cron syncs open ports + pending 10DLC: ' + JSON.stringify(r));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
