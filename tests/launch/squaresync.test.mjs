// Square, Marketplace-grade: Lola sees EVERY booking in the salon's Square (named: client, service, stylist),
// a cancelled Square booking frees the chair, changes arrive by signed webhook the moment they happen, tokens
// are renewed every ≤7 days, a disconnect revokes LolaDesk's access, a revoked connection is flagged and the
// owner told — and stylists/services match themselves by name.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SQUARE_ENV = 'production';
process.env.SQUARE_APP_ID = 'sq0idp-app'; process.env.SQUARE_APP_SECRET = 'sq0csp-secret'; process.env.APP_URL = 'https://www.loladesk.com';
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'whk-secret'; process.env.SENDGRID_API_KEY = 'sg'; process.env.EMAIL_FROM = 'lola@loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const S = { token: 'tok-1', refreshOk: true, refreshed: 0, revoked: [], rate: 0, scopes: null, mails: [],
  bookings: [
    { id: 'B1', version: 1, status: 'ACCEPTED', start_at: soon(26), customer_id: 'C1', appointment_segments: [{ duration_minutes: 90, service_variation_id: 'V-BAL', team_member_id: 'TM-ANA' }] },
    { id: 'B2', version: 2, status: 'CANCELLED_BY_CUSTOMER', start_at: soon(28), customer_id: 'C2', appointment_segments: [{ duration_minutes: 60, service_variation_id: 'V-CUT', team_member_id: 'TM-BO' }] },
    { id: 'B3', version: 1, status: 'ACCEPTED', start_at: soon(30), customer_id: 'C2', appointment_segments: [{ duration_minutes: 30, service_variation_id: 'V-OLD', team_member_id: 'TM-BO' }] },
  ] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...h } });
  if (u.includes('api.sendgrid.com')) { S.mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  if (!u.startsWith('https://connect.squareup.com')) return J({ data: [] });
  const path = u.replace('https://connect.squareup.com', ''); const body = init.body ? JSON.parse(init.body) : {};
  if (path === '/oauth2/token') { S.refreshed++; if (!S.refreshOk) return J({ errors: [{ code: 'UNAUTHORIZED' }] }, 401); S.token = 'tok-' + (S.refreshed + 1); return J({ access_token: S.token, refresh_token: body.refresh_token, expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }); }
  if (path === '/oauth2/revoke') { S.revoked.push({ auth: init.headers.Authorization, body }); return J({ success: true }); }
  if ((init.headers?.Authorization || '') !== 'Bearer ' + S.token) return J({ errors: [{ code: S.revokedCode || 'UNAUTHORIZED', detail: 'nope' }] }, 401);
  if (path === '/oauth2/token/status') return J({ scopes: S.scopes || ['MERCHANT_PROFILE_READ', 'APPOINTMENTS_READ', 'APPOINTMENTS_WRITE', 'CUSTOMERS_READ', 'CUSTOMERS_WRITE', 'ITEMS_READ'], expires_at: soon(600), merchant_id: 'M-MMA' });
  if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE', name: 'MMA Salon — Miami Beach', timezone: 'America/New_York', business_name: 'MMA Salon' }] });
  if (path.startsWith('/v2/bookings?')) { if (S.rate-- > 0) return J({ errors: [{ code: 'RATE_LIMITED' }] }, 429, { 'retry-after': '0' }); return J({ bookings: S.bookings }); }
  if (path === '/v2/customers/bulk-retrieve') return J({ responses: Object.fromEntries(body.customer_ids.map((id) => [id, { customer: id === 'C1' ? { id, given_name: 'Ana', family_name: 'Lopez', phone_number: '+13055551111' } : { id, given_name: 'Mia', family_name: 'Chen' } }])) });
  if (path === '/v2/catalog/search-catalog-items') return J({ items: [
    { id: 'I1', item_data: { name: "Women's Haircut", variations: [{ id: 'V-CUT', version: 7, item_variation_data: { name: 'Regular', service_duration: 3600000 } }] } },
    { id: 'I2', item_data: { name: 'Balayage', variations: [{ id: 'V-BAL', version: 3, item_variation_data: { name: 'Balayage', service_duration: 10800000 } }] } }] });
  if (path === '/v2/catalog/batch-retrieve') return J({ objects: [{ id: 'V-OLD', type: 'ITEM_VARIATION', item_variation_data: { item_id: 'I-OLD', name: 'Regular' } }], related_objects: [{ id: 'I-OLD', type: 'ITEM', item_data: { name: 'Bang Trim' } }] });
  if (path.startsWith('/v2/bookings/team-member-booking-profiles')) return J({ team_member_booking_profiles: [{ team_member_id: 'TM-ANA', display_name: 'Ana Ruiz', is_bookable: true }, { team_member_id: 'TM-BO', display_name: 'Bo Lee', is_bookable: true }, { team_member_id: 'TM-ZED', display_name: 'Zed Park', is_bookable: true }] });
  return J({ errors: [{ code: 'NOT_FOUND', detail: path }] }, 404);
};
const { T } = await import('./fake-supabase.mjs');
const TID = '55555555-5555-4555-8555-555555555555';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', owner_email: 'owner@mmasalon.com' }];
for (const k of ['bookings', 'clients', 'usage_events', 'provider_mappings', 'cached_availability', 'booking_sync_log', 'calendar_sync_jobs', 'tenant_numbers', 'booking_settings']) T[k] = [];
T.staff = [{ id: 'st-ana', tenant_id: TID, name: 'Ana Ruiz', is_active: true }, { id: 'st-bo', tenant_id: TID, name: 'Bo', is_active: true }];
T.services = [{ id: 'sv-bal', tenant_id: TID, name: 'Balayage', is_active: true }, { id: 'sv-cut', tenant_id: TID, name: "Women's Haircut", is_active: true }, { id: 'sv-x', tenant_id: TID, name: 'Keratin', is_active: true }];
const { encrypt, decrypt } = await import('../../api/lib/crypto.js');
const row = () => T.integrations.find((i) => i.id === 'int-sq');
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok-1'), refresh_token: encrypt('r-1'), expires_at: soon(25 * 24), metadata: { merchant_id: 'M-MMA', tz: 'America/New_York' } }];
const P = new URL('../../api/', import.meta.url).href;
const SQ = await import(P + 'lib/connectors/square.js');
const live = () => ({ ...row(), access_token: decrypt(row().access_token), refresh_token: decrypt(row().refresh_token) });

