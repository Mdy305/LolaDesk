/**
 * api/lib/setup/telecom.js — every salon's phone line and business texting, set up by Lola.
 * ════════════════════════════════════════════════════════════════════════════════════════
 * One engine, three transports: Lola's setup tools (./telecom-tools.js), the owner's
 * /api/setup endpoint, and the admin registry (/api/admin/telecom). Webhooks
 * (/api/telecom-webhook) and the cron (/api/cron/telecom-sync) keep it current.
 *
 *   lineOptions(tenant)                  what the salon can do right now, in plain words
 *   getNumber(tenant, {areaCode,confirmed}) free platform number first, else search → buy
 *   forwarding(tenant, {carrier,salonNumber,test})  keep the salon number, Lola catches misses
 *   portCheck / portStart / portSync     bring the salon's number to Lola (full Telnyx flow)
 *   textingRegister / textingVerifyCode / textingSync   the salon's OWN 10DLC brand + campaign
 *   setupProgress(tenant)                one object for the UI and for Lola
 *   handleTelecomEvent(event)            porting_order.* and 10DLC status webhooks
 *
 * Rules: the salon only ever sees plain words (no ids, no Telnyx jargon) — raw detail lives in
 * the rows the admin registry reads. Everything is included in the salon's plan; every cost
 * LolaDesk pays is logged (usage_events cost_*). PINs, carrier account numbers and EINs are
 * stored only encrypted (AES-256-GCM, lib/crypto.js); without INTEGRATION_ENCRYPTION_KEY they
 * are sent to Telnyx and never stored. Telnyx calls use only documented endpoints/fields
 * (skills/telnyx-porting-in-curl, telnyx-10dlc-curl + references, numbers-compliance).
 */
import { db, e164, logUsage, upsertTenantNumber } from '../db.js';
import { telnyxRequest, telnyxData, appUrl } from '../telnyx-client.js';
import { encrypt, decrypt } from '../crypto.js';
import { sendSms } from '../sms.js';
import { invalidateRouting } from '../tenant-resolver.js';
import { ensureTelecomSchema } from '../migrate.js';
import { forwardingPlan, forwardingStatus, startForwardingTest, CARRIERS } from '../forwarding.js';
import {
  freePlatformNumbers, attachOwnedNumberForTenant, provisionNumberForTenant, searchNumbers,
  linkVoiceConnection, linkMessagingProfile, getCanonicalVoiceConnectionId,
} from '../telnyx-provision.js';

// ── small helpers ─────────────────────────────────────────────────────────────
const digits = (n) => String(n || '').replace(/\D/g, '');
export function pretty(n) {
  const d = digits(n).replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || '');
}
const phone10 = (n) => { const d = digits(n).replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '+1' + d : null; };
const nowIso = () => new Date().toISOString();
const clean = (v) => (v == null ? '' : String(v).trim());
const errMsg = (e) => String(e?.message || e || 'unknown error').slice(0, 400);
const webhookUrl = () => appUrl() + '/api/telecom-webhook';
const safe = async (p, fb = null) => { try { return await p; } catch (_) { return fb; } };
async function cost(tenantId, kind, units = 1, meta = {}) { try { await logUsage(tenantId, kind, units, meta); } catch (_) {} }

/** Encrypt a secret, or null when no key is configured (the caller then never stores it). */
export function seal(v) {
  if (v == null || v === '') return null;
  try { return encrypt(String(v)); } catch (_) { return null; }
}
export function unseal(v) {
  if (!v) return null;
  if (!/^v1:/.test(String(v))) return null;   // never treat a stray plaintext value as a secret we hold
  try { return decrypt(v); } catch (_) { return null; }
}

async function client() { const c = db(); if (c) await safe(ensureTelecomSchema()); return c; }

async function freshTenant(c, tenant) {
  if (!c || !tenant?.id) return tenant;
  const { data } = await safe(c.from('tenants').select('*').eq('id', tenant.id).maybeSingle(), { data: null }) || {};
  return data ? { ...tenant, ...data } : tenant;
}

/** The salon's live Lola lines (never released ones), primary first. */
export async function tenantLines(c, tenant) {
  const out = [];
  try {
    const { data } = await c.from('tenant_numbers').select('*').eq('tenant_id', tenant.id).limit(20);
    for (const r of (data || [])) if (r?.phone_number && r.status !== 'released') out.push({ phone_number: r.phone_number, kind: r.kind || 'primary', status: r.status || 'active' });
  } catch (_) {}
  if (tenant.phone_number && !out.some((r) => r.phone_number === tenant.phone_number)) out.push({ phone_number: tenant.phone_number, kind: 'primary', status: 'active' });
  return out.sort((a, b) => (a.kind === 'primary' ? -1 : 0) - (b.kind === 'primary' ? -1 : 0));
}

async function ownedByAnotherSalon(c, tenantId, number) {
  const n = e164(number); if (!c || !n) return false;
  const [a, b] = await Promise.all([
    safe(c.from('tenant_numbers').select('tenant_id,status').eq('phone_number', n).limit(5), { data: [] }),
    safe(c.from('tenants').select('id').eq('phone_number', n).limit(5), { data: [] }),
  ]);
  return (a?.data || []).some((r) => r.tenant_id && r.tenant_id !== tenantId && r.status !== 'released') || (b?.data || []).some((r) => r.id !== tenantId);
}

async function numberRecord(phone) {
  const list = telnyxData(await telnyxRequest('/phone_numbers', { query: { 'filter[phone_number]': phone, 'page[size]': 5 }, timeoutMs: 10000 }));
  return (Array.isArray(list) ? list : []).find((n) => e164(n.phone_number) === phone) || null;
}

function ownerMobile(tenant) { return e164(tenant?.operator_phone || tenant?.owner_phone || tenant?.owner_mobile || '') || null; }
async function textOwner(tenant, text, from = null) {
  const to = ownerMobile(tenant);
  if (!to) return { skipped: true, reason: 'no_owner_phone' };
  return safe(sendSms({ tenantId: tenant.id, tenant, ...(from ? { from } : {}), to, text, skipOptOut: true }), { skipped: true, reason: 'error' });
}

// ═════════════════════════════════════════════════════════════════════════════
// LINE: options, number, forwarding
// ═════════════════════════════════════════════════════════════════════════════

/** What the salon can do right now, in plain words. */
export async function lineOptions(tenant) {
  const c = await client();
  const t = await freshTenant(c, tenant);
  const lines = c ? await tenantLines(c, t) : (t.phone_number ? [{ phone_number: t.phone_number, kind: 'primary' }] : []);
  const fwd = c ? await forwardingStatus(c, t.id) : [];
  const port = c ? await latestPort(c, t.id) : null;
  const verified = fwd.find((r) => r.status === 'verified');
  const testing = fwd.find((r) => r.status === 'testing');
  const portOpen = port && !['ported', 'cancelled', 'not_portable'].includes(port.status);
  const options = [];
  if (!lines.length) {
    options.push({ id: 'get_number', say: 'Get Lola her own number — I can do it right now, it’s included in your plan.' });
    options.push({ id: 'port_my_number', say: 'Move your existing salon number to Lola (takes about 1–3 weeks; your phone keeps working the whole time).' });
  } else {
    if (!verified) options.push({ id: 'forward_my_number', say: `Keep your salon number and forward missed calls to Lola at ${pretty(lines[0].phone_number)} — takes about 2 minutes.` });
    if (!portOpen && !(port && port.status === 'ported')) options.push({ id: 'port_my_number', say: 'Or move your salon number to Lola for good, so she answers it directly.' });
  }
  return {
    has_number: lines.length > 0,
    number: lines[0] ? pretty(lines[0].phone_number) : null,
    numbers: lines.map((l) => ({ number: pretty(l.phone_number), role: l.kind === 'primary' ? 'main' : 'extra' })),
    forwarding: verified ? 'verified' : testing ? 'testing' : 'not_set_up',
    forwarding_from: verified ? pretty(verified.account_id) : testing ? pretty(testing.account_id) : null,
    port: port ? portSummary(port) : null,
    options,
  };
}

/**
 * Give the salon a Lola number. Free platform-pool numbers first (already paid for), else a
 * search → buy. Nothing is attached or bought until confirmed === true (preview otherwise).
 */
export async function getNumber(tenant, { areaCode = '', confirmed = false, phoneNumber = null, additional = false, temporary = false } = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now — try again in a minute.' };
  const t = await freshTenant(c, tenant);
  const lines = await tenantLines(c, t);
  if (lines.length && !additional && !temporary) return { ok: true, already: true, number: pretty(lines[0].phone_number), say: `You already have your Lola number: ${pretty(lines[0].phone_number)}. She’s answering it.` };
  const area = /^\d{3}$/.test(clean(areaCode)) ? clean(areaCode) : '';
  const wanted = phoneNumber ? phone10(phoneNumber) : null;

  // 1) Free platform numbers (no salon uses them).
  const pool = await safe(freePlatformNumbers(), []) || [];
  let pick = null, source = null;
  if (wanted) { pick = pool.find((n) => n.phone_number === wanted); source = pick ? 'platform_pool' : 'purchase'; }
  else {
    pick = (area ? pool.find((n) => digits(n.phone_number).slice(1, 4) === area) : pool[0]) || null;
    source = pick ? 'platform_pool' : 'purchase';
  }
  let candidate = pick?.phone_number || wanted || null;
  if (!candidate) {
    try { candidate = (await searchNumbers(area))[0]?.phone_number || null; }
    catch (e) { return { ok: false, say: area ? `I couldn’t find a free number in area code ${area}. Want me to try a nearby area code?` : 'I couldn’t find a number right now. Tell me an area code you’d like and I’ll look again.' }; }
    if (!candidate) return { ok: false, say: 'I couldn’t find a number right now — tell me an area code and I’ll look again.' };
  }
  if (await ownedByAnotherSalon(c, t.id, candidate)) return { ok: false, say: 'That number already belongs to another salon. Let me find you a different one — any area code you prefer?' };

  if (confirmed !== true) {
    return { ok: true, needs_confirmation: true, number: pretty(candidate), phone_number: candidate, source,
      say: `I found ${pretty(candidate)} for you${area ? ` in area code ${area}` : ''}. It’s included in your plan — want me to make it Lola’s number?` };
  }

  try {
    let result;
    if (source === 'platform_pool') result = await attachOwnedNumberForTenant(t, candidate);
    else result = await provisionNumberForTenant(t, { requestedNumber: candidate, areaCode: area });
    await cost(t.id, 'cost_number_month', 1, { phone_number: result.phoneNumber, source, temporary: !!temporary });
    await safe((async () => { const { ensureBookingBaseline } = await import('../booking-seed.js'); return ensureBookingBaseline(t.id); })());
    // Already registered for business texting? Put the new line on the salon's campaign too.
    await safe(assignNumbersIfApproved(c, { ...t, phone_number: result.phoneNumber }));
    return { ok: true, number: pretty(result.phoneNumber), phone_number: result.phoneNumber, source,
      say: temporary ? `Done — ${pretty(result.phoneNumber)} is Lola’s number while we move yours over. She’s answering it now.` : `Done! ${pretty(result.phoneNumber)} is Lola’s number. Call it — she’s answering right now.` };
  } catch (e) {
    const m = errMsg(e);
    console.warn('[setup/telecom] getNumber:', m);
    if (/not enough credit|insufficient/i.test(m)) return { ok: false, error: m, say: 'Something on our side needs a top-up before I can add this number. I’ve flagged it for the LolaDesk team — I’ll let you know as soon as it’s done.' };
    return { ok: false, error: m, say: 'I couldn’t set that number up just now. Try again in a minute, or ask me for a different number.' };
  }
}

