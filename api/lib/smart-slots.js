/**
 * api/lib/smart-slots.js — the booking brain: which times Lola offers, and with whom.
 * ════════════════════════════════════════════════════════════════════════════════
 * A salon earns money only for chair time that gets sold. "First available" leaves the day full
 * of 20-minute holes nobody can book. Lola works like the best front-desk manager:
 *
 *   • PACK   Prefer times that touch an existing appointment or the start/end of a shift.
 *   • NO DEAD TIME  Never leave a hole too short to sell (shorter than the salon's shortest
 *            service) when another time doesn't.
 *   • PROCESSING  Put a short service inside another client's processing time (color
 *            developing) — pure extra revenue from the same chair.
 *   • THE RIGHT STYLIST  The client's usual stylist first; otherwise whoever's day it packs best.
 *   • WHAT THEY ASKED  The time they asked for wins when it's free; otherwise the nearest smart times.
 *   • NEVER "NOTHING TODAY"  A full day rolls to the next days automatically.
 *   • ONE TIME, ONCE  Two stylists free at 11:00 is one option ("11"), not "11, 11, 11:30".
 *
 * Every decision is deterministic and explained (reasons[]), so the owner can trust it.
 */
import { getAvailability } from './availability-engine-v2.js';
import { db } from './db.js';
import { getBookingSettings } from './booking-repository.js';

const ms = (v) => (typeof v === 'number' ? v : new Date(v).getTime());
const MIN = 60000;

/** The client's usual stylist (most recent kept appointment). */
export async function usualStylist(tenantId, clientId) {
  if (!tenantId || !clientId) return null;
  try {
    const c = db(); if (!c) return null;
    const { data } = await c.from('bookings').select('staff_id,status,start_time').eq('tenant_id', tenantId).eq('client_id', clientId)
      .lt('start_time', new Date().toISOString()).order('start_time', { ascending: false }).limit(5);
    const kept = (data || []).find((b) => b.staff_id && !['cancelled', 'canceled', 'no_show'].includes(String(b.status || '').toLowerCase()));
    return kept ? kept.staff_id : null;
  } catch (_) { return null; }
}

/** Shortest sellable service at the salon (anything shorter than this is a dead hole). */
function shortestService(services) {
  const d = (services || []).filter((s) => s && s.is_active !== false)
    .map((s) => Number(s.duration_minutes || (Number(s.active_duration_1_min || 0) + Number(s.processing_duration_min || 0) + Number(s.active_duration_2_min || 0)) || 0))
    .filter((x) => x >= 10);
  return d.length ? Math.min(...d) : 30;
}

/**
 * Score one candidate slot for one stylist's day. Higher is better.
 * Exported for tests and for the owner's "why this time" explanations.
 */
export function scoreSlot(slot, dayOfStaff, { minSellable = 30, wantAt = null, usual = null } = {}) {
  const reasons = [];
  let score = 0;
  if (!dayOfStaff) return { score, reasons };
  const before = dayOfStaff.buffers?.before || 0, after = dayOfStaff.buffers?.after || 0;
  const ws = ms(slot.starts_at) - before * MIN, we = ms(slot.ends_at) + after * MIN;
  const [shiftS, shiftE] = dayOfStaff.shift.map(ms);
  // Appointments this slot sits inside (only possible in processing time).
  const inside = dayOfStaff.busy.filter((b) => b.booking && ms(b.start) < we && ms(b.end) > ws);
  if (inside.length) { score += 45; reasons.push('fills processing time'); }
  const others = dayOfStaff.busy.filter((b) => !inside.includes(b));
  let prev = shiftS, prevIsBooking = false, next = shiftE, nextIsBooking = false;
  for (const b of others) {
    const bs = ms(b.start), be = ms(b.end);
    if (be <= ws && be > prev) { prev = be; prevIsBooking = !!b.booking; }
    if (bs >= we && bs < next) { next = bs; nextIsBooking = !!b.booking; }
  }
  const gapBefore = Math.max(0, Math.round((ws - prev) / MIN));
  const gapAfter = Math.max(0, Math.round((next - we) / MIN));
  if (!inside.length) {
    if (gapBefore === 0) { score += prevIsBooking ? 30 : 18; reasons.push(prevIsBooking ? 'right after another client' : 'first of the shift'); }
    if (gapAfter === 0) { score += nextIsBooking ? 30 : 18; reasons.push(nextIsBooking ? 'right before another client' : 'last of the shift'); }
    if (gapBefore > 0 && gapBefore < minSellable) { score -= 50; reasons.push(`would leave ${gapBefore} unsellable minutes before`); }
    if (gapAfter > 0 && gapAfter < minSellable) { score -= 50; reasons.push(`would leave ${gapAfter} unsellable minutes after`); }
  }
  if (usual && slot.staff_id === usual) { score += 35; reasons.push('their usual stylist'); }
  if (wantAt != null) {
    const away = Math.abs(ms(slot.starts_at) - ms(wantAt)) / MIN;
    if (away < 1) { score += 1000; reasons.push('the time they asked for'); }
    else score -= (away / 15) * 8;
  }
  // Tie-breaks: a stylist with more booked time today keeps others' long blocks open; then earlier.
  const booked = dayOfStaff.busy.filter((b) => b.booking).reduce((s, b) => s + (ms(b.end) - ms(b.start)) / MIN, 0);
  score += Math.min(6, booked / 60);
  score -= (ms(slot.starts_at) - shiftS) / MIN / 2000;
  return { score: Math.round(score * 100) / 100, reasons, gap_before: gapBefore, gap_after: gapAfter };
}

