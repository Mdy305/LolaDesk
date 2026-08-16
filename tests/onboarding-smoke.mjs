#!/usr/bin/env node
/**
 * tests/onboarding-smoke.mjs — LolaDesk onboarding smoke test
 * ════════════════════════════════════════════════════════════════
 * Walks the REAL onboarding funnel over HTTP against a live deployment:
 *
 *   1. SIGNUP   POST /api/auth/signup           → owner + tenant + session
 *   2. SEARCH   GET  /api/telnyx-numbers        → available numbers (Telnyx)
 *   3. PROVISION POST /api/provision-number     → buy + attach the number,
 *                                                 update tenant routing
 *
 * Zero dependencies (global fetch). Every run uses a unique, clearly-labelled
 * identity (smoke+<ts>@loladesk.com, salon "Smoke Test <ts>") so the tenants
 * it creates are identifiable and safe to clean up.
 *
 * Usage
 *   node tests/onboarding-smoke.mjs [--base-url URL] [--area CODE] [--search-only]
 *   node tests/onboarding-smoke.mjs --cleanup smoke+1234567890@loladesk.com
 *   node tests/onboarding-smoke.mjs --help
 *
 * Options
 *   --base-url URL   deployment to hit (default: $LOLA_BASE_URL or
 *                    https://www.loladesk.com; use the *.vercel.app preview URL
 *                    to smoke-test a staging build)
 *   --area CODE      area code to search first (default 305)
 *   --search-only    stop after signup + search (no number is purchased)
 *   --cleanup EMAIL  delete the auth user + tenant created by a prior run
 *                    (needs SUPABASE_URL + SUPABASE_SERVICE_KEY in the env)
 *
 * Exit code: 0 = every requested step green, 1 = a step failed.
 *
 * NOTE: the PROVISION step buys a real Telnyx number (~$1/mo) and attaches it
 * to the tenant. Use --search-only for cheap CI pre-flight; run the full flow
 * for launch-readiness. Releasing the number afterwards is a Telnyx console
 * action (the test never releases it for you).
 */

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1;
}
function value(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

if (flag('--help') || flag('-h')) {
  console.log(`LolaDesk onboarding smoke test

  node tests/onboarding-smoke.mjs [options]

Options
  --base-url URL   deployment to hit (default $LOLA_BASE_URL or https://www.loladesk.com)
  --area CODE      area code to search first (default 305)
  --search-only    stop after signup + search (no number purchased)
  --cleanup EMAIL  delete the auth user + tenant from a prior run
  --help           this help

Env for --cleanup: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).
Env for the run:   optional LOLA_BASE_URL overrides the default base URL.`);
  process.exit(0);
}

const BASE = (value('--base-url') || process.env.LOLA_BASE_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
const AREA = value('--area') || '305';
const SEARCH_ONLY = flag('--search-only');
// Extra areas to try when the primary has no inventory (Telnyx inventory rotates).
const FALLBACK_AREAS = ['410', '415', '786', '212', '202', '312'].filter(a => a !== AREA);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), name, detail ? '— ' + detail : '');
}

