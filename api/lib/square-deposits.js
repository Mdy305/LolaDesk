/**
 * api/lib/square-deposits.js — did the money really reach the bank?
 * ════════════════════════════════════════════════════════════════
 * Read-only (PAYOUTS_READ). Square sends a salon's card money to its bank in payouts; every payout lists
 * its entries (each card charge, Square's fees, refunds, adjustments). Lola reads them all and matches
 * EVERY sale to the deposit that paid it:
 *
 *   importPayouts(c, integration)   → salon_payouts + salon_payout_entries (13 months back, then the last
 *                                      30 days re-read each run: a payout goes SENT → PAID or FAILED)
 *   reconcile(c, tenant, {days})    → totals (card sales, refunds, Square fees, expected, deposited,
 *                                      on its way, failed), each card sale's state (deposited / on its way /
 *                                      waiting / missing / failed), cash and paid-outside-Square kept apart,
 *                                      payouts whose lines don't add up, and the issues — biggest first.
 *   depositAlerts(c, tenant)        → texts the owner once per new problem (failed deposit, missing money).
 */
const DAY = 864e5;
const cents = (m) => Math.round(Number(m?.amount) || 0);
const dollars = (c) => Math.round((Number(c) || 0) / 100);
const money2 = (c) => { const n = (Number(c) || 0) / 100; return (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const metaKey = (tid) => 'square_payouts:' + tid;
const SETTLE_DAYS = 7;          // card money normally lands in 1–2 business days; 7 calendar days = something's wrong
const NOT_SQUARE_SETTLED = /^(CASH|EXTERNAL|SQUARE_ACCOUNT|BUY_NOW_PAY_LATER_EXTERNAL)$/;

async function tables() {
  try { const { ensurePayoutsSchema } = await import('./migrate.js'); const s = await ensurePayoutsSchema(); return s === 'up-to-date' || s === 'applied'; } catch (_) { return false; }
}
async function getMeta(c, tid) { try { const { data } = await c.from('platform_settings').select('value').eq('key', metaKey(tid)).maybeSingle(); return data?.value || {}; } catch (_) { return {}; } }
async function setMeta(c, tid, v) { try { await c.from('platform_settings').upsert({ key: metaKey(tid), value: v, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch (_) {} }
const mask = (id) => (id ? '…' + String(id).slice(-4) : null);

/** Square payouts + their entries into the deposit tables. Resumable within a time budget. */
export async function importPayouts(c, integ, { now = Date.now(), budgetMs = 20000 } = {}) {
  const started = Date.now();
  if (!(await tables())) return { ok: false, error: 'tables_missing' };
  const S = await import('./connectors/square.js');
  const tid = integ.tenant_id;
  const meta = await getMeta(c, tid);
  const since = meta.backfilled ? now - 30 * DAY : now - 400 * DAY;
  const loc = integ.metadata?.location_id || null;
  let cursor = null, pages = 0, seen = 0, error = null;
  try {
    do {
      const q = new URLSearchParams({ begin_time: new Date(since).toISOString(), end_time: new Date(now).toISOString(), sort_order: 'DESC', limit: '100' });
      if (loc) q.set('location_id', loc);
      if (cursor) q.set('cursor', cursor);
      const d = await S.squareCall(integ, `/v2/payouts?${q}`);
      const rows = (d.payouts || []).map((p) => ({ tenant_id: tid, provider: 'square', external_id: p.id, status: String(p.status || '').toUpperCase() || null,
        amount_cents: cents(p.amount_money), fee_cents: (p.payout_fee || []).reduce((t, f) => t + cents(f.amount_money), 0), currency: p.amount_money?.currency || null,
        arrival_date: p.arrival_date || null, created_ext: p.created_at || null, destination_type: p.destination?.type || null, destination_ref: mask(p.destination?.id),
        payout_type: p.type || null, entries: p.number_of_entries ?? null, location_ref: p.location_id || null, synced_at: new Date().toISOString() }));
      if (rows.length) { const r = await c.from('salon_payouts').upsert(rows, { onConflict: 'tenant_id,provider,external_id' }); if (r?.error) throw new Error(r.error.message); }
      seen += rows.length;
      cursor = d.cursor || null;
    } while (cursor && ++pages < 20 && Date.now() - started < budgetMs);
  } catch (e) { error = String(e?.message || e).slice(0, 200); }
  // Entries for every payout not read yet (newest first).
  let loaded = 0;
  if (!error) {
    const { data: all } = await c.from('salon_payouts').select('id,external_id,entries_loaded,created_ext').eq('tenant_id', tid).eq('provider', 'square').order('created_ext', { ascending: false }).limit(2000).then((x) => x, () => ({ data: [] }));
    const todo = (all || []).filter((p) => p.entries_loaded !== true);
    for (const p of todo) {
      if (Date.now() - started > budgetMs) break;
      try {
        let cur = null, pg = 0, net = 0;
        const list = [];
        do {
          const q = new URLSearchParams({ limit: '100' }); if (cur) q.set('cursor', cur);
          const d = await S.squareCall(integ, `/v2/payouts/${encodeURIComponent(p.external_id)}/payout-entries?${q}`);
          for (const e of d.payout_entries || []) {
            const det = e.type_charge_details || e.type_refund_details || e.type_hold_adjustment_details || e.type_fee_details || {};
            net += cents(e.net_amount_money);
            list.push({ tenant_id: tid, provider: 'square', payout_ref: p.external_id, external_id: e.id, entry_type: String(e.type || '').toUpperCase() || null, effective_at: e.effective_at || null,
              gross_cents: cents(e.gross_amount_money), fee_cents: cents(e.fee_amount_money), net_cents: cents(e.net_amount_money), payment_ref: det.payment_id || null, refund_ref: det.refund_id || null, synced_at: new Date().toISOString() });
          }
          cur = d.cursor || null;
        } while (cur && ++pg < 50);
        for (let i = 0; i < list.length; i += 500) { const r = await c.from('salon_payout_entries').upsert(list.slice(i, i + 500), { onConflict: 'tenant_id,provider,external_id' }); if (r?.error) throw new Error(r.error.message); }
        await c.from('salon_payouts').update({ entries_loaded: true, entries_net_cents: net, entries: list.length }).eq('id', p.id);
        loaded++;
      } catch (e) { error = String(e?.message || e).slice(0, 200); break; }
    }
  }
  const { data: left } = await c.from('salon_payouts').select('id,entries_loaded').eq('tenant_id', tid).eq('provider', 'square').limit(2000).then((x) => x, () => ({ data: [] }));
  const done = !error && !(left || []).some((p) => p.entries_loaded !== true);
  await setMeta(c, tid, { ...meta, backfilled: meta.backfilled || done, updated_at: new Date(now).toISOString(), last_error: error });
  return { ok: !error, error, payouts: seen, entries_loaded: loaded, backfilled: meta.backfilled || done };
}

/** Match every sale to its deposit. Pure over the rows (loaded here from the tables). */
export function reconcileRows({ sales = [], payouts = [], entries = [], now = Date.now(), days = 90, names = new Map() }) {
  const from = new Date(now - days * DAY).toISOString().slice(0, 10);
  const byPayout = new Map(payouts.map((p) => [p.external_id, p]));
  const entryOfPayment = new Map();
  for (const e of entries) if (e.payment_ref && /CHARGE|HOLD_ADJUSTMENT|PAYMENT/.test(e.entry_type || '')) { if (!entryOfPayment.has(e.payment_ref) || /CHARGE/.test(e.entry_type)) entryOfPayment.set(e.payment_ref, e); }
  const inWin = sales.filter((s) => String(s.day) >= from);
  const card = [], cash = [], outside = [];
  for (const s of inWin) {
    const src = String(s.source || '').toUpperCase();
    if (src === 'CASH') cash.push(s); else if (NOT_SQUARE_SETTLED.test(src)) outside.push(s); else card.push(s);
  }
  const state = (s) => {
    const e = entryOfPayment.get(s.external_id);
    if (e) { const p = byPayout.get(e.payout_ref); const st = String(p?.status || '').toUpperCase();
      return st === 'PAID' ? { st: 'deposited', payout: p, entry: e } : st === 'FAILED' ? { st: 'failed', payout: p, entry: e } : { st: 'on_its_way', payout: p, entry: e }; }
    const age = (now - Date.parse(s.occurred_at || s.day + 'T17:00:00Z')) / DAY;
    return age > SETTLE_DAYS ? { st: 'missing' } : { st: 'waiting' };
  };
  const rows = card.map((s) => ({ ...s, ...state(s) }));
  const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const of = (st) => rows.filter((r) => r.st === st);
  const winPayouts = payouts.filter((p) => String(p.arrival_date || p.created_ext || '').slice(0, 10) >= from);
  const totals = {
    card_sales: sum(card, (s) => s.net_cents), refunds: sum(inWin, (s) => s.refunded_cents), square_fees: sum(card, (s) => s.fee_cents),
    cash_sales: sum(cash, (s) => s.net_cents), cash_count: cash.length, outside_sales: sum(outside, (s) => s.net_cents),
    deposited: sum(of('deposited'), (r) => r.net_cents - (r.fee_cents || 0)), on_its_way: sum(of('on_its_way'), (r) => r.net_cents - (r.fee_cents || 0)),
    waiting: sum(of('waiting'), (r) => r.net_cents - (r.fee_cents || 0)), missing: sum(of('missing'), (r) => r.net_cents - (r.fee_cents || 0)),
    failed: sum(of('failed'), (r) => r.net_cents - (r.fee_cents || 0)),
    payouts_paid: sum(winPayouts.filter((p) => p.status === 'PAID'), (p) => p.amount_cents), payouts_count: winPayouts.length,
    counts: { card: card.length, deposited: of('deposited').length, on_its_way: of('on_its_way').length, waiting: of('waiting').length, missing: of('missing').length, failed: of('failed').length },
  };
  totals.expected = totals.card_sales - totals.square_fees;
  totals.fee_rate = totals.card_sales ? Math.round((totals.square_fees / totals.card_sales) * 1000) / 10 : null;
  // Payouts whose lines don't add up to what was sent (a hold, a dispute, an adjustment to look at).
  const mismatched = winPayouts.filter((p) => p.entries_loaded && p.entries_net_cents != null && Math.abs(Number(p.entries_net_cents) - Number(p.amount_cents) - Number(p.fee_cents || 0)) > 100);
  const adjustments = entries.filter((e) => /DISPUTE|HOLD|RESERVE|ADJUSTMENT|CHARGEBACK|REVERSAL/.test(e.entry_type || '') && !/^HOLD_ADJUSTMENT$/.test(e.entry_type) && String(e.effective_at || '').slice(0, 10) >= from);
  const who = (r) => names.get(r.customer_ref) || (r.customer_ref ? 'Square client' : 'Walk-in');
  const issues = [];
  for (const p of winPayouts.filter((x) => x.status === 'FAILED')) issues.push({ key: 'failed:' + p.external_id, severity: 3, amount_cents: p.amount_cents,
    title: `A ${money2(p.amount_cents)} deposit failed`, detail: `Square couldn't send it to ${p.destination_type === 'BANK_ACCOUNT' ? 'your bank account ' + (p.destination_ref || '') : 'your account'}${p.arrival_date ? ' (due ' + p.arrival_date + ')' : ''}. Check your bank details in Square → Balance → Transfers.`, payout: p.external_id });
  const miss = of('missing');
  if (miss.length) issues.push({ key: 'missing:' + miss.map((r) => r.external_id).sort().join(',').slice(0, 300), severity: 2, amount_cents: sum(miss, (r) => r.net_cents),
    title: `${miss.length} card payment${miss.length === 1 ? '' : 's'} (${money2(sum(miss, (r) => r.net_cents))}) not paid out after ${SETTLE_DAYS}+ days`,
    detail: miss.slice(0, 5).map((r) => `${who(r)} · ${money2(r.net_cents)} on ${r.day}`).join('; ') + (miss.length > 5 ? '…' : '') + '. Square may be holding them — check Square → Balance.', payments: miss.map((r) => r.external_id).slice(0, 50) });
  for (const p of mismatched) issues.push({ key: 'mismatch:' + p.external_id, severity: 2, amount_cents: Math.abs(Number(p.entries_net_cents) - Number(p.amount_cents)),
    title: `Deposit of ${p.arrival_date || ''} doesn't add up`, detail: `Its lines total ${money2(p.entries_net_cents)} but ${money2(p.amount_cents)} was sent — a hold, dispute or adjustment. Open it in Square → Balance → Transfers.`, payout: p.external_id });
  for (const e of adjustments.slice(0, 5)) issues.push({ key: 'adj:' + e.external_id, severity: e.net_cents < 0 ? 2 : 1, amount_cents: Math.abs(e.net_cents),
    title: `${e.entry_type.replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase())}: ${money2(e.net_cents)}`, detail: `Taken in the deposit of ${byPayout.get(e.payout_ref)?.arrival_date || 'its payout'}.`, payout: e.payout_ref });
  issues.sort((a, b) => b.severity - a.severity || b.amount_cents - a.amount_cents);
  const recent = winPayouts.sort((a, b) => String(b.arrival_date || b.created_ext).localeCompare(String(a.arrival_date || a.created_ext))).slice(0, 40)
    .map((p) => ({ id: p.external_id, status: p.status, amount: p.amount_cents, fee: p.fee_cents, arrival_date: p.arrival_date, destination: p.destination_type, destination_ref: p.destination_ref, entries: p.entries, adds_up: !mismatched.includes(p) }));
  return { ok: true, days, totals, issues, payouts: recent,
    missing: miss.slice(0, 50).map((r) => ({ payment: r.external_id, day: r.day, amount: r.net_cents, client: who(r) })),
    all_clear: !issues.some((i) => i.severity >= 2) && totals.counts.card > 0 };
}

export async function reconcile(c, tenant, { days = 90, now = Date.now() } = {}) {
  if (!(await tables())) return { ok: false, error: 'tables_missing' };
  const from = new Date(now - (days + 10) * DAY).toISOString().slice(0, 10);
  const pageAll = async (make) => { const out = [], seen = new Set(); for (let i = 0; i < 80; i++) { const { data, error } = await make().range(i * 1000, i * 1000 + 999); if (error) throw new Error(error.message); const f = (data || []).filter((r) => !seen.has(r.id) && seen.add(r.id)); out.push(...f); if (!data || data.length < 1000 || !f.length) break; } return out; };
  try {
    const [sales, payouts, entries] = await Promise.all([
      pageAll(() => c.from('salon_sales').select('id,external_id,occurred_at,day,net_cents,tip_cents,fee_cents,refunded_cents,source,customer_ref').eq('tenant_id', tenant.id).eq('provider', 'square').gte('day', from)),
      pageAll(() => c.from('salon_payouts').select('*').eq('tenant_id', tenant.id).eq('provider', 'square').gte('created_ext', new Date(now - (days + 40) * DAY).toISOString())),
      pageAll(() => c.from('salon_payout_entries').select('id,external_id,payout_ref,entry_type,effective_at,gross_cents,fee_cents,net_cents,payment_ref').eq('tenant_id', tenant.id).eq('provider', 'square').gte('effective_at', new Date(now - (days + 40) * DAY).toISOString())),
    ]);
    const { data: cl } = await c.from('clients').select('name,first_name,last_name,preferences').eq('tenant_id', tenant.id).limit(10000).then((x) => x, () => ({ data: [] }));
    const names = new Map((cl || []).filter((x) => x.preferences?.square_id).map((x) => [x.preferences.square_id, x.name || [x.first_name, x.last_name].filter(Boolean).join(' ')]));
    const meta = await getMeta(c, tenant.id);
    return { ...reconcileRows({ sales, payouts, entries, now, days, names }), synced_at: meta.updated_at || null, backfilled: !!meta.backfilled };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
}

export function sayDeposits(r) {
  if (!r?.ok) return r?.error === 'tables_missing' ? "I can't check deposits until the deposit tables exist — run sql/square-sales.sql in Supabase once." : "I can't check your deposits right now.";
  const T = r.totals;
  if (!T.counts.card) return `No card sales in the last ${r.days} days to check${T.cash_count ? ` — ${T.cash_count} cash sales (${money2(T.cash_sales)}) to count in the drawer` : ''}.`;
  const head = r.all_clear
    ? `Last ${r.days} days: every card sale is accounted for. ${money2(T.deposited)} reached your bank, ${money2(T.on_its_way + T.waiting)} is on its way.`
    : `Last ${r.days} days: ${money2(T.deposited)} reached your bank and ${money2(T.on_its_way + T.waiting)} is on its way — but ${r.issues.filter((i) => i.severity >= 2).length} thing${r.issues.filter((i) => i.severity >= 2).length === 1 ? '' : 's'} need you: ${r.issues.slice(0, 2).map((i) => i.title).join('; ')}.`;
  return `${head} Square fees: ${money2(T.square_fees)}${T.fee_rate != null ? ` (${T.fee_rate}% of card sales)` : ''}.${T.refunds ? ` Refunds: ${money2(T.refunds)}.` : ''}${T.cash_count ? ` Cash: ${money2(T.cash_sales)} across ${T.cash_count} sale${T.cash_count === 1 ? '' : 's'} — that's in your drawer, not a deposit.` : ''}`;
}

export function depositBriefLine(r) {
  if (!r?.ok || !r.issues?.length) return null;
  const big = r.issues.filter((i) => i.severity >= 2);
  return big.length ? `Deposits: ${big[0].title}${big.length > 1 ? ` (+${big.length - 1} more)` : ''}.` : null;
}

/** Text the owner once per new deposit problem (failed deposit, money missing, a deposit that doesn't add up). */
export async function depositAlerts(c, tenant, r) {
  if (!r?.ok) return { sent: 0 };
  const key = 'deposit_alerts:' + tenant.id;
  let seen = {};
  try { const { data } = await c.from('platform_settings').select('value').eq('key', key).maybeSingle(); seen = data?.value || {}; } catch (_) {}
  const fresh = r.issues.filter((i) => i.severity >= 2 && !seen[i.key]);
  if (!fresh.length) return { sent: 0 };
  const app = process.env.APP_URL || 'https://www.loladesk.com';
  try {
    const { notifyOwner } = await import('./billing-enforce.js');
    await notifyOwner(tenant, `Lola: ${fresh[0].title}. ${fresh[0].detail}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''} Details: ${app}/deposits`, { subject: 'LolaDesk · check your Square deposits' });
  } catch (_) {}
  for (const i of fresh) seen[i.key] = new Date().toISOString();
  try { await c.from('platform_settings').upsert({ key, value: seen, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch (_) {}
  return { sent: 1, issues: fresh.length };
}