// ── Permissions: seller-level, least privilege ──
const auth = SQ.getAuthUrl('st');
ok(['APPOINTMENTS_ALL_READ', 'APPOINTMENTS_ALL_WRITE', 'APPOINTMENTS_BUSINESS_SETTINGS_READ', 'EMPLOYEES_READ'].every((s) => auth.includes(s)) && /session=false/.test(auth) && /PAYMENTS_READ/.test(auth) && !/PAYMENTS_WRITE|ORDERS_WRITE|BANK|PAYOUTS_WRITE/.test(auth), 'connect asks for seller-level bookings + team + business settings + read-only sales — never to move money');

// ── Every booking, named; cancelled frees the chair; rate limits ridden out ──
S.rate = 1;
const apps = await SQ.listAppointments(live(), {});
const b1 = apps.find((a) => a.id === 'B1'), b2 = apps.find((a) => a.id === 'B2'), b3 = apps.find((a) => a.id === 'B3');
ok(apps.length === 3, 'Square said “slow down” (429) once → retried, nothing lost');
ok(b1.client.name === 'Ana Lopez' && b1.service === 'Balayage' && b1.stylist_name === 'Ana Ruiz' && b1.client.phone === '+13055551111', 'a Square booking arrives named: Ana Lopez · Balayage · with Ana Ruiz');
ok(b3.service === 'Bang Trim', 'a service since removed from the menu still has its name');
ok(b2.status === 'cancelled', 'cancelled by the client in Square → cancelled in LolaDesk (the chair is free again)');
const { syncTenantAvailability } = await import(P + 'lib/booking-sync.js');
const { db } = await import(P + 'lib/db.js');
await syncTenantAvailability(db(), TID, { provider: 'square', legacy: true });
const cached = T.cached_availability.find((r) => r.external_booking_id === 'B1');
ok(cached && cached.client_name === 'Ana Lopez' && cached.service === 'Balayage', 'the salon’s calendar shows who and what, not “Customer 1a2b3c · Service”');
ok(T.cached_availability.find((r) => r.external_booking_id === 'B2')?.status === 'cancelled', 'and the cancelled one doesn’t block time');
const { externalAppointments } = await import(P + 'calendar-owner.js');
const ext = await externalAppointments(db(), TID, new Date().toISOString(), soon(48));
ok(ext.some((x) => x.client_name === 'Ana Lopez' && x.service === 'Balayage') && !ext.some((x) => x.external_booking_id === 'B2'), 'the Bookings screen shows “Ana Lopez · Balayage · Square”, and not the cancelled one');