/** Keep the salon's number: the exact forwarding codes, an optional live test, and the status. */
export async function forwarding(tenant, { carrier = '', salonNumber = '', test = false } = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now — try again in a minute.' };
  const t = await freshTenant(c, tenant);
  const lines = await tenantLines(c, t);
  const lola = lines[0]?.phone_number || null;
  if (!lola) return { ok: false, needs: 'number', say: 'Lola needs her own number first so your calls have somewhere to go. Want me to get her one now? It’s included.' };
  const key = String(carrier || '').toLowerCase().replace(/[^a-z]/g, '');
  const carrierKey = /verizon/.test(key) ? 'verizon' : /tmobile|metro/.test(key) ? 'tmobile' : /att|cricket/.test(key) ? 'att' : key ? 'landline' : null;
  const plan = carrierKey ? forwardingPlan(lola, carrierKey) : null;
  let testResult = null;
  if (test && salonNumber) testResult = await startForwardingTest(c, { ...t, phone_number: lola }, salonNumber);
  const status = await forwardingStatus(c, t.id);
  const verified = status.find((r) => r.status === 'verified');
  let say;
  if (testResult) say = testResult.say;
  else if (verified) say = `Forwarding is working — missed calls to ${pretty(verified.account_id)} go to Lola.`;
  else if (!plan) say = `Who’s your salon phone carrier — AT&T, T-Mobile, Verizon, or a landline/business line? I’ll give you the exact code to dial so missed calls go to Lola at ${pretty(lola)}.`;
  else if (!plan.ok) say = plan.error;
  else {
    const steps = plan.steps.map((s) => s.dial ? `${s.when}: dial ${s.dial}` : s.portal).join('. ');
    say = `On your salon phone (${plan.carrier}): ${steps}. ${plan.note} When you’re done, tell me your salon number and I’ll call it to test.`;
  }
  return { ok: testResult ? !!testResult.ok : true, say, plan: plan && plan.ok ? plan : null, carriers: Object.fromEntries(Object.entries(CARRIERS).map(([k, v]) => [k, v.name])),
    forwarding: verified ? 'verified' : status.some((r) => r.status === 'testing') ? 'testing' : 'not_set_up' };
}

// ═════════════════════════════════════════════════════════════════════════════
// PORTING — bring the salon's number to Lola
// ═════════════════════════════════════════════════════════════════════════════

const PORT_DONE = new Set(['ported', 'cancelled', 'not_portable']);
const EXCEPTION_WORDS = {
  ACCOUNT_NUMBER_MISMATCH: 'the account number doesn’t match what your phone company has — it’s printed on your phone bill',
  AUTH_PERSON_MISMATCH: 'the authorized person’s name doesn’t match the account — use the exact name on the phone account',
  BTN_ATN_MISMATCH: 'the main billing phone number on the account doesn’t match — check the number printed at the top of your phone bill',
  ENTITY_NAME_MISMATCH: 'the business name doesn’t match the phone account — use the name exactly as it appears on your phone bill',
  FOC_EXPIRED: 'the transfer date expired — I’ll ask for a new date',
  FOC_REJECTED: 'your phone company rejected the transfer date — I’ll ask for a new one',
  LOCATION_MISMATCH: 'the service address doesn’t match the phone account — use the address on your phone bill',
  LSR_PENDING: 'your phone company is still reviewing the request',
  MAIN_BTN_PORTING: 'this is the main number on your account, so your phone company needs to know what happens to the other lines on the account',
  OSP_IRRESPONSIVE: 'your current phone company hasn’t answered yet — we’re chasing them',
  OTHER: 'your phone company needs something else — the LolaDesk team is on it',
  PASSCODE_PIN_INVALID: 'the account PIN or passcode is wrong — your phone company can give you the port-out PIN',
  PHONE_NUMBER_HAS_SPECIAL_FEATURE: 'the number has a special feature on it (like a hunt group or DSL) that your phone company needs removed first',
  PHONE_NUMBER_MISMATCH: 'the phone number doesn’t match the account',
  PHONE_NUMBER_NOT_PORTABLE: 'this number can’t be moved',
  PORT_TYPE_INCORRECT: 'the transfer type needs correcting — the LolaDesk team is on it',
  PORTING_ORDER_SPLIT_REQUIRED: 'the request needs splitting into parts — the LolaDesk team is on it',
  POSTAL_CODE_MISMATCH: 'the ZIP code doesn’t match the phone account — use the ZIP on your phone bill',
  RATE_CENTER_NOT_PORTABLE: 'this number’s area can’t be moved to us yet',
  SV_CONFLICT: 'there’s a conflict with another transfer request for this number',
  SV_UNKNOWN_FAILURE: 'the carrier hit an unknown error — the LolaDesk team is on it',
};
const STATUS_WORDS = {
  collecting: 'I’m gathering the details to move your number.',
  needs_documents: 'I need one more thing before I can send the transfer request.',
  draft: 'I’m getting the transfer paperwork ready.',
  submitted: 'The transfer request is with your current phone company — usually 1–2 weeks. Your phone keeps working normally until then.',
  'in-process': 'The transfer request is with your current phone company — usually 1–2 weeks. Your phone keeps working normally until then.',
  'foc-date-confirmed': 'Your phone company approved it — the move date is locked in.',
  exception: 'Your phone company pushed back on something.',
  'cancel-pending': 'The transfer is being cancelled.',
  cancelled: 'The transfer was cancelled.',
  ported: 'Done — your number now rings Lola.',
  not_portable: 'That number can’t be moved to Lola.',
  failed: 'I couldn’t send the transfer request.',
};

function portSummary(row) {
  const st = row.status || 'collecting';
  let say = STATUS_WORDS[st] || STATUS_WORDS.submitted;
  if (st === 'foc-date-confirmed' && row.foc_date) say = `Your phone company approved it — your number moves to Lola on ${new Date(row.foc_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`;
  if (st === 'exception') {
    const ex = (Array.isArray(row.exceptions) ? row.exceptions : []).map((x) => EXCEPTION_WORDS[x.code] || x.description).filter(Boolean);
    say = ex.length ? `Your phone company pushed back: ${ex.join('; ')}. Tell me the corrected details and I’ll resend it.` : say;
  }
  if (st === 'needs_documents' && row.metadata?.missing?.length) say = `To send the transfer I still need ${row.metadata.missing.join(' and ')}.`;
  if (st === 'collecting' && row.metadata?.missing?.length) say = `To move your number I still need ${row.metadata.missing.slice(0, 2).join(' and ')}.`;
  return { number: pretty(row.requested_phone_number), state: st, say, move_date: row.foc_date || null, temporary_number: row.temporary_phone_number ? pretty(row.temporary_phone_number) : null };
}

async function latestPort(c, tenantId) {
  const { data } = await safe(c.from('tenant_number_ports').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1), { data: [] }) || {};
  return (data || [])[0] || null;
}

/** POST /portability_checks — is this number movable? (documented; returns portable, fast_portable, not_portable_reason) */
export async function portCheck(number) {
  const n = phone10(number);
  if (!n) return { ok: false, portable: false, say: 'That doesn’t look like a US phone number — say all ten digits?' };
  try {
    const d = telnyxData(await telnyxRequest('/portability_checks', { method: 'POST', body: { phone_numbers: [n] }, timeoutMs: 15000 }));
    const r = (Array.isArray(d) ? d : [d]).find((x) => x && e164(x.phone_number) === n) || (Array.isArray(d) ? d[0] : d) || {};
    if (r.portable === false) return { ok: true, portable: false, fast: false, reason: r.not_portable_reason || null, say: `${pretty(n)} can’t be moved to Lola${r.not_portable_reason ? ` (${String(r.not_portable_reason).toLowerCase()})` : ''}. You can still keep it and forward missed calls to Lola instead.` };
    return { ok: true, portable: true, fast: !!r.fast_portable, say: `Good news — ${pretty(n)} can move to Lola.` };
  } catch (e) {
    // The check is advisory: never block on it.
    return { ok: false, portable: null, error: errMsg(e), say: '' };
  }
}

/** Field requirements to move a number, in the order Lola asks for them (one or two at a time). */
export const PORT_FIELDS = [
  ['phone_number', 'the salon number you want to move'],
  ['entity_name', 'the name on the phone account (business or person, exactly as it is on the bill)'],
  ['auth_person_name', 'the name of the person authorizing the move (you, if you’re on the account)'],
  ['account_number', 'the account number from your phone bill'],
  ['pin', 'the account PIN or port-out passcode (say “none” if there isn’t one)'],
  ['street', 'the service street address on the bill'],
  ['city', 'the city'],
  ['state', 'the state'],
  ['zip', 'the ZIP code'],
  ['bill', 'a recent phone bill (a photo or PDF link — or say you don’t have one)'],
];

