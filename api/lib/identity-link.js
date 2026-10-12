/**
 * api/lib/identity-link.js — one person, one memory, only when it's really them.
 * ════════════════════════════════════════════════════════════════
 * A number typed into Messenger, Instagram or the website chat proves nothing:
 * anyone can type anyone's number. So a typed number is only ever a CONTACT
 * number (for a new booking). To join a chat to the client's history:
 *
 *   1. they type their number → if that number is a client of THIS salon, a
 *      6-digit code is texted to it from the salon's own line (sendSMS);
 *   2. they type the code back in the same thread (10 minutes, 5 tries,
 *      3 codes an hour) → linked: their chat key remembers the verified phone,
 *      and what Lola learned in the chat joins the phone client's memory.
 *
 * Until step 2, nothing about that number's client is read, said or changed.
 * Everything is keyed by tenant: a link at one salon means nothing at another.
 */
import crypto from 'node:crypto';
import { getClientMemory, setClientMemory, mergeClientMemories } from './db.js';

export const PHONE_IN_DM = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/;
const CODE_IN_DM = /(?:^|[^\d])(\d{3})[\s-]?(\d{3})(?:[^\d]|$)/;
const CODE_TTL = 10 * 60e3, MAX_TRIES = 5, HOUR = 3600e3, DAY = 24 * HOUR;
// Shared, DB-backed limits (every thread, every instance): per number texted, and per salon.
export const LIMITS = { perPhoneHour: 3, perPhoneDay: 5, perTenantDay: 50 };
// A website visitor's link lasts 30 days (a shared computer must not stay "Sarah" forever); DM links stay.
export const WEB_LINK_TTL = 30 * DAY;

const k64 = (key) => String(key || '').slice(0, 64);   // the same trim setClientMemory applies to namespaced keys
const hash = (tenantId, key, phone, code) => crypto.createHash('sha256').update(`${tenantId}|${k64(key)}|${phone}|${code}`).digest('hex');
const short = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
const parse = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } } return v || null; };
async function memOf(tenantId, key) { try { return await getClientMemory(tenantId, k64(key)); } catch (_) { return []; } }
const pick = (rows, k) => parse((rows || []).find((r) => r && r.key === k)?.value);
async function drop(c, tenantId, key, k) { try { await c.from('client_memories').delete().eq('tenant_id', tenantId).eq('client_phone', k64(key)).eq('key', k); } catch (_) {} }

/**
 * Claim-then-count: write the attempt FIRST, then count the attempts in the window (ours included).
 * Two racing requests both see each other's claim, so the limit can never be exceeded — at worst
 * both are refused. Returns the claims (value.at) still inside `windowMs`.
 */
async function claim(c, tenantId, bucket, tag, now, windowMs) {
  const at = now;
  const key = `${tag}:${at}:${crypto.randomBytes(4).toString('hex')}`;
  const { error } = await c.from('client_memories').insert({ tenant_id: tenantId, client_phone: bucket, key, value: { at } });
  if (error) throw new Error('claim_failed');
  const { data } = await c.from('client_memories').select('key,value').eq('tenant_id', tenantId).eq('client_phone', bucket).limit(500);
  const rows = (data || []).filter((r) => String(r.key || '').startsWith(tag + ':'));
  // Old claims are swept as we go (best-effort).
  for (const r of rows) if (now - Number(parse(r.value)?.at || 0) > DAY) { try { await c.from('client_memories').delete().eq('tenant_id', tenantId).eq('client_phone', bucket).eq('key', r.key); } catch (_) {} }
  const times = rows.map((r) => Number(parse(r.value)?.at || 0)).filter((t) => now - t < windowMs);
  // Refused attempts give their claim back (so only real sends count); a racing pair both refuse, never both send.
  times.release = async () => { try { await c.from('client_memories').delete().eq('tenant_id', tenantId).eq('client_phone', bucket).eq('key', key); } catch (_) {} };
  return times;
}

async function defaultSend({ tenant, to, text }) {
  const { sendSMS } = await import('./telnyx.js');
  return sendSMS({ from: tenant.phone_number || undefined, to, text, tenantId: tenant.id });
}

/** The phone this chat key proved by code (null when never verified, or a website link that expired). */
export async function verifiedPhone(tenantId, key, now = Date.now()) {
  if (!tenantId || !key) return null;
  const v = pick(await memOf(tenantId, key), 'verified_link');
  if (!v || !/^\+\d{8,15}$/.test(String(v.phone || ''))) return null;
  if (v.exp && now > Number(v.exp)) return null;
  return String(v.phone);
}

/** The phone client this chat key is verified as (same salon), or null. */
export async function linkedClient(c, tenantId, key, now = Date.now()) {
  const phone = await verifiedPhone(tenantId, key, now);
  if (!phone || !c) return null;
  try {
    const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle();
    return data ? { client: data, phone } : null;
  } catch (_) { return null; }
}

/** The chat thread (fb:/ig: key) VERIFIED as this phone at this salon — how the owner's inbox replies find it. */
export async function verifiedChatKey(c, tenantId, phone, prefix, now = Date.now()) {
  if (!c || !tenantId || !phone) return null;
  try {
    const { data } = await c.from('client_memories').select('client_phone,value').eq('tenant_id', tenantId).eq('key', 'verified_link').limit(1000);
    const hit = (data || []).find((r) => String(r.client_phone || '').startsWith(prefix) && String(parse(r.value)?.phone || '') === String(phone) && !(parse(r.value)?.exp && now > Number(parse(r.value).exp)));
    return hit ? String(hit.client_phone) : null;
  } catch (_) { return null; }
}