// ── Stylists + services match themselves ──
const map = await SQ.autoMap(live());
const m = (type, local) => T.provider_mappings.find((x) => x.entity_type === type && x.local_id === local)?.external_id;
ok(m('staff', 'st-ana') === 'TM-ANA' && m('staff', 'st-bo') === 'TM-BO' && map.staff.unmatched.includes('Zed Park'), 'stylists matched by name (Ana Ruiz, Bo → Bo Lee); Zed Park reported, never invented');
ok(m('service', 'sv-bal') === 'V-BAL' && m('service', 'sv-cut') === 'V-CUT' && map.services.unmatched.includes('Keratin'), 'services matched by name; Keratin (not in Square) reported');
T.provider_mappings.find((x) => x.local_id === 'st-ana').external_id = 'TM-MANUAL';
await SQ.autoMap(live());
ok(m('staff', 'st-ana') === 'TM-MANUAL', 'a mapping the owner set by hand is never overwritten');

// ── Tokens renewed every ≤7 days ──
let f = await SQ.keepFresh(live());
ok(!f.refreshed && S.refreshed === 0, 'a token renewed 5 days ago is left alone');
row().expires_at = soon(20 * 24);
f = await SQ.keepFresh(live());
ok(f.refreshed && decrypt(row().access_token) === S.token && Date.parse(row().expires_at) > Date.now() + 29 * 864e5, 'older than 6 days → renewed and saved (Square: renew every 7 days or less)');

// ── Daily check: permissions, location, flags ──
const { squareDaily, handleSquareEvent } = await import(P + 'lib/square-care.js');
row().metadata = { merchant_id: 'M-MMA' };
let d = await squareDaily(db());
ok(d.checked === 1 && row().metadata.missing_scopes.includes('APPOINTMENTS_ALL_READ') && d.missing_scopes === 1, 'a salon connected before this update is flagged “reconnect once” (missing seller-level access)');
ok(row().metadata.location_id === 'L1' && row().metadata.tz === 'America/New_York' && row().metadata.location_name, 'its Square location and time zone are filled in');
S.scopes = SQ.SCOPE_LIST;
d = await squareDaily(db());
ok(row().metadata.missing_scopes.length === 0, 'reconnected with full access → the flag clears');