/** Merge owner-provided details (never secrets in clear) into the salon's draft port row. */
export async function portDraft(tenant, input = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now — try again in a minute.' };
  const t = await freshTenant(c, tenant);
  let row = await latestPort(c, t.id);
  if (row && !['collecting', 'needs_documents', 'failed', 'draft', 'exception', 'not_portable', 'cancelled', 'ported'].includes(row.status)) return { ok: true, row, in_flight: true };
  if (row && ['not_portable', 'cancelled', 'ported'].includes(row.status)) row = null;
  const n = input.phone_number ? phone10(input.phone_number) : null;
  if (input.phone_number && !n) return { ok: false, say: 'That doesn’t look like a US phone number — can you say all ten digits?' };
  if (!row && !n) return { ok: true, row: null, missing: ['phone_number'] };
  if (n && (await ownedByAnotherSalon(c, t.id, n))) return { ok: false, say: 'That number is already used by another salon on LolaDesk, so I can’t move it here. If it’s really yours, contact LolaDesk support.' };
  if (n) {
    const { data: others } = await safe(c.from('tenant_number_ports').select('tenant_id,status').eq('requested_phone_number', n).limit(10), { data: [] }) || {};
    if ((others || []).some((o) => o.tenant_id !== t.id && !PORT_DONE.has(o.status))) return { ok: false, say: 'Another salon already has a transfer open for that number. If it’s really yours, contact LolaDesk support.' };
  }
  const patch = { updated_at: nowIso() };
  if (n) patch.requested_phone_number = n;
  const txt = (k, col = k) => { if (clean(input[k])) patch[col] = clean(input[k]); };
  txt('entity_name'); txt('auth_person_name', 'authorized_contact_name'); txt('carrier', 'current_carrier');
  txt('street', 'billing_street'); txt('city', 'billing_city');
  if (clean(input.state)) patch.billing_state = clean(input.state).toUpperCase().slice(0, 2);
  if (clean(input.zip)) patch.billing_zip = digits(input.zip).slice(0, 5);
  if (clean(input.billing_phone_number)) patch.billing_phone_number = phone10(input.billing_phone_number);
  if (clean(input.email)) patch.authorized_contact_email = clean(input.email);
  const meta = { ...(row?.metadata || {}) };
  // Secrets are stored only encrypted. Without the key they're used for this request alone (never
  // stored) and the admin registry flags the missing key.
  const secrets = {};
  if (clean(input.account_number)) { const s = seal(clean(input.account_number)); if (s) patch.account_number_enc = s; else { secrets.account_number = clean(input.account_number); meta.secure_storage_missing = true; } meta.account_last4 = digits(input.account_number).slice(-4) || null; }
  if (input.pin !== undefined && clean(input.pin) !== '') {
    const none = /^(none|no|n\/a|na|no pin|-)$/i.test(clean(input.pin));
    if (none) { meta.pin_none = true; patch.pin_enc = null; }
    else { const s = seal(clean(input.pin)); if (s) patch.pin_enc = s; else { secrets.pin = clean(input.pin); meta.secure_storage_missing = true; } meta.pin_none = false; }
  }
  if (meta.secure_storage_missing) patch.last_error = 'INTEGRATION_ENCRYPTION_KEY missing: account number/PIN not stored';
  if (clean(input.bill_url)) { meta.bill = { url: clean(input.bill_url), filename: clean(input.bill_filename) || 'phone-bill.pdf' }; meta.no_bill = false; }
  if (clean(input.bill_base64)) { meta.bill = { base64: clean(input.bill_base64), filename: clean(input.bill_filename) || 'phone-bill.pdf' }; meta.no_bill = false; }
  if (input.no_bill === true) meta.no_bill = true;
  if (clean(input.loa_url)) meta.loa = { url: clean(input.loa_url), filename: clean(input.loa_filename) || 'loa.pdf' };
  if (clean(input.loa_base64)) meta.loa = { base64: clean(input.loa_base64), filename: clean(input.loa_filename) || 'loa.pdf' };
  if (input.temporary_number !== undefined) meta.temporary_number = input.temporary_number === true;
  patch.metadata = meta;
  if (row) {
    await c.from('tenant_number_ports').update(patch).eq('id', row.id).eq('tenant_id', t.id);
    row = { ...row, ...patch };
  } else {
    const ins = { tenant_id: t.id, status: 'collecting', created_at: nowIso(), ...patch };
    const { data } = await c.from('tenant_number_ports').insert(ins).select().maybeSingle();
    row = data || ins;
  }
  const missing = portMissing(row, secrets);
  return { ok: true, row, missing, secrets };
}

export function portMissing(row, secrets = {}) {
  if (!row) return ['phone_number'];
  const m = row.metadata || {};
  const has = {
    phone_number: !!row.requested_phone_number,
    entity_name: !!clean(row.entity_name),
    auth_person_name: !!clean(row.authorized_contact_name),
    account_number: !!(row.account_number_enc || secrets.account_number),
    pin: !!(row.pin_enc || secrets.pin || m.pin_none),
    street: !!clean(row.billing_street), city: !!clean(row.billing_city), state: /^[A-Z]{2}$/.test(clean(row.billing_state)), zip: /^\d{5}$/.test(clean(row.billing_zip)),
    bill: !!(m.bill || m.no_bill),
  };
  return PORT_FIELDS.map(([k]) => k).filter((k) => !has[k]);
}
export function portNeedSay(row, missing) {
  if (row?.metadata?.secure_storage_missing && missing.some((k) => k === 'account_number' || k === 'pin')) {
    return 'Everything else is saved. For your security I only keep account numbers and PINs in our encrypted vault, and it isn’t switched on yet — I’ve flagged the LolaDesk team and we’ll finish this with you shortly.';
  }
  return `To move your number I still need ${portAsk(missing).join(' and ')}.`;
}
export const portAsk = (missing) => missing.slice(0, 2).map((k) => (PORT_FIELDS.find(([f]) => f === k) || [k, k])[1]);

/** Upload one document (POST /documents: url, or base64 file + filename). Returns its id. */
async function uploadDocument(doc, ref) {
  const body = { customer_reference: ref };
  if (doc.url) { body.url = doc.url; if (doc.filename) body.filename = doc.filename; }
  else if (doc.base64) { body.file = doc.base64.replace(/^data:[^;]+;base64,/, ''); body.filename = doc.filename || 'document.pdf'; }
  else return null;
  const d = telnyxData(await telnyxRequest('/documents', { method: 'POST', body, timeoutMs: 30000 }));
  return d?.id || null;
}

