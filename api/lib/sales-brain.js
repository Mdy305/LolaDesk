/**
 * api/lib/sales-brain.js — how Lola grows the ticket and keeps the book full, from the salon's REAL data.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *   • THE NEXT VISIT  every service has a natural refresh cycle (a cut ~6 weeks, balayage ~12). Lola
 *                     offers the next visit with the same stylist at the right moment.
 *   • THE RIGHT ADD-ON  only services the salon really sells, at their real price — never an invented
 *                     product. Paired to what the client is booking.
 *   • THE STYLIST'S PRICE  a senior stylist's own price (Team → services) is the price quoted, booked
 *                     and deposited — not the generic menu price.
 * Deterministic, no AI call: same input, same answer.
 */
import { db } from './db.js';

// Natural refresh cycles (days), first match wins. The salon's own setting is the fallback.
const CYCLES = [
  [/blow ?out|blowdry|style|updo|wash/i, 7],
  [/brow|lash lift|wax/i, 28],
  [/mani|pedi|nail|gel/i, 21],
  [/facial|peel|hydra/i, 35],
  [/extension|tape|i-?tip|weft/i, 56],
  [/balayage|highlight|ombre|babylight|foil/i, 84],
  [/keratin|botox|smooth|relax|brazilian/i, 90],
  [/root|colou?r|toner|gloss|grey|gray/i, 42],
  [/cut|trim|shape|fade|clipper/i, 42],
  [/treatment|mask|scalp|olaplex|k18/i, 28],
];
/** Days until this service is due again (the service's own setting first, then its nature, then the salon default). */
export function rebookIntervalDays(service, fallback = 42) {
  const own = Number(service?.rebook_days ?? service?.metadata?.rebook_days);
  if (Number.isFinite(own) && own > 0) return Math.round(own);
  const name = String(service?.name || service || '');
  const hit = CYCLES.find(([re]) => re.test(name));
  if (hit) return hit[1];
  const f = Math.round(Number(fallback));
  return Number.isFinite(f) && f > 0 ? f : 42;
}

// What pairs with what — matched against the salon's real menu only.
export const ADDON_PAIRS = [
  [/balayage|highlight|colou?r|toner|root|ombre|blond/i, /gloss|toner|bond|olaplex|k18|treatment|mask/i, 'it keeps the color glossy and the hair strong'],
  [/cut|trim|shape/i, /blow ?out|blowdry|style|scalp|treatment|mask|gloss/i, 'it finishes the look beautifully'],
  [/keratin|smooth|botox|relax/i, /gloss|treatment|mask|trim/i, 'it makes the results last longer'],
  [/extension/i, /blow ?out|treatment|style|care/i, 'it keeps the extensions looking seamless'],
  [/blow ?out|style|updo/i, /treatment|mask|scalp/i, 'the hair will feel incredible'],
  [/facial|peel|hydra/i, /mask|led|dermaplan|brow|lash/i, 'it boosts the glow'],
  [/mani|pedi|nail/i, /gel|art|paraffin|mask/i, 'it makes them last'],
  [/massage/i, /scalp|hot stone|aroma|cbd/i, 'it deepens the relaxation'],
];
const isAddonLike = (s) => /add.?on|addon|extra|upgrade/i.test(String(s?.category || '')) || /add.?on/i.test(String(s?.name || ''));

/**
 * Real add-ons for a base service: active, priced, short (≤ maxMin), paired by kind; the salon's own
 * "add-on" category counts too. Most valuable first. → [{ id, name, price, duration_minutes, pitch }]
 */
export function realAddons(services, base, { n = 2, maxMin = 60 } = {}) {
  const baseName = String(base?.name || base || '');
  const pair = ADDON_PAIRS.find(([m]) => m.test(baseName));
  const menu = (services || []).filter((s) => s && s.is_active !== false && s.id !== base?.id
    && String(s.name || '').toLowerCase() !== baseName.toLowerCase()
    && Number(s.price) > 0 && (!Number(s.duration_minutes) || Number(s.duration_minutes) <= maxMin));
  const picks = menu.map((s) => ({ s, good: (pair ? pair[1].test(s.name) : /treatment|mask|gloss|blow ?out/i.test(s.name)) || isAddonLike(s) }))
    .filter((x) => x.good)
    .sort((a, b) => Number(b.s.price) - Number(a.s.price))
    .slice(0, n);
  return picks.map(({ s }) => ({ id: s.id, name: s.name, price: Number(s.price), duration_minutes: Number(s.duration_minutes) || null, pitch: pair ? pair[2] : 'it makes the visit even better' }));
}

/** A stylist's own price for a service (Team → that stylist's services), or null when they use the menu price. */
export async function staffPrice(tenantId, staffId, serviceId) {
  if (!tenantId || !staffId || !serviceId) return null;
  try {
    const c = db(); if (!c) return null;
    const { data } = await c.from('staff_services').select('custom_price').eq('staff_id', staffId).eq('service_id', serviceId).maybeSingle();
    const p = Number(data?.custom_price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (_) { return null; }
}

/** Every stylist's own price for one service → [{ staff_id, name, price }] (only those that differ from the menu). */
export async function stylistPrices(tenantId, serviceId, menuPrice) {
  if (!tenantId || !serviceId) return [];
  try {
    const c = db(); if (!c) return [];
    const [{ data: links }, { data: staff }] = await Promise.all([
      c.from('staff_services').select('staff_id,custom_price').eq('service_id', serviceId),
      c.from('staff').select('id,name,is_active').eq('tenant_id', tenantId),
    ]);
    const names = new Map((staff || []).filter((s) => s.is_active !== false).map((s) => [s.id, s.name]));
    return (links || []).filter((l) => names.has(l.staff_id) && Number(l.custom_price) > 0 && Number(l.custom_price) !== Number(menuPrice))
      .map((l) => ({ staff_id: l.staff_id, name: names.get(l.staff_id), price: Number(l.custom_price) }))
      .sort((a, b) => a.price - b.price);
  } catch (_) { return []; }
}

/** The client's last kept visit (completed, or past and not cancelled / no-show). */
export async function lastVisit(tenantId, clientId) {
  if (!tenantId || !clientId) return null;
  try {
    const c = db(); if (!c) return null;
    const { data } = await c.from('bookings').select('id,service_id,staff_id,start_time,end_time,status')
      .eq('tenant_id', tenantId).eq('client_id', clientId).lte('start_time', new Date().toISOString())
      .order('start_time', { ascending: false }).limit(10);
    return (data || []).find((b) => !['cancelled', 'canceled', 'no_show', 'no-show', 'noshow'].includes(String(b.status || '').toLowerCase())) || null;
  } catch (_) { return null; }
}
