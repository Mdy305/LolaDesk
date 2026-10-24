/**
 * tests/staff-access.test.mjs — what a staff sign-in can and can't reach.
 *
 * Run:
 *   node --test tests/staff-access.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import middleware, { staffMayCall, isStaffToken, claims, STAFF_ALLOW } from '../middleware.js';
import { effectiveRole, roleAllows, OWNER } from '../api/lib/team-access.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (meta) => `Bearer ${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email: 'ana@salon.com', app_metadata: meta })}.sig`;
const STAFF = token({ provider: 'email', loladesk_role: 'staff', loladesk_tenant: 't1' });
const OWNER_TOKEN = token({ provider: 'email' });

const req = (path, { method = 'GET', auth = STAFF, body } = {}) =>
  new Request('https://www.loladesk.com' + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('reads the staff tag from the token, and only from app_metadata', () => {
  assert.equal(isStaffToken(STAFF), true);
  assert.equal(isStaffToken(OWNER_TOKEN), false);
  assert.equal(isStaffToken(`Bearer ${b64({})}.${b64({ user_metadata: { loladesk_role: 'staff' } })}.x`), false);
  assert.equal(isStaffToken('Bearer not-a-jwt'), false);
  assert.equal(claims(STAFF).app_metadata.loladesk_tenant, 't1');
});

test('staff keep the day: calendar, clients, calls, messages, checkout', () => {
  for (const [p, m] of [
    ['/api/calendar', 'POST'], ['/api/calendar-owner', 'POST'], ['/api/appointments/create', 'POST'],
    ['/api/clients', 'PATCH'], ['/api/crm-notes', 'POST'], ['/api/call-center/callback', 'POST'],
    ['/api/inbox/messages', 'GET'], ['/api/inbox-reply', 'POST'], ['/api/pos/charge', 'POST'],
    ['/api/services', 'GET'], ['/api/staff', 'GET'], ['/api/auth/session', 'GET'], ['/api/notifications', 'GET'],
  ]) assert.equal(staffMayCall(p, m), true, `${m} ${p}`);
});

test('staff never reach money, the account, the team, bulk data or Lola\'s owner tools', () => {
  for (const [p, m] of [
    ['/api/billing', 'POST'], ['/api/billing', 'GET'], ['/api/stripe/connect/payout-now', 'POST'], ['/api/stripe/payments-refund', 'POST'],
    ['/api/settings', 'POST'], ['/api/provision-number', 'POST'], ['/api/telecom', 'POST'], ['/api/channels', 'POST'],
    ['/api/oauth/connect', 'GET'], ['/api/team-invite', 'POST'], ['/api/staff', 'POST'], ['/api/staff', 'DELETE'],
    ['/api/staff-admin', 'POST'], ['/api/services', 'POST'], ['/api/client-import', 'POST'], ['/api/campaign-send', 'POST'],
    ['/api/marketing', 'POST'], ['/api/knowledge', 'POST'], ['/api/lola', 'POST'], ['/api/voice/session', 'POST'],
    ['/api/deposits', 'GET'], ['/api/revenue/staff', 'GET'], ['/api/widget-embed', 'GET'], ['/api/zapier', 'POST'],
    ['/api/some-route-added-next-year', 'GET'],
  ]) assert.equal(staffMayCall(p, m), false, `${m} ${p}`);
});

test('/api/data: the day\'s data, not revenue, integrations or the team', () => {
  assert.equal(staffMayCall('/api/data', 'GET', { resource: 'calls' }), true);
  assert.equal(staffMayCall('/api/data', 'GET', { resource: '' }), true); // overview
  for (const r of ['revenue', 'integrations', 'team', 'marketing']) assert.equal(staffMayCall('/api/data', 'GET', { resource: r }), false, r);
});

test('/api/salon: bookings and clients yes; the team, the menu and the shop no', () => {
  assert.equal(staffMayCall('/api/salon', 'POST', { resource: 'appointment' }), true);
  assert.equal(staffMayCall('/api/salon', 'POST', { resource: 'client' }), true);
  for (const r of ['staff', 'services', 'products', 'catalog']) assert.equal(staffMayCall('/api/salon', 'POST', { resource: r }), false, r);
  assert.equal(staffMayCall('/api/salon', 'GET', { resource: 'staff' }), true);
});

test('the gate: owners pass untouched, staff get a clear 403', async () => {
  assert.equal(await middleware(req('/api/billing', { method: 'POST', auth: OWNER_TOKEN })), undefined);
  assert.equal(await middleware(req('/api/calendar')), undefined);
  const r = await middleware(req('/api/billing', { method: 'POST' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'owner_only');
  assert.equal(await middleware(new Request('https://www.loladesk.com/api/widget/services')), undefined); // public, no token
});

test('salon writes are judged by the body, not a friendlier query string', async () => {
  const sneaky = await middleware(req('/api/salon?resource=appointment', { method: 'POST', body: { resource: 'staff', action: 'create', name: 'X' } }));
  assert.equal(sneaky?.status, 403);
  assert.equal(await middleware(req('/api/salon', { method: 'POST', body: { resource: 'appointment', action: 'create' } })), undefined);
});

test('the salon\'s own owner email is always the owner, whatever an old row says', () => {
  const access = { tenant: { owner_email: 'M@MMA.com' }, role: 'member' };
  assert.equal(effectiveRole(access, { email: 'm@mma.com' }), 'owner');
  assert.equal(effectiveRole(access, { email: 'ana@mma.com' }), 'member');
  assert.equal(roleAllows(effectiveRole({ tenant: {}, role: 'staff' }, { email: 'x@y.z' }), OWNER), false);
});

test('every allow-list entry is an /api path', () => {
  for (const [p] of STAFF_ALLOW) assert.match(p, /^\/api\//);
});