/** The LOA Telnyx generates for this order from the platform's LOA configuration (GET /porting_orders/{id}/loa_template). */
async function generatedLoa(orderId) {
  let cfg = process.env.TELNYX_LOA_CONFIGURATION_ID || null;
  if (!cfg) {
    const list = telnyxData(await safe(telnyxRequest('/porting/loa_configurations', { timeoutMs: 10000 }), { data: [] }));
    cfg = (Array.isArray(list) ? list[0]?.id : null) || null;
  }
  if (!cfg) return null;
  const r = await fetch(`https://api.telnyx.com/v2/porting_orders/${encodeURIComponent(orderId)}/loa_template?loa_configuration_id=${encodeURIComponent(cfg)}`, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return null;
  return { base64: buf.toString('base64'), filename: 'loa.pdf' };
}

const orderIdsOf = (row) => {
  const list = Array.isArray(row?.telnyx_order_ids) ? row.telnyx_order_ids : [];
  return [...new Set([row?.telnyx_order_id, ...list].filter(Boolean))];
};
const statusOf = (o) => String((o?.status && typeof o.status === 'object' ? o.status.value : o?.status) || '').toLowerCase() || null;
const exceptionsOf = (o) => (o?.status && Array.isArray(o.status.details) ? o.status.details : []).map((d) => ({ code: d.code || 'OTHER', description: d.description || null }));

/**
 * The full documented Telnyx port-in flow for one salon:
 *   portability check → POST /porting_orders → PATCH /porting_orders/{id} (end_user admin +
 *   location, routing to Lola, webhook) → documents (bill + LOA via POST /documents, then
 *   PATCH documents) → GET requirements → POST /porting_orders/{id}/actions/confirm.
 * Optional temporary number while porting (a real tenant_numbers row, wired to Lola).
 */
export async function portStart(tenant, details = {}, { authorized = false } = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now — try again in a minute.' };
  const t = await freshTenant(c, tenant);
  const draft = await portDraft(t, details);
  if (!draft.ok) return draft;
  if (draft.in_flight) return { ok: true, say: portSummary(draft.row).say, port: portSummary(draft.row) };
  if (draft.missing.length) return { ok: true, needs: draft.missing, say: portNeedSay(draft.row, draft.missing) };
  if (!authorized) return { ok: true, needs_confirmation: true, say: draft.row.status === 'exception' ? `I’ll send these corrected details for ${pretty(draft.row.requested_phone_number)} to your phone company. Shall I send them?` : confirmPortSay(draft.row) };
  if (draft.row.status === 'exception') return resubmitAfterException(c, t, draft.row, draft.secrets || {});
  return submitPort(c, t, draft.row, draft.secrets || {});
}

export function confirmPortSay(row) {
  return `Ready to move ${pretty(row.requested_phone_number)} to Lola. By saying yes, you authorize LolaDesk to transfer this number from your current phone company on behalf of ${row.entity_name}, and to sign the transfer letter with your name (${row.authorized_contact_name}). Your phone keeps working until the move date. Shall I send it?`;
}

async function submitPort(c, t, row, secrets = {}) {
  const ref = `tenant:${t.id}`;
  const n = row.requested_phone_number;
  const accountNumber = unseal(row.account_number_enc) || secrets.account_number || null;
  const pin = row.metadata?.pin_none ? null : (unseal(row.pin_enc) || secrets.pin || null);
  const meta = { ...(row.metadata || {}) };
  const save = async (patch) => { Object.assign(row, patch); await safe(c.from('tenant_number_ports').update({ ...patch, updated_at: nowIso() }).eq('id', row.id).eq('tenant_id', t.id)); };
  try {
    // 1) Portability (advisory)
    const check = await portCheck(n);
    if (check.portable === false) { await save({ status: 'not_portable', last_error: check.reason || 'not portable' }); return { ok: false, say: check.say }; }
    meta.fast_portable = !!check.fast;

    // 2) Create (only once — a retry reuses the order)
    let ids = orderIdsOf(row);
    if (!ids.length) {
      const created = telnyxData(await telnyxRequest('/porting_orders', { method: 'POST', body: { phone_numbers: [n], customer_reference: ref }, timeoutMs: 20000 }));
      const orders = (Array.isArray(created) ? created : [created]).filter((o) => o && o.id);
      ids = orders.map((o) => o.id);
      if (!ids.length) throw new Error('Telnyx returned no porting order id');
      await save({ telnyx_order_id: ids[0], telnyx_order_ids: ids, telnyx_status: statusOf(orders[0]) || 'draft', status: 'draft', metadata: meta });
      await cost(t.id, 'cost_port', 1, { phone_number: n, orders: ids.length });
    }

    // 3) End-user details + routing to Lola (+ webhook) — documented PATCH fields
    const connectionId = await safe(getCanonicalVoiceConnectionId(), null);
    const { messagingProfileId } = await import('../telnyx-account.js');
    const profileId = await safe(messagingProfileId(c), null);
    const admin = { entity_name: row.entity_name, auth_person_name: row.authorized_contact_name, billing_phone_number: row.billing_phone_number || n };
    if (accountNumber) admin.account_number = accountNumber;
    if (pin) admin.pin_passcode = pin;
    const patch = {
      customer_reference: ref,
      webhook_url: webhookUrl(),
      end_user: { admin, location: { street_address: row.billing_street, locality: row.billing_city, administrative_area: row.billing_state, postal_code: row.billing_zip, country_code: 'US' } },
      messaging: { enable_messaging: true },
    };
    const pnc = {};
    if (connectionId) pnc.connection_id = connectionId;
    if (profileId) pnc.messaging_profile_id = profileId;
    if (Object.keys(pnc).length) patch.phone_number_configuration = pnc;
    for (const id of ids) await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, timeoutMs: 20000 });

    // 4) Documents: the bill (if the owner has one) and the signed authorization letter (LOA)
    const missing = [];
    let invoiceId = row.invoice_document_id || null;
    if (!invoiceId && meta.bill) invoiceId = await uploadDocument(meta.bill, ref);
    let loaId = row.loa_document_id || null;
    if (!loaId && meta.loa) loaId = await uploadDocument(meta.loa, ref);
    if (!loaId) { const gen = await safe(generatedLoa(ids[0]), null); if (gen) { loaId = await uploadDocument(gen, ref); meta.loa_source = 'telnyx_template'; } }
    else if (!meta.loa_source) meta.loa_source = 'owner_upload';
    const docs = {};
    if (loaId) docs.loa = loaId;
    if (invoiceId) docs.invoice = invoiceId;
    if (Object.keys(docs).length) for (const id of ids) await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { documents: docs }, timeoutMs: 20000 });
    delete meta.bill; delete meta.loa;   // the files now live at Telnyx; keep no copy
    meta.loa_authorized_at = nowIso();
    await save({ loa_document_id: loaId, invoice_document_id: invoiceId, metadata: meta });

    // 5) Requirements: what Telnyx still needs, in plain words
    const order = telnyxData(await telnyxRequest(`/porting_orders/${encodeURIComponent(ids[0])}`, { timeoutMs: 15000 }));
    const reqs = telnyxData(await safe(telnyxRequest(`/porting_orders/${encodeURIComponent(ids[0])}/requirements`, { timeoutMs: 15000 }), { data: [] }));
    for (const r of (Array.isArray(reqs) ? reqs : [])) {
      const done = /approved|met|complete|accepted/i.test(String(r.requirement_status || '')) || !!r.field_value;
      if (done) continue;
      const name = `${r.requirement_type?.name || ''} ${r.requirement_type?.description || ''}`;
      if (/invoice|bill/i.test(name)) missing.push('a recent phone bill (photo or PDF)');
      else if (/loa|authori[sz]ation|letter/i.test(name)) missing.push('your signed transfer letter (I can send you the form)');
      else if (r.field_type === 'document') missing.push(`a document: ${clean(r.requirement_type?.name) || 'supporting document'}`);
      else missing.push(clean(r.requirement_type?.name) || 'one more detail');
    }
    if (!loaId && !missing.some((m) => /transfer letter/.test(m))) missing.push('your signed transfer letter (I can send you the form)');
    if (order?.requirements_met === false && missing.length) {
      meta.missing = [...new Set(missing)];
      await save({ status: 'needs_documents', telnyx_status: statusOf(order), requirements_met: false, metadata: meta, last_error: 'requirements not met' });
      return { ok: true, needs: meta.missing, say: `Almost there — to send the transfer I still need ${meta.missing.slice(0, 2).join(' and ')}.` };
    }

    // 6) Submit
    let submitted = null;
    for (const id of ids) submitted = telnyxData(await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}/actions/confirm`, { method: 'POST', timeoutMs: 20000 }));
    delete meta.missing;
    await save({ status: 'submitted', telnyx_status: statusOf(submitted) || 'in-process', requirements_met: true, submitted_at: nowIso(), last_error: null, metadata: meta });

    // 7) Optional temporary number while porting (a real routing row, wired to Lola)
    let temp = null;
    if (meta.temporary_number) {
      const lines = await tenantLines(c, t);
      if (lines.length) temp = lines[0].phone_number;
      else { const g = await getNumber(t, { confirmed: true, temporary: true }); if (g.ok && g.phone_number) temp = g.phone_number; }
      if (temp) await save({ temporary_phone_number: temp });
    }
    return { ok: true, submitted: true, say: `Sent! Your phone company usually takes 1–2 weeks. Your phone keeps working normally until then, and I’ll text you the moment ${pretty(n)} is answered by Lola.${temp ? ` Meanwhile Lola answers ${pretty(temp)}.` : ''}`, port: portSummary(row) };
  } catch (e) {
    const m = errMsg(e);
    console.warn('[setup/telecom] port submit:', m);
    await save({ status: orderIdsOf(row).length ? 'needs_documents' : 'failed', last_error: m, metadata: { ...meta, missing: meta.missing || [] } });
    return { ok: false, error: m, say: 'I couldn’t send the transfer request just now. I’ve saved everything — the LolaDesk team has been flagged and I’ll retry shortly.' };
  }
}

/** Retry the submit for an existing row (admin "retry port" / owner sending a missing document). */
export async function portRetry(tenant, details = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  const t = await freshTenant(c, tenant);
  const row = await latestPort(c, t.id);
  if (!row) return { ok: false, say: 'There’s no number transfer to retry.' };
  if (!['needs_documents', 'failed', 'draft', 'exception', 'collecting'].includes(row.status)) return { ok: true, say: portSummary(row).say };
  const draft = await portDraft(t, details);
  const r = draft.row || row;
  if (row.status === 'exception') {
    // Corrected details after a carrier push-back: PATCH again, then re-confirm.
    return resubmitAfterException(c, t, r, draft.secrets || {});
  }
  if (draft.missing?.length) return { ok: true, needs: draft.missing, say: portNeedSay(r, draft.missing) };
  return submitPort(c, t, r, draft.secrets || {});
}

async function resubmitAfterException(c, t, row, secrets) {
  const ids = orderIdsOf(row);
  if (!ids.length) return submitPort(c, t, row, secrets);
  try {
    const admin = { entity_name: row.entity_name, auth_person_name: row.authorized_contact_name, billing_phone_number: row.billing_phone_number || row.requested_phone_number };
    const acct = unseal(row.account_number_enc) || secrets.account_number; if (acct) admin.account_number = acct;
    const pin = row.metadata?.pin_none ? null : (unseal(row.pin_enc) || secrets.pin); if (pin) admin.pin_passcode = pin;
    const body = { end_user: { admin, location: { street_address: row.billing_street, locality: row.billing_city, administrative_area: row.billing_state, postal_code: row.billing_zip, country_code: 'US' } } };
    for (const id of ids) await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}`, { method: 'PATCH', body, timeoutMs: 20000 });
    const ref = `tenant:${t.id}`, docs = {};
    const meta = { ...(row.metadata || {}) };
    if (meta.bill) { docs.invoice = await uploadDocument(meta.bill, ref); delete meta.bill; }
    if (meta.loa) { docs.loa = await uploadDocument(meta.loa, ref); delete meta.loa; }
    if (docs.invoice || docs.loa) for (const id of ids) await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { documents: Object.fromEntries(Object.entries(docs).filter(([, v]) => v)) }, timeoutMs: 20000 });
    await safe(c.from('tenant_number_ports').update({ metadata: meta, last_error: null, updated_at: nowIso(), ...(docs.invoice ? { invoice_document_id: docs.invoice } : {}), ...(docs.loa ? { loa_document_id: docs.loa } : {}) }).eq('id', row.id).eq('tenant_id', t.id));
    return portSync(row.id, { tenant: t, say: 'Thanks — I’ve sent the corrected details to your phone company.' });
  } catch (e) {
    await safe(c.from('tenant_number_ports').update({ last_error: errMsg(e), updated_at: nowIso() }).eq('id', row.id));
    return { ok: false, error: errMsg(e), say: 'I couldn’t send the corrections just now — I’ll retry shortly.' };
  }
}

