/**
 * api/lib/lola-receipt.js — what Lola did for the salon, in one number.
 * ════════════════════════════════════════════════════════════════════
 * The owner's question is never "how many API calls" — it is
 * "what did she make me?". One definition, used everywhere:
 *
 *   · Home tile            GET /api/data?resource=overview → kpis.lola
 *   · Monday text          /api/cron/lola-receipt
 *   · Billing / paywall    (same numbers the trial texts already quote)
 *
 * "Booked by Lola" = bookings Lola made herself (phone, text, widget,
 * campaigns, gap-fill…), not cancelled or no-show, not synced from another
 * platform. It is exactly the set the booking-fee ledger already treats as
 * Lola's (booking-fees.js isBillable, scope 'lola'), so the receipt and the
 * invoice can never disagree.
 */
import { isBillable, feePolicy } from './booking-fees.js';

// Calls Lola did not hold a conversation on.
const NOT_ANSWERED = new Set(['no-answer', 'busy', 'failed', 'canceled', 'cancelled', 'missed', 'voicemail', 'abandoned']);
const DEAD = /^(cancel|no[-_ ]?show)/i;

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : (many || one + 's')}`;
export const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

/** Pure: rows in, receipt out. Exported for tests. */
export function summarizeReceipt({ calls = [], bookings = [] } = {}) {
  const policy = { ...feePolicy({}), scope: 'lola' };
  const answered = calls.filter((k) => {
    if (String(k?.direction || 'inbound') !== 'inbound') return false;
    return !NOT_ANSWERED.has(String(k?.status ?? k?.outcome ?? '').toLowerCase());
  }).length;
  const lola = bookings.filter((b) => b && !DEAD.test(String(b.status || '')) && isBillable(b, policy));
  const value = Math.round(lola.reduce((s, b) => s + (Number(b.total_amount ?? b.price) || 0), 0));
  return { answered, booked: lola.length, value, valueMoney: money(value) };
}

async function rows(p) {
  try { const r = await p; return (r && !r.error && Array.isArray(r.data)) ? r.data : []; } catch { return []; }
}

/** Receipt for one salon between two moments (ISO strings). Never throws. */
export async function lolaReceipt(c, tenantId, { since, until = new Date().toISOString() } = {}) {
  if (!c || !tenantId || !since) return summarizeReceipt();
  const [calls, bookings] = await Promise.all([
    rows(c.from('calls').select('id,direction,status').eq('tenant_id', tenantId).gte('created_at', since).lt('created_at', until).limit(5000)),
    rows(c.from('bookings').select('id,source,status,total_amount,external_id,external_provider').eq('tenant_id', tenantId).gte('created_at', since).lt('created_at', until).limit(5000)),
  ]);
  return summarizeReceipt({ calls, bookings });
}

/**
 * The Monday text. One sentence of proof, one link. Returns '' when there
 * is nothing worth a text — silence beats "0 calls this week".
 */
export function receiptText(r, { salon = '', link = '' } = {}) {
  if (!r || (!r.answered && !r.booked)) return '';
  const did = [];
  if (r.answered) did.push(`answered ${plural(r.answered, 'call')}`);
  if (r.booked) did.push(`booked ${plural(r.booked, 'appointment')}${r.value ? ` worth ${money(r.value)}` : ''}`);
  const at = salon ? ` at ${salon}` : '';
  return `Lola's week${at}: I ${did.join(' and ')}.${link ? ` ${link}` : ''}`;
}