/** One day: every free (stylist, time), scored; one best stylist per time. */
export async function rankDay({ tenantId, serviceId, date, staffId = null, wantAt = null, usual = null, excludeBookingId = null, avail = getAvailability }) {
  const av = await avail({ tenantId, serviceId, date, staffId, limit: 5000, excludeBookingId, context: true });
  if (!av?.ok) return { ok: false, error: av?.error || 'unavailable', slots: [] };
  const minSellable = shortestService(av.services);
  const best = new Map();
  for (const s of av.slots || []) {
    const sc = scoreSlot(s, av.day?.[s.staff_id], { minSellable, wantAt, usual });
    const row = { ...s, score: sc.score, reasons: sc.reasons, gap_before: sc.gap_before, gap_after: sc.gap_after };
    const k = new Date(s.starts_at).toISOString();
    if (!best.has(k) || best.get(k).score < row.score) best.set(k, row);
  }
  const slots = [...best.values()].sort((a, b) => b.score - a.score || ms(a.starts_at) - ms(b.starts_at));
  return { ok: true, slots, settings: av.settings, service: av.service, time_zone: av.settings?.timezone || 'America/New_York' };
}

/** Pick N to offer: the best, then spread through the day so the client has a real choice. */
export function pickOffers(ranked, n = 3, spreadMin = 90) {
  const out = [];
  for (const s of ranked) {
    if (out.length >= n) break;
    if (out.every((o) => Math.abs(ms(o.starts_at) - ms(s.starts_at)) >= spreadMin * MIN)) out.push(s);
  }
  for (const s of ranked) { if (out.length >= n) break; if (!out.includes(s)) out.push(s); }
  return out.sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
}

const dayKey = (d, tz) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
const addDaysKey = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The times Lola offers. Starts on the asked day (or today), rolls forward up to `days` when a day
 * is full. wantAt (an instant) puts the asked time first when it's free, else the nearest smart ones.
 * → { ok, offers[], ranked[], date, rolled_days, exact }
 */
export async function findSmartSlots({ tenantId, serviceId, date = null, wantAt = null, staffId = null, clientId = null, days = 14, n = 3, excludeBookingId = null, avail = getAvailability, tz = null }) {
  const usual = staffId ? null : await usualStylist(tenantId, clientId);
  let zone = tz;
  if (!zone) { try { zone = (await getBookingSettings(tenantId))?.timezone || 'America/New_York'; } catch (_) { zone = 'America/New_York'; } }
  // Work in the salon's calendar days (a bare "2026-10-05" is that day in the salon, not UTC midnight).
  const raw = date || wantAt || new Date();
  const first = /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? String(raw) : (Number.isNaN(new Date(raw).getTime()) ? null : dayKey(raw, zone));
  if (!first) return { ok: false, error: 'invalid_date', offers: [], ranked: [] };
  for (let i = 0; i <= days; i++) {
    const key = addDaysKey(first, i);
    const r = await rankDay({ tenantId, serviceId, date: key, staffId, wantAt: i === 0 ? wantAt : null, usual, excludeBookingId, avail });
    if (!r.ok) return { ok: false, error: r.error, offers: [], ranked: [] };
    if (r.slots.length) {
      const exact = !!(wantAt && i === 0 && r.slots[0] && Math.abs(ms(r.slots[0].starts_at) - ms(wantAt)) < MIN);
      const offers = exact ? [r.slots[0]] : (wantAt && i === 0 ? r.slots.slice(0, n).sort((a, b) => ms(a.starts_at) - ms(b.starts_at)) : pickOffers(r.slots, n));
      return { ok: true, offers, ranked: r.slots, date: key, rolled_days: i, exact, time_zone: zone };
    }
  }
  return { ok: true, offers: [], ranked: [], date: null, rolled_days: days, exact: false, time_zone: zone };
}