// ── Signed webhooks ──
const hook = (await import(P + 'square-webhook.js')).default;
const { webhookUrl } = await import(P + 'square-webhook.js');
const send = (ev, sig) => new Promise((resolve) => {
  const raw = JSON.stringify(ev);
  const s = sig ?? crypto.createHmac('sha256', 'whk-secret').update(webhookUrl() + raw).digest('base64');
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
  hook({ method: 'POST', headers: { 'x-square-hmacsha256-signature': s }, rawBody: raw }, res).then(() => resolve(res));
});
let r = await send({ event_id: 'e0', type: 'booking.created', merchant_id: 'M-MMA' }, 'forged');
ok(r.statusCode === 403, 'a webhook without Square’s signature is refused');
S.bookings.push({ id: 'B4', version: 0, status: 'ACCEPTED', start_at: soon(40), customer_id: 'C1', appointment_segments: [{ duration_minutes: 60, service_variation_id: 'V-CUT', team_member_id: 'TM-BO' }] });
r = await send({ event_id: 'e1', type: 'booking.created', merchant_id: 'M-MMA', data: { type: 'booking', id: 'B4' } });
ok(r.statusCode === 200 && T.cached_availability.some((x) => x.external_booking_id === 'B4' && x.client_name === 'Ana Lopez'), 'a booking made in Square reaches LolaDesk the moment Square says so (signed webhook)');
S.bookings.find((b) => b.id === 'B4').status = 'CANCELLED_BY_SELLER';
r = await send({ event_id: 'e2', type: 'booking.updated', merchant_id: 'M-MMA' });
ok(T.cached_availability.find((x) => x.external_booking_id === 'B4')?.status === 'cancelled', 'cancelled in Square → the time opens up in LolaDesk right away');
ok((await handleSquareEvent(db(), { event_id: 'e2', type: 'booking.updated', merchant_id: 'M-MMA' })).duplicate, 'the same event delivered twice is handled once');
ok((await handleSquareEvent(db(), { event_id: 'e3', type: 'booking.created', merchant_id: 'M-OTHER' })).ignored, 'another Square account’s event never touches this salon');

// ── Revoked in Square → flagged, owner told, busy time kept ──
S.mails.length = 0;
r = await send({ event_id: 'e4', type: 'oauth.authorization.revoked', merchant_id: 'M-MMA' });
ok(row().status === 'revoked' && S.mails.some((x) => /Reconnect/.test(JSON.stringify(x))), 'salon disconnects LolaDesk inside Square → marked disconnected, and the owner is told how to reconnect');
ok(T.cached_availability.some((x) => x.external_booking_id === 'B1'), 'their existing Square appointments stay blocked (never a double-booking window)');

// ── Token dies mid-use → flagged once ──
row().status = 'connected'; S.token = 'tok-dead'; S.refreshOk = false; S.mails.length = 0;
let threw = null; try { await SQ.listAppointments(live(), {}); } catch (e) { threw = e; }
ok(threw && threw.code === 'square_auth' && row().status === 'needs_reconnect' && S.mails.length === 1, 'a token Square won’t renew → an error (never “no appointments”), flagged, the owner told once');
try { await SQ.listAppointments(live(), {}); } catch (_) {}
ok(S.mails.length === 1, 'not told twice');

// ── Disconnect = revoke at Square ──
const rv = await SQ.revokeAccess(live());
ok(rv.ok && S.revoked[0].auth === 'Client sq0csp-secret' && S.revoked[0].body.merchant_id === 'M-MMA' && S.revoked[0].body.client_id === 'sq0idp-app', 'Disconnect revokes LolaDesk’s access at Square (Client secret auth, merchant id)');
const fs = await import('node:fs');
ok(/revokeAccess/.test(fs.readFileSync(new URL('../../api/oauth/disconnect.js', import.meta.url), 'utf8')), 'the Settings “Disconnect” uses it');
ok(/state\.provider && state\.provider !== provider/.test(fs.readFileSync(new URL('../../api/oauth/callback.js', import.meta.url), 'utf8')), 'an OAuth code can’t be replayed into another provider’s connection');
const set = fs.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
ok(/disconnectProvider\('square'/.test(set) && /Disconnected in Square/.test(set), 'Settings shows the real Square status (connected / reconnect / disconnected) and lets the owner disconnect');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
