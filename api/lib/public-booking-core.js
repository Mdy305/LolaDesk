/**
 * api/lib/public-booking-core.js — the rules the PUBLIC booking page plays by.
 * ════════════════════════════════════════════════════════════════════════════
 * Used only by api/calendar.js when the request came through
 * /api/public-booking (an anonymous visitor on the salon's site):
 *
 *   • publicClient     — a visitor can never overwrite an existing client's
 *                        name/email: we only fill fields that are empty.
 *   • saveConsent      — the SMS consent the visitor gave on the form, kept on
 *                        the client row (clients.preferences jsonb).
 *   • depositQuote     — the deposit shown is computed by the SAME function that
 *                        charges it (deposits.depositAmountCents) on the same total.
 *   • policyWindow     — self-cancel / reschedule respects the salon's
 *                        cancellation_window_hours.
 *   • addonsAfter      — real menu add-ons the same stylist can do right after.
 */
import { db, e164 } from './db.js';
import { resolvePolicy, depositAmountCents, clientRisk, depositApplies } from './deposits.js';
import { getAvailability } from './availability-engine-v2.js';

const ms = (v) => new Date(v).getTime();

export function bookingRules(settings){
  const s = settings || {};
  const allowChoice = s.allow_staff_choice !== false;
  // Both switched off would make booking impossible — "anyone" stays on then.
  const allowAny = s.allow_any_staff !== false || !allowChoice;
  return {
    enabled: s.public_booking_enabled !== false,
    allow_staff_choice: allowChoice,
    allow_any_staff: allowAny,
    require_email: s.require_email === true,
    cancellation_window_hours: Math.max(0, Number(s.cancellation_window_hours) || 0),
    timezone: s.timezone || 'America/New_York',
  };
}

export function disabledMessage(tenant){
  const phone = tenant?.phone_number ? ` Please call ${tenant.phone_number} to book.` : ' Please contact the salon to book.';
  return `${tenant?.name || 'This salon'} isn't taking online bookings right now.${phone}`;
}

export const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
/** International phone: optional +, 8–15 digits. */
export const validPhone = (v) => { const d = String(v || '').replace(/[^\d]/g, ''); return d.length >= 8 && d.length <= 15 && /^[+\d\s().-]+$/.test(String(v || '').trim()); };

export async function findClientByPhone(tenantId, phone){
  const c = db(); const p = e164(phone);
  if(!c || !p) return null;
  const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', p).maybeSingle();
  return data || null;
}

/**
 * Find-or-create by phone. An existing client only gets EMPTY fields filled —
 * a stranger typing someone's number can't rename them or redirect their email.
 */
export async function publicClient(tenantId, { phone, name, email } = {}){
  const c = db(); const p = e164(phone);
  if(!c || !p) return null;
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() || null, last = parts.join(' ') || null;
  const mail = email && validEmail(email) ? String(email).trim().toLowerCase() : null;
  const existing = await findClientByPhone(tenantId, p);
  if(existing){
    const patch = {};
    const placeholder = !existing.first_name || /^(client|website visitor)$/i.test(String(existing.first_name));
    if(placeholder && first) patch.first_name = first;
    if(!existing.last_name && last && placeholder) patch.last_name = last;
    if(!existing.email && mail) patch.email = mail;
    if(!Object.keys(patch).length) return existing;
    patch.updated_at = new Date().toISOString();
    const { data } = await c.from('clients').update(patch).eq('id', existing.id).eq('tenant_id', tenantId).select().maybeSingle();
    return data || { ...existing, ...patch };
  }
  const row = { tenant_id: tenantId, first_name: first || 'Client', last_name: last, phone: p, email: mail, updated_at: new Date().toISOString() };
  const { data, error } = await c.from('clients').insert(row).select().maybeSingle();
  if(error) throw error;
  return data;
}

/**
 * The consent the visitor gave on the form (transactional texts about this
 * appointment), with the exact copy version they saw. Lives in
 * clients.preferences (jsonb); a schema without it simply skips — consent is
 * still implied by the form, the booking never fails over bookkeeping.
 */
export async function saveConsent(tenantId, client, { consent, version, source = 'public_booking' } = {}){
  const c = db();
  if(!c || !client?.id || !consent) return false;
  try{
    const prefs = (client.preferences && typeof client.preferences === 'object') ? client.preferences : {};
    const value = { scope: consent === true || consent === 'true' ? 'transactional' : String(consent).slice(0, 40), text_version: version ? String(version).slice(0, 40) : null, at: new Date().toISOString(), source };
    const { error } = await c.from('clients').update({ preferences: { ...prefs, sms_consent: value } }).eq('id', client.id).eq('tenant_id', tenantId);
    return !error;
  }catch(_){ return false; }
}

export function collectsDeposits(policy){ return !!(policy && policy.enabled && process.env.STRIPE_SECRET_KEY); }

/** Per-service deposit in cents, exactly what requestDeposit would charge on that price. */
export function serviceDepositCents(price, policy){
  if(!collectsDeposits(policy)) return 0;
  return depositAmountCents(price, policy) || 0;
}

/**
 * The deposit for a selection (one or more services), for a client if we know them.
 * → { required: true|false, maybe: bool, amount_cents }
 *   maybe:true = the salon asks only some clients (new / missed visits) and we
 *   don't know yet who this is.
 */