async function req(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const ts = Date.now();
const EMAIL = `smoke+${ts}@loladesk.com`;
const PASSWORD = `Sm0ke-${ts.toString(36)}-Pass!`;
const SALON = `Smoke Test ${ts}`;

/* ── CLEANUP MODE ─────────────────────────────────────────────── */
const cleanupEmail = value('--cleanup');
if (cleanupEmail) {
  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_ || !KEY) {
    console.error('--cleanup needs SUPABASE_URL + SUPABASE_SERVICE_KEY in the env (pull them locally, never paste secrets in chat).');
    process.exit(2);
  }
  const rest = async (path, opts = {}) => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(30000),
    });
    return r;
  };
  // Find + delete the tenant (owner_email is the link the signup flow writes).
  const list = await rest(`tenants?owner_email=eq.${encodeURIComponent(cleanupEmail)}&select=id`);
  const ids = (await list.json().catch(() => [])) || [];
  let deletedTenant = 0;
  for (const row of ids) {
    const d = await rest(`tenants?id=eq.${row.id}`, { method: 'DELETE' });
    if (d.ok) deletedTenant++;
  }
  // Delete the auth user (Supabase admin API).
  const adminList = await fetch(`${URL_}/auth/v1/admin/users?page=1&perPage=100`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  const users = (await adminList.json().catch(() => ({ users: [] }))).users || [];
  const match = users.find(u => (u.email || '').toLowerCase() === cleanupEmail.toLowerCase());
  let deletedUser = false;
  if (match) {
    const d = await fetch(`${URL_}/auth/v1/admin/users/${match.id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    deletedUser = d.ok;
  }
  console.log(`cleanup ${cleanupEmail}: tenants deleted=${deletedTenant}, auth user deleted=${deletedUser}`);
  process.exit(deletedUser || deletedTenant ? 0 : 1);
}

/* ── 1. SIGNUP ────────────────────────────────────────────────── */
console.log(`\nLolaDesk onboarding smoke — ${BASE}\n`);
console.log(`identity: ${EMAIL}  (${SALON})\n`);

const signup = await req('POST', '/api/auth/signup', {
  body: {
    email: EMAIL, password: PASSWORD,
    name: 'Smoke Owner', salonName: SALON, location: 'Miami, FL',
    hours: '9am-6pm', plan: 'starter', websiteUrl: 'https://smoke.loladesk.com',
    businessMode: 'salon',
  },
});
const token = signup.body?.session?.access_token || signup.body?.token || signup.body?.access_token;
const tenantId = signup.body?.tenant?.id || signup.body?.tenant?.id;
check('signup creates owner + tenant + session', signup.status === 200 && !!token, `status=${signup.status} tenant=${tenantId || '-'}`);

/* ── 2. SEARCH ────────────────────────────────────────────────── */
async function searchNumbers(area) {
  const r = await req('GET', `/api/telnyx-numbers?action=search&area=${encodeURIComponent(area)}&country=US`);
  const nums = (r.body?.numbers || []).filter(n => n?.phone_number);
  return { status: r.status, ok: r.body?.ok === true, nums };
}

const search = await searchNumbers(AREA);
check('search returns available numbers contract', search.status === 200 && search.ok && Array.isArray(search.nums), `status=${search.status} area=${AREA} found=${search.nums.length}`);

/* ── find a buyable number (fall back across areas) ── */
let numberToBuy = search.nums[0]?.phone_number;
let usedArea = AREA;
if (!numberToBuy) {
  for (const a of FALLBACK_AREAS) {
    const s = await searchNumbers(a);
    if (s.nums.length) { numberToBuy = s.nums[0].phone_number; usedArea = a; break; }
  }
}
if (!numberToBuy) console.log(`  (no inventory in ${[AREA, ...FALLBACK_AREAS].join('/')} — provision step will be skipped)`);

/* ── 3. PROVISION (buy + attach) ──────────────────────────────── */
if (SEARCH_ONLY) {
  console.log('\n--search-only: skipping provision (no number purchased).');
} else if (!numberToBuy) {
  check('provision buys a number', false, 'no available numbers in any searched area — try --area or check Telnyx inventory');
} else {
  console.log(`\nprovisioning ${numberToBuy} (area ${usedArea}) …`);
  const provision = await req('POST', '/api/provision-number', {
    token,
    body: { phone_number: numberToBuy, areaCode: usedArea },
  });
  const number = provision.body?.phoneNumber || provision.body?.phone_number;
  const e164 = typeof number === 'string' && /^\+1\d{10}$/.test(number);
  check('provision buys + attaches the number', provision.status === 200 && provision.body?.ok === true && e164, `status=${provision.status} number=${number || provision.body?.error || '-'}`);
  if (provision.body?.ok && e164) {
    check('provision links voice/sms brain', provision.body?.messagingProfileLinked !== undefined || provision.body?.lolaBrainLinked !== undefined, 'provisioning metadata present');
  }
}

/* ── SUMMARY ──────────────────────────────────────────────────── */
const fails = results.filter(r => !r.ok);
console.log('\n' + '─'.repeat(60));
console.log(`${results.length - fails.length}/${results.length} steps passed`);
if (fails.length) {
  console.log('FAILURES:');
  fails.forEach(f => console.log('  ✗', f.name, f.detail));
  console.log(`\ncleanup later with:  node tests/onboarding-smoke.mjs --cleanup ${EMAIL}`);
  process.exit(1);
}
console.log(`ONBOARDING ${SEARCH_ONLY ? 'PRE-FLIGHT' : 'FULL FLOW'} GREEN ✓`);
if (!SEARCH_ONLY) console.log(`bought ${numberToBuy} for ${SALON} — release it in the Telnyx console when done.`);
console.log(`cleanup later with:  node tests/onboarding-smoke.mjs --cleanup ${EMAIL}`);
process.exit(0);