/** No stylist named: who should take this exact time? (usual stylist, else best packing). */
export async function bestStaffAt({ tenantId, serviceId, startsAt, clientId = null, avail = getAvailability }) {
  const usual = await usualStylist(tenantId, clientId);
  const av = await avail({ tenantId, serviceId, date: startsAt, limit: 5000, context: true });
  if (!av?.ok) return null;
  const minSellable = shortestService(av.services);
  const at = ms(startsAt);
  const cands = (av.slots || []).filter((s) => Math.abs(ms(s.starts_at) - at) < MIN)
    .map((s) => ({ s, sc: scoreSlot(s, av.day?.[s.staff_id], { minSellable, usual }) }))
    .sort((a, b) => b.sc.score - a.sc.score);
  return cands[0] ? { staff_id: cands[0].s.staff_id, staff_name: cands[0].s.staff_name, reasons: cands[0].sc.reasons } : null;
}

/**
 * The add-on that fits: a real service on the salon's menu, short, priced, that the same stylist
 * can do right after this booking (their time is free). Never an invented product or price.
 */
const PAIRS = [
  [/balayage|highlight|colou?r|toner|root|ombre/i, /gloss|toner|bond|olaplex|k18|treatment|mask/i],
  [/cut|trim|shape/i, /blow ?out|blowdry|style|scalp|treatment|mask|gloss/i],
  [/keratin|smooth|botox|relax/i, /gloss|treatment|mask|trim/i],
  [/extension/i, /blow ?out|treatment|style/i],
  [/blow ?out|style|updo/i, /treatment|mask|scalp/i],
  [/facial|peel|hydra/i, /mask|led|dermaplan|brow|lash/i],
  [/mani|pedi|nail/i, /gel|art|paraffin|mask/i],
  [/massage/i, /scalp|hot stone|aroma|cbd/i],
];
export async function fitsAfter({ tenantId, booking, services, avail = getAvailability, maxMin = 45 }) {
  if (!booking?.staff_id || !booking?.end_time) return null;
  // Already an add-on to something they booked just before? Offer once, never stack.
  if (booking.client_id) {
    try { const { data } = await db().from('bookings').select('id,end_time,status').eq('tenant_id', tenantId).eq('client_id', booking.client_id).neq('id', booking.id).limit(50);
      if ((data || []).some((b) => !['cancelled', 'canceled'].includes(String(b.status || '').toLowerCase()) && b.end_time && Math.abs(ms(b.end_time) - ms(booking.start_time)) < 20 * MIN)) return null; } catch (_) {}
  }
  const base = (services || []).find((s) => s.id === booking.service_id);
  const pair = PAIRS.find(([m]) => m.test(String(base?.name || '')));
  const menu = (services || []).filter((s) => s.id !== booking.service_id && s.is_active !== false && Number(s.price) > 0 && Number(s.duration_minutes || 0) > 0 && Number(s.duration_minutes) <= maxMin);
  const ranked = menu.map((s) => ({ s, good: pair ? pair[1].test(s.name) : /treatment|mask|gloss|blow ?out/i.test(s.name) }))
    .filter((x) => x.good).sort((a, b) => Number(b.s.price) - Number(a.s.price));
  for (const { s } of ranked) {
    const av = await avail({ tenantId, serviceId: s.id, date: booking.end_time, staffId: booking.staff_id, limit: 5000 });
    const end = ms(booking.end_time);
    const slot = (av?.slots || []).find((x) => ms(x.starts_at) >= end && ms(x.starts_at) - end <= 20 * MIN);
    if (slot) return { service_id: s.id, name: s.name, price: Number(s.price), duration_minutes: Number(s.duration_minutes), starts_at: slot.starts_at, staff_id: booking.staff_id, staff_name: slot.staff_name };
  }
  return null;
}