export async function depositQuote(tenantId, settings, { services = [], phone = null } = {}){
  const policy = resolvePolicy(settings);
  if(!collectsDeposits(policy)) return { required: false, maybe: false, amount_cents: 0 };
  const total = services.reduce((s, x) => s + (Number(x?.price) || 0), 0);
  const cents = depositAmountCents(total, policy) || 0;
  if(!cents) return { required: false, maybe: false, amount_cents: 0 };
  if(policy.who === 'everyone') return { required: true, maybe: false, amount_cents: cents };
  if(!phone || !e164(phone)) return { required: false, maybe: true, amount_cents: cents };
  const client = await findClientByPhone(tenantId, phone).catch(() => null);
  const risk = await clientRisk(tenantId, client?.id || null);
  const applies = depositApplies(policy, risk);
  return { required: applies, maybe: false, amount_cents: applies ? cents : 0 };
}

/** Inside the cancellation window → the client calls the salon instead. */
export function policyWindow(startIso, rules, now = Date.now()){
  const h = rules?.cancellation_window_hours || 0;
  if(!h) return { inside: false, hours: 0 };
  return { inside: ms(startIso) - now < h * 3600e3, hours: h };
}

const ADDON_HINT = /add[- ]?on|extra|enhance|upgrade/i;
const PAIRS = [
  [/balayage|highlight|colou?r|toner|root|ombre/i, /gloss|toner|bond|olaplex|k18|treatment|mask|blow ?out/i],
  [/cut|trim|shape/i, /blow ?out|blowdry|style|scalp|treatment|mask|gloss/i],
  [/keratin|smooth|botox|relax/i, /gloss|treatment|mask|trim/i],
  [/extension/i, /blow ?out|treatment|style/i],
  [/blow ?out|style|updo/i, /treatment|mask|scalp/i],
  [/facial|peel|hydra/i, /mask|led|dermaplan|brow|lash/i],
  [/mani|pedi|nail/i, /gel|art|paraffin|mask/i],
  [/massage/i, /scalp|hot stone|aroma|cbd/i],
];

/**
 * Can this stylist do `service` starting exactly at `startIso` (straight after
 * the client's previous service)? Uses the engine's own view of the stylist's
 * day — shift, bookings, holds, time off, blocks, the salon's external
 * calendar — rather than the slot grid, because back-to-back starts rarely
 * land on the grid (a 45-minute cut ends at :45).
 */
export async function fitsBackToBack({ tenantId, service, staffId, startIso, avail = getAvailability }){
  if(!service || !staffId || !startIso) return null;
  const av = await avail({ tenantId, serviceId: service.id, date: startIso, staffId, limit: 1, context: true }).catch(() => null);
  const d = av?.day?.[staffId];
  if(!d) return null;
  const s = ms(startIso), e = s + (Number(service.duration_minutes) || 60) * 60e3;
  if(s < ms(d.shift[0]) || e > ms(d.shift[1])) return null;
  if((d.busy || []).some((b) => ms(b.start) < e && ms(b.end) > s)) return null;
  return { starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString() };
}

/**
 * Real menu add-ons the same stylist can start the moment the main service
 * ends. Never invented items or prices — only active, priced services ≤ maxMin.
 */
export async function addonsAfter({ tenantId, services, serviceId, staffId, endsAt, max = 3, maxMin = 45, avail = getAvailability }){
  if(!staffId || !endsAt) return [];
  const base = (services || []).find((s) => s.id === serviceId);
  const pair = PAIRS.find(([m]) => m.test(String(base?.name || '')));
  const cands = (services || []).filter((s) => s.id !== serviceId && s.is_active !== false && Number(s.price) > 0
    && Number(s.duration_minutes) > 0 && Number(s.duration_minutes) <= maxMin
    && (ADDON_HINT.test(String(s.category || '')) || ADDON_HINT.test(String(s.name || '')) || (pair ? pair[1].test(s.name) : /treatment|mask|gloss|blow ?out/i.test(s.name))));
  cands.sort((a, b) => Number(ADDON_HINT.test(String(b.category || ''))) - Number(ADDON_HINT.test(String(a.category || ''))) || Number(b.price) - Number(a.price));
  const out = [];
  const end = new Date(endsAt).toISOString();
  for(const s of cands){
    if(out.length >= max) break;
    if(await fitsBackToBack({ tenantId, service: s, staffId, startIso: end, avail })){
      out.push({ id: s.id, name: s.name, description: s.description || '', price: Number(s.price), duration_minutes: Number(s.duration_minutes) });
    }
  }
  return out;
}

/** Does the booking_services table exist here? (multi-service bookings) */
export async function hasBookingServices(c = db()){
  try{ const { error } = await c.from('booking_services').select('id').limit(1); return !error; }catch(_){ return false; }
}

export function publicHold(hold, slot){
  if(!hold) return null;
  return { hold_token: hold.hold_token, expires_at: hold.expires_at, staff_id: hold.staff_id, service_id: hold.service_id,
    starts_at: hold.starts_at, ends_at: hold.ends_at, staff_name: slot?.staff_name || null };
}
