/**
 * verify-tenant-routing.mjs — one-shot LIVE inbound-routing round-trip check.
 *
 * For every tenant in production Supabase, confirm the tenant's canonical
 * number round-trips back to that tenant via the SAME resolution order the
 * inbound resolver uses (tenant_numbers → tenants.phone_number → not_found):
 *
 *   ✓ ready          number → this tenant (active route or legacy column)
 *   ✗ resolves-elsewhere   number routes to a DIFFERENT tenant
 *   ✗ disabled       route exists but status != active
 *   ✗ ambiguous      number mapped to more than one tenant
 *   ✗ not_found      no route for the number at all
 *
 * No npm dependencies — talks straight to PostgREST. Secrets never touch the
 * chat: pull them locally and run from the shell.
 *
 *   vercel env pull .env.local --environment=production
 *   set -a; source .env.local; set +a
 *   node verify-tenant-routing.mjs
 *
 * (Or export SUPABASE_URL + SUPABASE_SERVICE_KEY any way you like.)
 * Exits 1 if any tenant that owns a number fails to round-trip.
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error('\nMissing env vars. Pull them locally (keeps secrets out of chat):\n');
  console.error('  vercel env pull .env.local --environment=production');
  console.error('  set -a; source .env.local; set +a');
  console.error('  node verify-tenant-routing.mjs\n');
  process.exit(2);
}

function e164(num) {
  if (!num) return null;
  const cleaned = String(num).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  if (cleaned.length === 10) return '+1' + cleaned;
  return cleaned.startsWith('+') ? cleaned : '+' + cleaned;
}

async function rest(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const tenantsResp = await rest('tenants?select=id,name,slug,phone_number&order=name.asc');
if (tenantsResp.status !== 200) {
  console.error(`✗ could not read tenants: HTTP ${tenantsResp.status}`, tenantsResp.data);
  process.exit(2);
}
const tenants = Array.isArray(tenantsResp.data) ? tenantsResp.data : [];

// tenant_numbers may not exist yet (migration not applied). That's a
// safe pre-migration state — the resolver falls back to tenants.phone_number.
const routesResp = await rest('tenant_numbers?select=tenant_id,phone_number,kind,status');
const migrationApplied = routesResp.status === 200;
if (!migrationApplied) {
  console.log(`\n⚠  tenant_numbers table not found (HTTP ${routesResp.status}) — migration ` +
    `migrations/20260815_tenant_number_routing.sql has NOT been applied yet.\n` +
    `   Falling back to the legacy tenants.phone_number column for this check.\n`);
}
const routes = Array.isArray(routesResp.data) ? routesResp.data : [];

// number -> routes (defensive: UNIQUE should make this 1, but detect dupes)
const byNumber = new Map();
for (const r of routes) {
  const p = e164(r.phone_number);
  if (!p) continue;
  if (!byNumber.has(p)) byNumber.set(p, []);
  byNumber.get(p).push(r);
}

const tenantById = new Map(tenants.map(t => [t.id, t]));
const phoneOwnerCount = new Map();
for (const t of tenants) {
  const p = e164(t.phone_number);
  if (!p) continue;
  phoneOwnerCount.set(p, (phoneOwnerCount.get(p) || 0) + 1);
}

function verdict(t) {
  const number = e164(t.phone_number);
  if (!number) return { ready: false, status: 'no-number-assigned', source: null };

  const rs = byNumber.get(number) || [];
  if (rs.length > 1) return { ready: false, status: 'ambiguous', source: 'tenant_numbers' };

  if (rs.length === 1) {
    const r = rs[0];
    if (r.status && r.status !== 'active')
      return { ready: false, status: 'disabled', source: `tenant_numbers:${r.status}` };
    if (r.tenant_id !== t.id)
      return { ready: false, status: 'resolves-elsewhere', source: 'tenant_numbers' };
    return { ready: true, status: 'resolved', source: 'tenant_numbers' };
  }

  // No routing row → legacy fallback (resolver's getTenantByPhoneStrict).
  const owners = phoneOwnerCount.get(number) || 0;
  if (owners > 1) return { ready: false, status: 'ambiguous', source: 'tenants.phone_number' };
  if (owners === 1) return { ready: true, status: 'resolved', source: 'tenants.phone_number' };
  return { ready: false, status: 'not_found', source: null };
}

const rows = tenants.map(t => ({ tenant: t, ...verdict(t) }));
const pad = (s, n) => String(s).padEnd(n);

console.log(`\nLolaDesk inbound-routing round-trip — ${tenants.length} tenant(s)\n`);
console.log(pad('TENANT', 28) + pad('STATUS', 22) + pad('SOURCE', 22) + 'NUMBER');
console.log('-'.repeat(95));
let failed = 0, noNumber = 0;
for (const { tenant, ready, status, source, number } of rows) {
  const mark = ready ? '✓ ready' : '✗ ' + status;
  if (!ready && status !== 'no-number-assigned') failed++;
  if (status === 'no-number-assigned') noNumber++;
  console.log(
    pad((tenant.name || tenant.slug || tenant.id || '').slice(0, 27), 28) +
    pad(mark, 22) +
    pad(source || '-', 22) +
    (number || '-')
  );
}
console.log('-'.repeat(95));

const routable = rows.length - noNumber;
console.log(
  `\n${routable - failed}/${routable} tenants with a number round-trip correctly` +
  (noNumber ? ` (${noNumber} tenant(s) have no number yet)` : '') + '\n'
);

if (failed > 0) {
  console.log('✗ FAIL — at least one live tenant does not route back to itself.');
  console.log('  Fix in the Supabase SQL editor (run migrations/20260815_tenant_number_routing.sql)');
  console.log('  or the admin number dashboard (POST /api/admin/numbers), then re-run.\n');
  process.exit(1);
}
console.log('✓ PASS — every provisioned number routes to exactly one live tenant.\n');