/**
 * One inbound chat message. Returns what happened, never the client's history:
 *   { linked: phone, client }   the code matched — this IS the phone client now
 *   { contactPhone, … }         they typed a number: a contact for NEW bookings (and, only if it's a
 *                               client here and within limits, a code was texted — Lola's words are
 *                               the same either way, so nobody learns whether a number is on file)
 *   { badCode: true }           a code that doesn't match / expired / too many tries
 *   {}                          nothing to do
 */
export async function linkTurn(c, tenant, { key, channelClient = null, text = '', now = Date.now(), send = defaultSend } = {}) {
  const out = {};
  if (!c || !tenant?.id || !key) return out;
  const tid = tenant.id, ck = k64(key);
  const rows = await memOf(tid, ck);
  const linkedAlready = pick(rows, 'verified_link');
  if (linkedAlready && !(linkedAlready.exp && now > Number(linkedAlready.exp))) return out;
  const pending = pick(rows, 'link_code');
  const msg = String(text || '');
  const phoneMatch = msg.match(PHONE_IN_DM);
  const codeMatch = !phoneMatch && msg.match(CODE_IN_DM);

  if (codeMatch && pending?.hash) {
    const code = codeMatch[1] + codeMatch[2];
    if (now > Number(pending.exp || 0)) { await drop(c, tid, ck, 'link_code'); return { badCode: true, expired: true }; }
    // Every try is claimed before it's checked (shared across instances): the 6th is refused, right code or not.
    let tries = [];
    try { tries = await claim(c, tid, 'otptry:' + short(tid + '|' + ck), 'try-' + String(pending.id || ''), now, CODE_TTL * 2); } catch (_) { return { badCode: true }; }
    if (tries.length > MAX_TRIES) { await drop(c, tid, ck, 'link_code'); return { badCode: true, expired: true }; }
    const want = hash(tid, ck, pending.phone, code);
    const ok = want.length === String(pending.hash).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(pending.hash)));
    if (!ok) return { badCode: true };
    const { data: real } = await c.from('clients').select('*').eq('tenant_id', tid).eq('phone', pending.phone).maybeSingle();
    if (!real) { await drop(c, tid, ck, 'link_code'); return { badCode: true }; }
    const web = /^web:/.test(ck);
    await setClientMemory(tid, ck, 'verified_link', { phone: pending.phone, client_id: real.id, at: new Date(now).toISOString(), ...(web ? { exp: now + WEB_LINK_TTL } : {}) });
    await drop(c, tid, ck, 'link_code');
    try { await mergeClientMemories(tid, ck, pending.phone); } catch (_) {}
    return { linked: pending.phone, client: real };
  }

  if (!phoneMatch) return out;
  const phone = `+1${phoneMatch[1]}${phoneMatch[2]}${phoneMatch[3]}`;
  out.contactPhone = phone;
  try { await setClientMemory(tid, ck, 'contact_phone', { phone, at: new Date(now).toISOString() }); } catch (_) {}
  let real = null;
  try { ({ data: real } = await c.from('clients').select('id').eq('tenant_id', tid).eq('phone', phone).maybeSingle()); } catch (_) {}
  if (!real) return out;   // a new client: nothing to link, the number is just for booking
  // Limits are per number texted and per salon — not per thread (a new chat/visitor id changes nothing).
  try {
    const perPhone = await claim(c, tid, 'otp:' + phone, 'send', now, DAY);
    const perTenant = await claim(c, tid, 'otp:salon', 'send', now, DAY);
    if (perPhone.filter((t) => now - t < HOUR).length > LIMITS.perPhoneHour || perPhone.length > LIMITS.perPhoneDay || perTenant.length > LIMITS.perTenantDay) {
      await perPhone.release(); await perTenant.release();
      return { ...out, limited: true };
    }
  } catch (_) { return { ...out, limited: true }; }
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const id = crypto.randomBytes(6).toString('hex');
  // The pending code is saved (hashed) BEFORE the text goes out.
  await setClientMemory(tid, ck, 'link_code', { id, phone, hash: hash(tid, ck, phone, code), exp: now + CODE_TTL });
  const salon = tenant.name || 'Your salon';
  try { await send({ tenant, to: phone, text: `${salon}: your code is ${code}. Never share this code — type it only in your own chat with us to connect your appointments. Didn’t ask for it? Just ignore this text.` }); }
  catch (_) { await drop(c, tid, ck, 'link_code'); return { ...out, codeFailed: true }; }
  return { ...out, codeSent: true };
}

/** What Lola should know about this turn's link step (goes into answerClient's `extra`).
 *  A typed number always gets the SAME words — whether or not it's on file, a code went out or a limit hit. */
export function linkNote(r = {}, story = null) {
  if (r.linked) return `IDENTITY: they just confirmed their number with the texted code — this is ${story?.first || 'a returning client'}. Thank them and carry on; you can now look up, move or cancel THEIR bookings.`;
  if (r.badCode) return r.expired ? 'IDENTITY: that code has expired. Ask them to type their number again for a new one.' : 'IDENTITY: that code doesn’t match. Ask them to check the latest text and try again.';
  if (r.contactPhone) return `IDENTITY: they typed ${r.contactPhone}. Use it as client_phone for a NEW booking only. Tell them, in these words or close: "If that number is on file with us, I just texted it a code — type it here to connect your appointments." Never say whether the number is on file. Until a code is confirmed you know nothing about that number: never mention a name, visits or bookings for it, and never look up, move or cancel bookings for it.`;
  return '';
}