/** Sync one port row from Telnyx; on completion, swap the salon over to the ported number. */
export async function portSync(rowOrId, { tenant = null, say = null } = {}) {
  const c = await client();
  if (!c) return { ok: false };
  let row = rowOrId;
  if (typeof rowOrId === 'string') { const { data } = await c.from('tenant_number_ports').select('*').eq('id', rowOrId).maybeSingle(); row = data; }
  if (!row) return { ok: false, say: 'There’s no number transfer in progress.' };
  const t = await freshTenant(c, tenant && tenant.id === row.tenant_id ? tenant : { id: row.tenant_id });
  const ids = orderIdsOf(row);
  if (!ids.length || row.completed_at) return { ok: true, port: portSummary(row), say: say || portSummary(row).say };
  const meta = { ...(row.metadata || {}) };
  try {
    const orders = [];
    for (const id of ids) orders.push(telnyxData(await telnyxRequest(`/porting_orders/${encodeURIComponent(id)}`, { timeoutMs: 15000 })));
    const statuses = orders.map(statusOf);
    const status = statuses.every((s) => s === 'ported') ? 'ported' : statuses.find((s) => s === 'exception') || statuses.find((s) => s && s !== 'ported') || statuses[0] || row.status;
    const exceptions = orders.flatMap(exceptionsOf);
    const foc = orders.map((o) => o?.activation_settings?.foc_datetime_actual || o?.activation_settings?.foc_datetime_requested || null).find(Boolean) || row.foc_date || null;
    const reqMet = orders.every((o) => o?.requirements_met !== false);
    const local = status === 'in-process' ? 'submitted' : status === 'draft' && row.status === 'needs_documents' ? 'needs_documents' : status;
    const patch = { telnyx_status: status, status: local, foc_date: foc, exceptions, requirements_met: reqMet, synced_at: nowIso(), updated_at: nowIso() };
    // Tell the owner, once, about each new push-back and the confirmed move date.
    const notified = { ...(meta.notified || {}) };
    if (status === 'exception') {
      const key = exceptions.map((x) => x.code).sort().join(',') || 'exception';
      if (notified.exception !== key) { notified.exception = key; await textOwner(t, `LolaDesk: moving ${pretty(row.requested_phone_number)} hit a snag — ${portSummary({ ...row, ...patch }).say} Just reply to Lola in your dashboard.`); }
    }
    if (status === 'foc-date-confirmed' && foc && notified.foc !== foc) { notified.foc = foc; await textOwner(t, `LolaDesk: ${portSummary({ ...row, ...patch }).say}`); }
    patch.metadata = { ...meta, notified };
    await c.from('tenant_number_ports').update(patch).eq('id', row.id).eq('tenant_id', row.tenant_id);
    row = { ...row, ...patch };
    if (status === 'ported') return completePort(c, t, row);
    return { ok: true, port: portSummary(row), say: say || portSummary(row).say };
  } catch (e) {
    await safe(c.from('tenant_number_ports').update({ last_error: errMsg(e), synced_at: nowIso() }).eq('id', row.id));
    return { ok: false, error: errMsg(e), port: portSummary(row), say: say || portSummary(row).say };
  }
}

/** The number arrived: route it to Lola, make it the salon's main line, keep the temp line, text the owner. */
export async function completePort(c, t, row) {
  if (row.completed_at) return { ok: true, port: portSummary(row), say: portSummary(row).say };
  const n = row.requested_phone_number;
  const rec = await safe(numberRecord(n), null);
  let voice = false, texts = false;
  if (rec?.id) {
    voice = await safe(linkVoiceConnection(rec.id), false);       // PATCH /phone_numbers/{id} {connection_id}
    texts = await safe(linkMessagingProfile(rec.id), false);      // PATCH /phone_numbers/{id}/messaging
  }
  const connectionId = await safe(getCanonicalVoiceConnectionId(), null);
  const temp = row.temporary_phone_number || null;
  const lines = await tenantLines(c, t);
  for (const l of lines) if (l.phone_number !== n && l.kind === 'primary') await upsertTenantNumber(t.id, l.phone_number, { kind: 'secondary', status: 'active', notes: l.phone_number === temp ? 'temporary number while porting' : 'kept after port' });
  await upsertTenantNumber(t.id, n, { kind: 'primary', status: 'active', connectionId: rec?.id ? connectionId : null, notes: 'ported in' });
  await safe(c.from('tenants').update({ phone_number: n, telnyx_phone_id: rec?.id || null, provisioning_status: 'active' }).eq('id', t.id));
  invalidateRouting(n); for (const l of lines) invalidateRouting(l.phone_number);
  await cost(t.id, 'cost_number_month', 1, { phone_number: n, source: 'ported' });
  await safe(assignNumbersIfApproved(c, { ...t, phone_number: n }));
  const text = await textOwner({ ...t, phone_number: n }, `LolaDesk: Your number ${pretty(n)} is now answered by Lola. 🎉${temp ? ` ${pretty(temp)} keeps working too.` : ''}`, n);
  const meta = { ...(row.metadata || {}), completion: { voice, texts, texted_owner: !text?.skipped, at: nowIso() } };
  const patch = { status: 'ported', completed_at: nowIso(), metadata: meta, last_error: rec?.id ? (voice ? null : 'voice routing not attached') : 'ported number not found on the account yet' };
  await safe(c.from('tenant_number_ports').update(patch).eq('id', row.id).eq('tenant_id', t.id));
  const done = { ...row, ...patch };
  return { ok: true, completed: true, port: portSummary(done), say: `Your number ${pretty(n)} is now answered by Lola.` };
}

/** Owner-facing port status (syncs the open order first). */
export async function portStatus(tenant) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  const row = await latestPort(c, tenant.id);
  if (!row) return { ok: true, port: null, say: 'You haven’t started moving a number yet. Want to? I just need a few details from your phone bill.' };
  if (orderIdsOf(row).length && !PORT_DONE.has(row.status)) return portSync(row, { tenant });
  const missing = row.status === 'collecting' ? portMissing(row) : [];
  return { ok: true, port: portSummary(row), say: missing.length ? `To move your number I still need ${portAsk(missing).join(' and ')}.` : portSummary(row).say };
}

// ═════════════════════════════════════════════════════════════════════════════
// TEXTING — the salon's own 10DLC brand + campaign on LolaDesk's Telnyx account
// ═════════════════════════════════════════════════════════════════════════════

// Documented: PRIVATE_PROFIT; sole proprietors per the 10DLC guide (TCR value SOLE_PROPRIETOR — overridable).
export const SOLE_PROP_ENTITY = () => process.env.TELNYX_SOLE_PROP_ENTITY_TYPE || 'SOLE_PROPRIETOR';
const VERTICAL = () => process.env.TELNYX_10DLC_VERTICAL || 'PROFESSIONAL';
const APPROVED = new Set(['TELNYX_ACCEPTED', 'MNO_PENDING', 'MNO_ACCEPTED', 'MNO_PROVISIONED']);
const REJECTED = new Set(['TCR_FAILED', 'TELNYX_FAILED', 'MNO_REJECTED', 'MNO_PROVISIONING_FAILED', 'TCR_SUSPENDED', 'TCR_EXPIRED']);
const OPTOUT_KEYWORDS = 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT';   // exactly what /api/telnyx-sms honours
const OPTIN_KEYWORDS = 'START,UNSTOP';
const HELP_KEYWORDS = 'HELP,INFO';

export const TEXTING_FIELDS_BUSINESS = [
  ['legal_name', 'your business’s legal name (exactly as on your IRS paperwork)'],
  ['ein', 'your EIN (the 9-digit federal tax ID) — or say “no EIN” if you’re a sole proprietor'],
  ['street', 'the business street address'], ['city', 'the city'], ['state', 'the state'], ['zip', 'the ZIP code'],
  ['email', 'a business email'], ['website', 'your website (or say “none”)'],
];
export const TEXTING_FIELDS_SOLE = [
  ['first_name', 'your first name'], ['last_name', 'your last name'],
  ['mobile', 'your personal mobile number (the carriers text it a code to confirm it’s you)'],
  ['street', 'your street address'], ['city', 'the city'], ['state', 'the state'], ['zip', 'the ZIP code'],
  ['email', 'your email'],
];

async function complianceRow(c, tenantId) {
  const { data } = await safe(c.from('tenant_compliance').select('*').eq('tenant_id', tenantId).maybeSingle(), { data: null }) || {};
  return data || null;
}
async function saveCompliance(c, tenantId, patch) {
  const row = { tenant_id: tenantId, ...patch, updated_at: nowIso() };
  const existing = await complianceRow(c, tenantId);
  if (existing) await c.from('tenant_compliance').update(row).eq('tenant_id', tenantId);
  else await c.from('tenant_compliance').insert({ created_at: nowIso(), stage: 'collecting', numbers: [], details: {}, ...row });
  return { ...(existing || {}), ...row };
}

/** Merge texting details into the draft; returns { row, missing, sole, secrets }. */
export async function textingDraft(tenant, input = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  const row = await complianceRow(c, tenant.id);
  if (row?.brand_id) return { ok: true, row, registered: true, missing: [] };
  const d = { ...(row?.details || {}) };
  const secrets = {};
  const take = (k) => { if (clean(input[k])) d[k] = clean(input[k]); };
  ['legal_name', 'first_name', 'last_name', 'street', 'city', 'email'].forEach(take);
  if (clean(input.state)) d.state = clean(input.state).toUpperCase().slice(0, 2);
  if (clean(input.zip)) d.zip = digits(input.zip).slice(0, 5);
  if (clean(input.mobile)) d.mobile = phone10(input.mobile) || clean(input.mobile);
  if (input.website !== undefined && clean(input.website) !== '') d.website = /^(none|no|n\/a|-)$/i.test(clean(input.website)) ? 'none' : clean(input.website);
  let einEnc = row?.ein_enc || null;
  const noEin = input.no_ein === true || /^(no|none|no ein|n\/a)$/i.test(clean(input.ein));
  if (noEin) { d.sole_prop = true; einEnc = null; delete d.ein_last4; }
  else if (clean(input.ein)) {
    const e = digits(input.ein);
    if (e.length !== 9) return { ok: false, say: 'An EIN has 9 digits (like 12-3456789). Can you read it again? Or say “no EIN” if you don’t have one.' };
    d.sole_prop = false; d.ein_last4 = e.slice(-4);
    einEnc = seal(e); if (!einEnc) { secrets.ein = e; d.secure_storage_missing = true; } else delete d.secure_storage_missing;
  }
  const sole = d.sole_prop === true;
  const patch = { details: d, entity_type: d.sole_prop === undefined ? (row?.entity_type || null) : (sole ? SOLE_PROP_ENTITY() : 'PRIVATE_PROFIT'), legal_name: d.legal_name || row?.legal_name || null, ein_enc: einEnc, stage: row?.stage && row.stage !== 'collecting' ? row.stage : 'collecting' };
  if (d.secure_storage_missing) patch.last_error = 'INTEGRATION_ENCRYPTION_KEY missing: EIN not stored';
  const saved = await saveCompliance(c, tenant.id, patch);
  return { ok: true, row: saved, missing: textingMissing(saved, secrets), sole, secrets };
}

