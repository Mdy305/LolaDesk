/**
 * tests/inventory.test.mjs — products + blocked slots + appointment notes.
 *
 * Run:
 *   node tests/inventory.test.mjs
 *   node --test tests/
 *
 * Drives the REAL /api/salon handler against the in-memory fake Supabase and
 * proves the 20260901_inventory_ops.sql schema actually carries the three
 * tables salon.js always assumed existed: products (with stock and
 * low_stock_alert), blocked_slots (per-staff breaks honored by availability
 * and booking), and appointment_notes (activity notes on bookings). Also
 * asserts the products read derives a real low_stock list instead of the
 * hardcoded [] it returned before the migration landed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/inventory.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

const { default: handler } = await import('../api/salon.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const ST1 = '22222222-2222-2222-2222-222222222222';
const CL1 = '33333333-3333-3333-3333-333333333333';

function seed() {
  fake.reset();
  fake.seed('tenants', [{ id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon.com', phone_number: '+15550001000' }]);
  fake.seed('staff', [{ id: ST1, tenant_id: T1, name: 'Maya', role: 'Stylist', is_active: true }]);
  fake.seed('services', [{ id: 'sv-1', tenant_id: T1, name: 'Balayage', duration_minutes: 90, price: 220, is_active: true }]);
  fake.seed('clients', [{ id: CL1, tenant_id: T1, first_name: 'Ana', last_name: 'Rios', name: 'Ana Rios', phone: '+13055550123' }]);
  fake.seed('products', [
    { id: 'p-1', tenant_id: T1, name: 'Olaplex No.3', brand: 'Olaplex', category: 'Hair care', sku: 'OLA-3', price: 28, cost: 12, stock: 2, low_stock_alert: 5, is_active: true },
    { id: 'p-2', tenant_id: T1, name: 'Kevin Murphy Shine', brand: 'Kevin Murphy', category: 'Hair care', sku: 'KM-SH', price: 34, cost: 16, stock: 0, low_stock_alert: 4, is_active: true },
    { id: 'p-3', tenant_id: T1, name: 'Moroccanoil Treatment', brand: 'Moroccanoil', category: 'Hair care', sku: 'MO-TR', price: 42, cost: 20, stock: 18, low_stock_alert: 3, is_active: true },
    { id: 'p-4', tenant_id: T1, name: 'Retired Wax', brand: 'Wax Co', category: 'Wax', sku: 'WX-1', price: 9, cost: 3, stock: 30, low_stock_alert: 10, is_active: false }
  ]);
  fake.auth.users.set('tok-owner', { id: 'u1', email: 'owner@salon.com' });
}
function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {}, status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}
function getReq(query) {
  return { method: 'GET', query, headers: { authorization: 'Bearer tok-owner' }, body: {}, url: '/api/salon' };
}
function postReq(body) {
  return { method: 'POST', query: {}, headers: { authorization: 'Bearer tok-owner', 'content-type': 'application/json' }, body: JSON.stringify(body), url: '/api/salon' };
}

test('products read derives real low_stock (active only, stock <= alert)', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq({ resource: 'products' }), res);
  assert.equal(out.code, 200);
  const names = out.body.products.map(p => p.name);
  assert.deepEqual(names, ['Kevin Murphy Shine', 'Moroccanoil Treatment', 'Olaplex No.3'], 'active products only, ordered by name');
  assert.deepEqual(out.body.low_stock.map(p => p.name), ['Kevin Murphy Shine', 'Olaplex No.3'], 'stock 0 and stock 2 both at/below alert');
  assert.ok(!out.body.low_stock.some(p => p.name === 'Moroccanoil Treatment'), 'healthy stock not flagged');
  assert.ok(!out.body.products.some(p => p.name === 'Retired Wax'), 'inactive product excluded');
});

test('owner can create a product with stock fields persisted', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(postReq({ resource: 'product', name: 'Color Wow Dream Coat', brand: 'Color Wow', category: 'Styling', sku: 'CW-DC', price: 32, cost: 14, stock: 6, low_stock_alert: 2 }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  const saved = fake.all('products').find(p => p.name === 'Color Wow Dream Coat');
  assert.ok(saved, 'row persisted');
  assert.equal(saved.stock, 6);
  assert.equal(saved.low_stock_alert, 2);
  assert.equal(saved.price, 32);
  assert.equal(saved.sku, 'CW-DC');
});

test('owner can restock (update stock only keeps fields)', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(postReq({ resource: 'product', id: 'p-1', name: 'Olaplex No.3', brand: 'Olaplex', category: 'Hair care', sku: 'OLA-3', price: 28, cost: 12, stock: 12, low_stock_alert: 5 }), res);
  assert.equal(out.code, 200);
  const p = fake.all('products').find(x => x.id === 'p-1');
  assert.equal(p.stock, 12, 'restocked');
  assert.equal(p.low_stock_alert, 5);
});

test('owner can deactivate a product (soft delete)', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(postReq({ resource: 'product', action: 'delete', id: 'p-1' }), res);
  assert.equal(out.code, 200);
  const p = fake.all('products').find(x => x.id === 'p-1');
  assert.equal(p.is_active, false);
});

test('blocked slot creation persists and availability honors it', async () => {
  seed();
  const [res1, out1] = makeRes();
  await handler(postReq({ resource: 'block', staff_id: ST1, date: '2026-09-10', start_time: '12:00', end_time: '13:00', reason: 'Lunch' }), res1);
  assert.equal(out1.code, 200);
  assert.equal(out1.body.ok, true);
  const bl = fake.all('blocked_slots').find(b => b.blocked_date === '2026-09-10');
  assert.ok(bl, 'blocked_slots row persisted');
  assert.equal(bl.reason, 'Lunch');

  const [res2, out2] = makeRes();
  await handler(getReq({ resource: 'availability', date: '2026-09-10', service_id: 'sv-1', staff_id: ST1 }), res2);
  assert.equal(out2.code, 200);
  const slots = out2.body.slots || [];
  const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const mins = slots.map(s => toMin(s.time));
  assert.ok(!mins.some(m => m >= 720 && m < 780), 'no slot offered inside the blocked 12:00–13:00 lunch');
  assert.ok(mins.some(m => m >= 780), 'slots after the block still offered');
  assert.equal(out2.body.duration, 90);
});

test('booking a slot inside a blocked window is refused', async () => {
  seed();
  const [res1] = makeRes();
  await handler(postReq({ resource: 'block', staff_id: ST1, date: '2026-09-11', start_time: '10:00', end_time: '11:00', reason: 'Meeting' }), res1);
  const [res2, out2] = makeRes();
  await handler(postReq({
    resource: 'appointment', client_id: CL1, staff_id: ST1,
    date: '2026-09-11', start_time: '10:00', service_ids: ['sv-1'], channel: 'dashboard'
  }), res2);
  assert.equal(out2.code, 200);
  assert.equal(out2.body.ok, false);
  assert.equal(out2.body.conflict, true, 'booking inside a staff block is refused');
});

test('appointment note write lands in appointment_notes', async () => {
  seed();
  const [res1] = makeRes();
  await handler(postReq({
    resource: 'appointment', client_id: CL1, staff_id: ST1,
    date: '2026-09-12', start_time: '14:00', service_ids: ['sv-1'], channel: 'dashboard'
  }), res1);
  const booking = fake.all('bookings')[0];
  assert.ok(booking, 'booking created');
  const [res2, out2] = makeRes();
  await handler(postReq({ resource: 'note', booking_id: booking.id, content: 'Prefers the window seat; allergic to lavender.', author: 'Ana' }), res2);
  assert.equal(out2.code, 200);
  assert.equal(out2.body.ok, true);
  const note = fake.all('appointment_notes')[0];
  assert.ok(note, 'appointment_notes row persisted');
  assert.equal(note.booking_id, booking.id);
  assert.equal(note.content, 'Prefers the window seat; allergic to lavender.');
  assert.equal(note.tenant_id, T1);
});

test('unauthenticated request is refused (401)', async () => {
  seed();
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: { resource: 'products' }, headers: {}, body: {}, url: '/api/salon' }, res);
  assert.equal(out.code, 401);
});
