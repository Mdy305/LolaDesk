/**
 * api/lib/appointment-confirm.js — Lola confirms appointments.
 * ════════════════════════════════════════════════════════════════════
 *   ask     Lola texts each client booked on a day: "confirming your Balayage
 *           Fri 3:00 PM — reply YES to confirm or R to reschedule" (also folded
 *           into the 24h reminder). Logged in booking_reminders (band 'confirm').
 *   reply   A client answers YES within 3 days of being asked → that booking is
 *           marked confirmed-by-client and Lola thanks them. "R / reschedule"
 *           goes to Lola's normal texting brain, which can move it.
 *   status  "Who confirmed tomorrow?" → confirmed vs still waiting, by name.
 * No new columns: a confirmation is a booking_reminders row with status 'confirmed'.
 */
import { sendSms } from './sms.js';
import { e164 } from './db.js';
import { dayBoundsUtc } from './timezone.js';
import { fmtSalon } from './salon-time.js';

const YES = /^\s*(yes|y|yep|yeah|yup|confirm(ed)?|c|ok(ay)?|sure|i'?ll be there|see you( then)?|👍|✅)[\s.!]*$/i;
const ASK_WINDOW_MS = 72 * 3600e3;
const first = (cl) => String(cl?.first_name || cl?.name || '').trim().split(/\s+/)[0] || 'there';
const fullName = (cl) => [cl?.first_name, cl?.last_name].filter(Boolean).join(' ') || cl?.name || 'A client';

export function confirmText({ firstName, salon, what, when }) {
  return `Hi ${firstName}! It's Lola from ${salon}. Confirming your ${what} on ${when}. Reply YES to confirm or R to reschedule.`;
}

async function dayBookings(c, tenant, dayKey, tz) {
  const b = dayBoundsUtc(dayKey, tz);
  const { data: rows } = await c.from('bookings').select('id,client_id,service_id,start_time,status').eq('tenant_id', tenant.id)
    .gte('start_time', b.start).lt('start_time', b.end).order('start_time', { ascending: true });
  const live = (rows || []).filter(x => !/^(cancel|no[-_ ]?show|declined|void)/i.test(x.status || ''));
  const cIds = [...new Set(live.map(x => x.client_id).filter(Boolean))], sIds = [...new Set(live.map(x => x.service_id).filter(Boolean))];
  const [{ data: cls }, { data: svs }, { data: rem }] = await Promise.all([
    cIds.length ? c.from('clients').select('id,name,first_name,last_name,phone').in('id', cIds) : { data: [] },
    sIds.length ? c.from('services').select('id,name').in('id', sIds) : { data: [] },
    live.length ? c.from('booking_reminders').select('booking_id,status,band,sent_at,created_at').in('booking_id', live.map(x => x.id)) : { data: [] },
  ]);
  const cl = Object.fromEntries((cls || []).map(x => [x.id, x])), sv = Object.fromEntries((svs || []).map(x => [x.id, x]));
  return live.map(x => {
    const r = (rem || []).filter(y => y.booking_id === x.id);
    return { ...x, client: cl[x.client_id] || null, service: sv[x.service_id]?.name || 'appointment',
      confirmed: r.some(y => y.status === 'confirmed'), asked: r.some(y => ['sent', 'confirmed'].includes(y.status)) };
  });
}

/** Text everyone booked that day who hasn't confirmed yet. */
export async function askToConfirm(c, tenant, { dayKey, tz, preview = false } = {}) {
  const list = (await dayBookings(c, tenant, dayKey, tz)).filter(x => !x.confirmed && x.client?.phone);
  if (preview) return { count: list.length, names: list.map(x => first(x.client)) };
  let sent = 0, failed = 0;
  for (const x of list) {
    const text = confirmText({ firstName: first(x.client), salon: tenant.name || 'the salon', what: x.service, when: fmtSalon(x.start_time, tz) });
    try {
      const r = await sendSms({ tenantId: tenant.id, to: x.client.phone, text });
      const ok = r && !r.skipped && !(r.errors && r.errors.length);
      await c.from('booking_reminders').insert({ tenant_id: tenant.id, booking_id: x.id, client_id: x.client_id, reminder_for: x.start_time, band: 'confirm', channel: 'sms', status: ok ? 'sent' : 'failed', sent_at: ok ? new Date().toISOString() : null });
      ok ? sent++ : failed++;
    } catch (_) { failed++; }
  }
  return { sent, failed, count: list.length };
}

/** Who confirmed, who hasn't. */
export async function confirmationStatus(c, tenant, { dayKey, tz }) {
  const list = await dayBookings(c, tenant, dayKey, tz);
  const yes = list.filter(x => x.confirmed), waiting = list.filter(x => !x.confirmed);
  return { total: list.length, confirmed: yes.map(x => fullName(x.client)), waiting: waiting.map(x => ({ name: fullName(x.client), asked: x.asked, phone: x.client?.phone || null })) };
}

/** A client texted the salon line. If it's a YES to a confirmation we asked for, record it and answer. */
export async function handleConfirmReply(c, tenant, fromPhone, text, { tz = 'America/New_York' } = {}) {
  if (!c || !YES.test(String(text || ''))) return null;
  const phone = e164(fromPhone); if (!phone) return null;
  const { data: cl } = await c.from('clients').select('id,first_name,last_name,name').eq('tenant_id', tenant.id).eq('phone', phone).maybeSingle();
  if (!cl) return null;
  const now = Date.now();
  const { data: bks } = await c.from('bookings').select('id,service_id,start_time,status').eq('tenant_id', tenant.id).eq('client_id', cl.id)
    .gte('start_time', new Date(now).toISOString()).lte('start_time', new Date(now + 4 * 86400e3).toISOString()).order('start_time', { ascending: true });
  const upcoming = (bks || []).filter(x => !/^(cancel|no[-_ ]?show|declined|void)/i.test(x.status || ''));
  if (!upcoming.length) return null;
  const { data: rem } = await c.from('booking_reminders').select('id,booking_id,status,sent_at,created_at').in('booking_id', upcoming.map(x => x.id));
  const askedRecently = (rem || []).filter(r => ['sent', 'confirmed'].includes(r.status) && now - Date.parse(r.sent_at || r.created_at || 0) < ASK_WINDOW_MS);
  if (!askedRecently.length) return null;                     // we didn't ask — "yes" belongs to the conversation
  const b = upcoming.find(x => askedRecently.some(r => r.booking_id === x.id)) || upcoming[0];
  const row = askedRecently.filter(r => r.booking_id === b.id).sort((a, z) => Date.parse(z.sent_at || z.created_at || 0) - Date.parse(a.sent_at || a.created_at || 0))[0];
  if (row) await c.from('booking_reminders').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', row.id);
  let what = 'appointment';
  if (b.service_id) { const { data: s } = await c.from('services').select('name').eq('id', b.service_id).maybeSingle(); if (s?.name) what = s.name; }
  return { booking_id: b.id, reply: `You're confirmed for your ${what} on ${fmtSalon(b.start_time, tz)}, ${first(cl)}. See you then! ✨` };
}