export function textingMissing(row, secrets = {}) {
  const d = row?.details || {};
  if (d.sole_prop === undefined) {
    const m = [];
    if (!d.legal_name) m.push('legal_name');
    m.push('ein');
    return m;
  }
  const fields = d.sole_prop ? TEXTING_FIELDS_SOLE : TEXTING_FIELDS_BUSINESS;
  return fields.map(([k]) => k).filter((k) => {
    if (k === 'ein') return !(row.ein_enc || secrets.ein);
    if (k === 'state') return !/^[A-Z]{2}$/.test(d.state || '');
    if (k === 'zip') return !/^\d{5}$/.test(d.zip || '');
    if (k === 'email') return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || '');
    if (k === 'mobile') return !/^\+1\d{10}$/.test(d.mobile || '');
    return !d[k];
  });
}
export function textingAsk(row, missing) {
  const fields = row?.details?.sole_prop ? TEXTING_FIELDS_SOLE : TEXTING_FIELDS_BUSINESS;
  return missing.slice(0, 2).map((k) => (fields.find(([f]) => f === k) || TEXTING_FIELDS_BUSINESS.find(([f]) => f === k) || [k, k])[1]);
}

export function textingNeedSay(row, missing) {
  if (row?.details?.secure_storage_missing && missing.includes('ein')) return 'Everything else is saved. For your security I only keep your EIN in our encrypted vault, and it isn’t switched on yet — I’ve flagged the LolaDesk team and we’ll finish this with you shortly.';
  return `To register your business texting I need ${textingAsk(row, missing).join(' and ')}.`;
}

function salonWebsite(tenant, d) {
  if (d.website && d.website !== 'none') return /^https?:\/\//i.test(d.website) ? d.website : 'https://' + d.website;
  return tenant.website || tenant.booking_url || (tenant.slug ? `${appUrl()}/book?salon=${encodeURIComponent(tenant.slug)}` : appUrl());
}

/** The campaign Lola writes for the salon: its name, samples with STOP/HELP, and how clients opt in. */
export function campaignFor(tenant, brandId, { sole = false, website = null } = {}) {
  const name = clean(tenant.name) || 'Our salon';
  const link = website || salonWebsite(tenant, {});
  const line = pretty(tenant.phone_number || '');
  const usecase = sole ? 'CUSTOMER_CARE' : 'MIXED';
  const body = {
    brandId,
    usecase,
    description: `${name} is a beauty salon. Its AI front desk, Lola, texts clients who booked an appointment or contacted the salon: booking confirmations, appointment reminders, rescheduling, and answers to their questions.`,
    sample1: `${name}: Hi Sarah, you're booked for a Blowout on Fri 3/14 at 2:00 PM. Need to change it? Reply here. Reply HELP for help, STOP to opt out.`,
    sample2: `${name}: Reminder - your appointment is tomorrow at 11:00 AM. See you then! Reply STOP to opt out.`,
    sample3: `${name}: Thanks for calling! Book your next visit here: ${link} Reply STOP to opt out.`,
    messageFlow: `Clients opt in to texts from ${name} when they book an appointment (online at ${link}, by phone with the salon's front desk, or in person) and give their mobile number, or when they text the salon's number${line ? ` ${line}` : ''} first. The booking form and the front desk tell them they will receive appointment texts from ${name}; message frequency varies; message and data rates may apply; reply STOP to opt out and HELP for help. Privacy policy: ${appUrl()}/privacy`,
    helpMessage: `${name}: appointment texts from our front desk.${line ? ` Questions? Call ${line} or reply here.` : ' Reply here with questions.'} Msg&data rates may apply. Reply STOP to opt out.`,
    optinMessage: `${name}: You're subscribed to appointment texts. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`,
    optoutMessage: `${name}: You're unsubscribed and won't receive more texts. Reply START to resubscribe.`,
    optinKeywords: OPTIN_KEYWORDS,
    optoutKeywords: OPTOUT_KEYWORDS,
    helpKeywords: HELP_KEYWORDS,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    embeddedLink: true,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    termsAndConditions: true,
    privacyPolicyLink: `${appUrl()}/privacy`,
    termsAndConditionsLink: `${appUrl()}/sms-terms`,
    autoRenewal: true,
    webhookURL: webhookUrl(),
  };
  if (usecase === 'MIXED') body.subUsecases = ['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATION'];
  return body;
}

/** Register the salon's own brand (and, for businesses, the campaign right after). */
export async function textingRegister(tenant, info = {}, { confirmed = false } = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  const t = await freshTenant(c, tenant);
  const draft = await textingDraft(t, info);
  if (!draft.ok) return draft;
  if (draft.registered) return textingStatus(t);
  if (!info.force) {
    const row0 = await complianceRow(c, t.id);
    if (!row0?.brand_id && await existingAssignment(c, t)) return { ok: true, texting: { state: 'approved', say: ALREADY_SAY }, say: ALREADY_SAY };
  }
  if (draft.missing.length) return { ok: true, needs: draft.missing, say: textingNeedSay(draft.row, draft.missing) };
  const d = draft.row.details || {};
  if (confirmed !== true) {
    return { ok: true, needs_confirmation: true, say: d.sole_prop
      ? `I’ll register ${t.name || 'your salon'} for business texting as a sole proprietor under ${d.first_name} ${d.last_name}, then text a code to ${pretty(d.mobile)} to confirm it’s you. It’s included in your plan. Go ahead?`
      : `I’ll register ${d.legal_name} (EIN ending ${d.ein_last4}) for business texting with the phone carriers so your texts get delivered reliably. It’s included in your plan. Go ahead?` };
  }
  const sole = !!d.sole_prop;
  const ein = sole ? null : (unseal(draft.row.ein_enc) || draft.secrets?.ein || null);
  if (!sole && !ein) return { ok: true, needs: ['ein'], say: 'I need your EIN once more to send it — what is it?' };
  const brand = {
    entityType: sole ? SOLE_PROP_ENTITY() : 'PRIVATE_PROFIT',
    displayName: clean(t.name) || d.legal_name || `${d.first_name} ${d.last_name}`,
    country: 'US',
    email: d.email,
    vertical: VERTICAL(),
    phone: e164(t.phone_number || '') || d.mobile || undefined,
    street: d.street, city: d.city, state: d.state, postalCode: d.zip,
    website: salonWebsite(t, d),
    webhookURL: webhookUrl(),
  };
  if (sole) { brand.firstName = d.first_name; brand.lastName = d.last_name; brand.mobilePhone = d.mobile; }
  else { brand.companyName = d.legal_name; brand.ein = ein; }
  Object.keys(brand).forEach((k) => brand[k] === undefined && delete brand[k]);
  try {
    const b = telnyxData(await telnyxRequest('/10dlc/brand', { method: 'POST', body: brand, timeoutMs: 20000 }));
    const brandId = b?.brandId || b?.id || null;
    if (!brandId) throw new Error('Telnyx returned no brand id');
    await cost(t.id, 'cost_10dlc_brand', 1, { entity_type: brand.entityType });
    await saveCompliance(c, t.id, { brand_id: brandId, brand_status: b.status || null, brand_identity_status: b.identityStatus || null, entity_type: brand.entityType, stage: sole ? 'awaiting_code' : 'brand_review', last_error: null });
    if (sole) return textingSendCode(t);
    const camp = await createCampaignIfReady(c, t, brandId, b);
    return { ok: true, say: camp.created ? 'Done — your business is registered and your texting campaign is with the carriers for review (usually 1–3 business days). Your texts keep going out meanwhile.' : 'Done — your business is being verified with the carriers (a few minutes to a couple of days). I’ll finish the texting registration automatically as soon as it’s verified. Your texts keep going out meanwhile.' };
  } catch (e) {
    const m = errMsg(e);
    await saveCompliance(c, t.id, { last_error: m, stage: 'needs_attention' });
    return { ok: false, error: m, say: `The carriers’ registry didn’t accept the details: ${plainTcrError(m)} Tell me the corrected details and I’ll resend.` };
  }
}

function plainTcrError(m) {
  if (/ein/i.test(m)) return 'the EIN and legal name don’t match — use the name exactly as on your IRS letter.';
  if (/email/i.test(m)) return 'the email address was rejected.';
  if (/website|url/i.test(m)) return 'the website address was rejected.';
  if (/address|street|postal|zip|state|city/i.test(m)) return 'the address was rejected.';
  if (/phone|mobile/i.test(m)) return 'the phone number was rejected.';
  return 'something didn’t match.';
}

/** Sole proprietor: POST /10dlc/brand/{brandId}/smsOtp (pinSms, successSms) → referenceId. */
export async function textingSendCode(tenant) {
  const c = await client();
  const row = c ? await complianceRow(c, tenant.id) : null;
  if (!row?.brand_id) return { ok: false, say: 'Let’s register your business texting first.' };
  const name = clean(tenant.name) || 'LolaDesk';
  try {
    const r = telnyxData(await telnyxRequest(`/10dlc/brand/${encodeURIComponent(row.brand_id)}/smsOtp`, { method: 'POST', body: {
      pinSms: `${name} texting registration: your verification code is @OTP_PIN@. Reply HELP for help.`,
      successSms: `${name}: you're verified for business texting. Thank you!`,
    }, timeoutMs: 15000 }));
    await saveCompliance(c, tenant.id, { otp_reference: r?.referenceId || null, stage: 'awaiting_code', last_error: null });
    return { ok: true, say: `I just texted a code to ${pretty(row.details?.mobile)}. Read it to me when it arrives.` };
  } catch (e) {
    await saveCompliance(c, tenant.id, { last_error: errMsg(e) });
    return { ok: false, error: errMsg(e), say: 'I couldn’t send the verification code just now — say “send the code again” in a minute.' };
  }
}

/** Sole proprietor: PUT /10dlc/brand/{brandId}/smsOtp { otpPin } → then the campaign. */
export async function textingVerifyCode(tenant, code) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  const t = await freshTenant(c, tenant);
  const row = await complianceRow(c, t.id);
  if (!row?.brand_id) return { ok: false, say: 'Let’s register your business texting first.' };
  const pin = digits(code);
  if (pin.length < 4) return { ok: false, say: 'Read me the digits from the text you just got.' };
  try {
    await telnyxRequest(`/10dlc/brand/${encodeURIComponent(row.brand_id)}/smsOtp`, { method: 'PUT', body: { otpPin: pin }, timeoutMs: 15000 });
    await saveCompliance(c, t.id, { stage: 'brand_review', last_error: null });
    const b = telnyxData(await safe(telnyxRequest(`/10dlc/brand/${encodeURIComponent(row.brand_id)}`, { timeoutMs: 10000 }), null));
    const camp = await createCampaignIfReady(c, t, row.brand_id, b || {}, { force: true });
    return { ok: true, say: camp.created ? 'Verified! Your texting registration is now with the carriers for review — usually 1–3 business days. Your texts keep going out meanwhile.' : 'Verified! I’ll finish the texting registration automatically in a moment.' };
  } catch (e) {
    await saveCompliance(c, t.id, { last_error: errMsg(e) });
    return { ok: false, error: errMsg(e), say: 'That code didn’t work. Check the latest text and read it again — or say “send the code again”.' };
  }
}

const brandReady = (b) => b && b.status !== 'REGISTRATION_FAILED' && (b.status === 'OK' || ['VERIFIED', 'VETTED_VERIFIED', 'SELF_DECLARED'].includes(b.identityStatus));

async function createCampaignIfReady(c, t, brandId, brand, { force = false } = {}) {
  const row = await complianceRow(c, t.id);
  if (row?.campaign_id) return { created: false, exists: true };
  if (!force && !brandReady(brand)) return { created: false };
  const sole = String(row?.entity_type || '').startsWith('SOLE');
  const website = salonWebsite(t, row?.details || {});
  let body = campaignFor(t, brandId, { sole, website });
  let data;
  try { data = telnyxData(await telnyxRequest('/10dlc/campaignBuilder', { method: 'POST', body, timeoutMs: 20000 })); }
  catch (e) {
    if (body.usecase !== 'MIXED') { await saveCompliance(c, t.id, { last_error: errMsg(e), stage: 'needs_attention' }); return { created: false, error: errMsg(e) }; }
    // MIXED not allowed for this brand → the narrower customer-care campaign.
    body = { ...body, usecase: 'CUSTOMER_CARE' }; delete body.subUsecases;
    try { data = telnyxData(await telnyxRequest('/10dlc/campaignBuilder', { method: 'POST', body, timeoutMs: 20000 })); }
    catch (e2) { await saveCompliance(c, t.id, { last_error: errMsg(e2), stage: 'needs_attention' }); return { created: false, error: errMsg(e2) }; }
  }
  const campaignId = data?.campaignId || data?.id || null;
  if (!campaignId) { await saveCompliance(c, t.id, { last_error: 'Telnyx returned no campaign id' }); return { created: false }; }
  await cost(t.id, 'cost_10dlc_campaign_month', 1, { usecase: body.usecase });
  await saveCompliance(c, t.id, { campaign_id: campaignId, campaign_status: data.campaignStatus || data.status || 'TCR_PENDING', usecase: body.usecase, stage: 'campaign_review', last_error: data.failureReasons || null });
  if (APPROVED.has(data.campaignStatus)) await assignNumbersIfApproved(c, t);
  return { created: true };
}

/** Campaign approved → POST /10dlc/phone_number_campaigns {phoneNumber, campaignId} for each salon line. */
// A salon whose number is ALREADY on a 10DLC campaign (e.g. registered at platform level before
// per-salon registration existed) is registered: never make it register again, never move its number.
const assignedCache = new Map();
export async function existingAssignment(c, tenant) {
  const hit = assignedCache.get(tenant.id);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  let v = null;
  try {
    for (const l of (await tenantLines(c, tenant)).slice(0, 3)) {
      const d = telnyxData(await telnyxRequest('/10dlc/phone_number_campaigns/' + encodeURIComponent(l.phone_number), { timeoutMs: 8000 }).catch(() => null));
      const st = d?.assignmentStatus || (d?.campaignId ? 'ASSIGNED' : null);
      if (d && d.campaignId && st === 'ASSIGNED') { v = { phone_number: l.phone_number, campaign_id: d.campaignId }; break; }
    }
  } catch (_) {}
  assignedCache.set(tenant.id, { at: Date.now(), v });
  return v;
}
const ALREADY_SAY = 'Your salon number is already registered for business texting — your texts are delivered reliably. Nothing to do.';

export async function assignNumbersIfApproved(c, tenant, { force = false } = {}) {
  const row = await complianceRow(c, tenant.id);
  if (!row?.campaign_id || (!APPROVED.has(row.campaign_status) && !force)) return { assigned: 0 };
  const lines = await tenantLines(c, tenant);
  const numbers = Array.isArray(row.numbers) ? row.numbers.slice() : [];
  let assigned = 0;
  for (const l of lines) {
    const cur = numbers.find((x) => x.phone_number === l.phone_number);
    if (cur && ['ASSIGNED', 'PENDING_ASSIGNMENT', 'ASSIGNED_ELSEWHERE'].includes(cur.status) && !force) continue;
    if (!force) {
      // Already on another approved campaign (platform registration): leave it there.
      const ex = telnyxData(await telnyxRequest('/10dlc/phone_number_campaigns/' + encodeURIComponent(l.phone_number), { timeoutMs: 8000 }).catch(() => null));
      if (ex && ex.campaignId && ex.campaignId !== row.campaign_id && (ex.assignmentStatus || 'ASSIGNED') === 'ASSIGNED') {
        const entry = { phone_number: l.phone_number, status: 'ASSIGNED_ELSEWHERE', campaign_id: ex.campaignId, at: nowIso() };
        if (cur) Object.assign(cur, entry); else numbers.push(entry);
        continue;
      }
    }
    try {
      const d = telnyxData(await telnyxRequest('/10dlc/phone_number_campaigns', { method: 'POST', body: { phoneNumber: l.phone_number, campaignId: row.campaign_id }, timeoutMs: 15000 }));
      const entry = { phone_number: l.phone_number, status: d?.assignmentStatus || 'PENDING_ASSIGNMENT', failure: d?.failureReasons || null, at: nowIso() };
      if (cur) Object.assign(cur, entry); else numbers.push(entry);
      assigned++;
    } catch (e) {
      const entry = { phone_number: l.phone_number, status: 'FAILED_ASSIGNMENT', failure: errMsg(e), at: nowIso() };
      if (cur) Object.assign(cur, entry); else numbers.push(entry);
    }
  }
  await saveCompliance(c, tenant.id, { numbers, stage: numbers.length && numbers.every((x) => x.status === 'ASSIGNED') ? 'live' : 'assigning' });
  return { assigned, numbers };
}

/** Pull brand → campaign → assignments from Telnyx and move the salon forward. */
export async function textingSync(tenant) {
  const c = await client();
  if (!c) return { ok: false };
  const t = await freshTenant(c, tenant);
  let row = await complianceRow(c, t.id);
  if (!row?.brand_id) return { ok: true, row };
  try {
    const b = telnyxData(await telnyxRequest(`/10dlc/brand/${encodeURIComponent(row.brand_id)}`, { timeoutMs: 10000 }));
    const patch = { brand_status: b?.status || row.brand_status, brand_identity_status: b?.identityStatus || row.brand_identity_status, synced_at: nowIso() };
    if (b?.status === 'REGISTRATION_FAILED') { patch.stage = 'needs_attention'; patch.last_error = b.failureReasons || 'brand registration failed'; }
    row = await saveCompliance(c, t.id, patch);
    if (!row.campaign_id && row.stage !== 'awaiting_code' && brandReady(b)) await createCampaignIfReady(c, t, row.brand_id, b);
    row = await complianceRow(c, t.id);
    if (row?.campaign_id) {
      const cp = telnyxData(await telnyxRequest(`/10dlc/campaign/${encodeURIComponent(row.campaign_id)}`, { timeoutMs: 10000 }));
      const st = cp?.campaignStatus || cp?.status || row.campaign_status;
      const cpatch = { campaign_status: st, synced_at: nowIso() };
      if (REJECTED.has(st)) { cpatch.stage = 'needs_attention'; cpatch.last_error = cp?.failureReasons || st; }
      row = await saveCompliance(c, t.id, cpatch);
      if (APPROVED.has(st)) {
        await assignNumbersIfApproved(c, t);
        row = await complianceRow(c, t.id);
        // Refresh pending assignments: GET /10dlc/phone_number_campaigns/{phoneNumber}
        const nums = (row.numbers || []).slice();
        let changed = false;
        for (const x of nums) {
          if (x.status !== 'PENDING_ASSIGNMENT') continue;
          const g = telnyxData(await safe(telnyxRequest(`/10dlc/phone_number_campaigns/${encodeURIComponent(x.phone_number)}`, { timeoutMs: 10000 }), null));
          if (g?.assignmentStatus && g.assignmentStatus !== x.status) { x.status = g.assignmentStatus; x.failure = g.failureReasons || null; x.at = nowIso(); changed = true; }
        }
        if (changed) row = await saveCompliance(c, t.id, { numbers: nums, stage: nums.every((x) => x.status === 'ASSIGNED') ? 'live' : 'assigning' });
      }
    }
    return { ok: true, row };
  } catch (e) {
    await saveCompliance(c, t.id, { last_error: errMsg(e), synced_at: nowIso() });
    return { ok: false, error: errMsg(e), row };
  }
}

/** Plain-language texting state (never blocks texting: it always says texts keep going out). */
export function textingSummary(row) {
  if (!row || (!row.brand_id && !Object.keys(row.details || {}).length)) return { state: 'not_started', say: 'Business texting isn’t registered yet. Texts still go out, but some carriers may filter them until you register — it takes me two minutes and it’s included.' };
  if (!row.brand_id) return { state: 'collecting', say: 'I’ve started your business texting registration — I just need a few more details.', missing: textingMissing(row) };
  if (row.stage === 'awaiting_code') return { state: 'awaiting_code', say: `I texted a verification code to ${pretty(row.details?.mobile)} — read it to me to finish.` };
  if (row.stage === 'needs_attention') return { state: 'needs_attention', say: `The carriers need a correction: ${plainTcrError(String(row.last_error || ''))} Tell me the right details and I’ll resend. Texts keep going out meanwhile.` };
  if (!row.campaign_id) return { state: 'verifying_business', say: 'Your business is being verified with the carriers (minutes to a couple of days). I’ll finish the rest automatically. Texts keep going out meanwhile.' };
  if (REJECTED.has(row.campaign_status)) return { state: 'needs_attention', say: 'The carriers sent your texting registration back. The LolaDesk team is reviewing it and I’ll tell you if I need anything. Texts keep going out meanwhile.' };
  if (APPROVED.has(row.campaign_status)) {
    const nums = row.numbers || [];
    if (nums.length && nums.every((x) => x.status === 'ASSIGNED')) return { state: 'approved', say: 'Your business texting is approved by the carriers — your texts are delivered reliably.' };
    return { state: 'approved', say: 'Your business texting is approved — I’m putting your Lola numbers on it now.' };
  }
  return { state: 'in_review', say: 'Your texting registration is with the carriers for review — usually 1–3 business days. Texts keep going out meanwhile.' };
}

export async function textingStatus(tenant, { sync = true } = {}) {
  const c = await client();
  if (!c) return { ok: false, say: 'I can’t reach your account right now.' };
  if (sync) await textingSync(tenant);
  const row = await complianceRow(c, tenant.id);
  if (!row?.brand_id && await existingAssignment(c, tenant)) return { ok: true, texting: { state: 'approved', say: ALREADY_SAY }, say: ALREADY_SAY };
  const s = textingSummary(row);
  if (s.state === 'collecting') return { ok: true, texting: s, say: textingNeedSay(row, s.missing) };
  return { ok: true, texting: s, say: s.say };
}

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESS — one object for the UI and for Lola
// ═════════════════════════════════════════════════════════════════════════════
export async function setupProgress(tenant) {
  const c = await client();
  const line = await lineOptions(tenant);
  const comp = c ? await complianceRow(c, tenant.id) : null;
  let texting = textingSummary(comp);
  if (c && !comp?.brand_id && line.has_number && await existingAssignment(c, tenant)) texting = { state: 'approved', say: ALREADY_SAY };
  let next = null;
  if (!line.has_number) next = { tool: 'get_number', say: 'First step: give Lola her own number. Want me to do it now?' };
  else if (line.port && ['collecting', 'needs_documents', 'exception'].includes(line.port.state)) next = { tool: 'port_my_number', say: line.port.say };
  else if (texting.state === 'awaiting_code') next = { tool: 'verify_texting_code', say: texting.say };
  else if (['not_started', 'collecting', 'needs_attention'].includes(texting.state)) next = { tool: 'register_texting', say: texting.state === 'not_started' ? 'Next: register your business texting so carriers deliver Lola’s texts reliably. I need your business’s legal name and EIN.' : texting.say };
  else if (line.forwarding === 'not_set_up' && !line.port) next = { tool: 'forward_my_number', say: line.options.find((o) => o.id === 'forward_my_number')?.say || null };
  const parts = [];
  parts.push(line.has_number ? `Lola’s number is ${line.number}.` : 'Lola doesn’t have a number yet.');
  if (line.forwarding === 'verified') parts.push(`Missed calls to ${line.forwarding_from} forward to her.`);
  if (line.port) parts.push(line.port.say);
  parts.push(texting.say);
  return { ok: true, line, texting, next, say: parts.join(' ') };
}

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOKS + CRON
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A Telnyx event (signature already verified by the caller). Payload ids are only used to
 * look rows up; the state itself is always re-read from Telnyx (GET), so a replayed or
 * forged event can never change a salon's data by itself.
 */
export async function handleTelecomEvent(event) {
  const c = await client();
  if (!c) return { handled: false, reason: 'no-db' };
  const data = event?.data || event || {};
  const type = String(data.event_type || event?.event_type || '');
  const p = data.payload || event?.payload || {};
  if (/^porting_order\./.test(type) || p.porting_order_id) {
    const orderId = p.porting_order_id || p.id || null;
    if (!orderId) return { handled: false, reason: 'no-order-id' };
    let { data: rows } = await safe(c.from('tenant_number_ports').select('*').eq('telnyx_order_id', orderId).limit(1), { data: [] }) || {};
    let row = (rows || [])[0];
    if (!row) {
      const { data: all } = await safe(c.from('tenant_number_ports').select('*').not('telnyx_order_ids', 'is', null).limit(1000), { data: [] }) || {};
      row = (all || []).find((r) => orderIdsOf(r).includes(orderId)) || null;
    }
    if (!row) return { handled: false, reason: 'unknown-order' };
    const ref = String(p.customer_reference || '');
    if (ref.startsWith('tenant:') && ref.slice(7) !== row.tenant_id) return { handled: false, reason: 'tenant-mismatch' };
    if (type === 'porting_order.new_comment') {
      const comments = [...((row.metadata || {}).comments || []), { at: nowIso(), body: String(p.comment?.body || p.body || '').slice(0, 500) }].slice(-10);
      await safe(c.from('tenant_number_ports').update({ metadata: { ...(row.metadata || {}), comments } }).eq('id', row.id));
      row.metadata = { ...(row.metadata || {}), comments };
    }
    if (type === 'porting_order.deleted') { await safe(c.from('tenant_number_ports').update({ status: 'cancelled', telnyx_status: 'deleted', updated_at: nowIso() }).eq('id', row.id)); return { handled: true, kind: 'port', tenant_id: row.tenant_id }; }
    const r = await portSync(row);
    return { handled: true, kind: 'port', tenant_id: row.tenant_id, completed: !!r.completed };
  }
  const campaignId = p.campaignId || p.campaign_id || null, brandId = p.brandId || p.brand_id || null;
  if (campaignId || brandId || /10dlc|campaign|brand/i.test(type)) {
    let row = null;
    if (campaignId) { const { data: rr } = await safe(c.from('tenant_compliance').select('*').eq('campaign_id', campaignId).limit(1), { data: [] }) || {}; row = (rr || [])[0] || null; }
    if (!row && brandId) { const { data: rr } = await safe(c.from('tenant_compliance').select('*').eq('brand_id', brandId).limit(1), { data: [] }) || {}; row = (rr || [])[0] || null; }
    if (!row) return { handled: false, reason: 'unknown-10dlc' };
    await textingSync({ id: row.tenant_id });
    return { handled: true, kind: '10dlc', tenant_id: row.tenant_id };
  }
  return { handled: false, reason: 'not-telecom-setup' };
}

/** Cron: sync open ports and pending 10DLC registrations (bounded batch). */
export async function syncAll({ limit = 25, budgetMs = 45000 } = {}) {
  const c = await client();
  if (!c) return { ok: false, reason: 'no-db' };
  const started = Date.now();
  const out = { ports: 0, ports_completed: 0, texting: 0, errors: 0 };
  const { data: ports } = await safe(c.from('tenant_number_ports').select('*').order('updated_at', { ascending: true }).limit(500), { data: [] }) || {};
  const open = (ports || []).filter((r) => orderIdsOf(r).length && !r.completed_at && !['cancelled', 'not_portable', 'collecting'].includes(r.status)).slice(0, limit);
  for (const r of open) {
    if (Date.now() - started > budgetMs) break;
    const s = await safe(portSync(r), { ok: false });
    out.ports++; if (s?.completed) out.ports_completed++; if (!s?.ok) out.errors++;
  }
  const { data: comps } = await safe(c.from('tenant_compliance').select('*').limit(500), { data: [] }) || {};
  const pending = (comps || []).filter((r) => r.brand_id && r.stage !== 'live' && r.stage !== 'awaiting_code').sort((a, b) => String(a.synced_at || '').localeCompare(String(b.synced_at || ''))).slice(0, limit);
  for (const r of pending) {
    if (Date.now() - started > budgetMs) break;
    const s = await safe(textingSync({ id: r.tenant_id }), { ok: false });
    out.texting++; if (!s?.ok) out.errors++;
  }
  return { ok: true, ...out };
}

/** Admin: retry the salon's campaign (clears a rejected one and resubmits). */
export async function retryCampaign(tenant) {
  const c = await client();
  const t = await freshTenant(c, tenant);
  const row = await complianceRow(c, t.id);
  if (!row?.brand_id) return { ok: false, error: 'no brand' };
  if (row.campaign_id && !REJECTED.has(row.campaign_status)) return { ok: false, error: 'campaign is not rejected (' + row.campaign_status + ')' };
  if (row.campaign_id) await saveCompliance(c, t.id, { campaign_id: null, campaign_status: null, numbers: [] });
  const b = telnyxData(await safe(telnyxRequest(`/10dlc/brand/${encodeURIComponent(row.brand_id)}`, { timeoutMs: 10000 }), null));
  const r = await createCampaignIfReady(c, t, row.brand_id, b || {}, { force: true });
  return { ok: !!r.created, ...r };
}

export const _internals = { APPROVED, REJECTED, OPTOUT_KEYWORDS, OPTIN_KEYWORDS, HELP_KEYWORDS, complianceRow, latestPort, orderIdsOf };
