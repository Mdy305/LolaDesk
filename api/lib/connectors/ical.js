/**
 * api/lib/connectors/ical.js — any booking system, by its calendar link.
 * ════════════════════════════════════════════════════════════════════
 * Boulevard, Vagaro, Fresha, Mindbody, Square, GlossGenius, Google and Apple
 * all publish a private "subscribe to calendar" (.ics) link for a salon or a
 * stylist. Paste it once and LolaDesk keeps that schedule's busy time in its
 * local cache (synced with the rest), so Lola never double-books — no API
 * partnership, no migration. Read-only by nature: bookings Lola takes still
 * live in LolaDesk; the salon's own system shows them once it's connected by
 * API, or the owner adds them (the owner is told).
 *
 * The secret URL is stored encrypted (integrations.access_token).
 * RFC 5545: line unfolding, DTSTART/DTEND/DURATION, TZID, all-day dates,
 * STATUS:CANCELLED, TRANSP:TRANSPARENT, and RRULE (DAILY/WEEKLY/MONTHLY with
 * INTERVAL, COUNT, UNTIL, BYDAY) with EXDATE.
 */
import { zonedLocalToUtc } from '../timezone.js';
import { safeFetch } from '../safe-fetch.js';

export const META = { name: 'Calendar link (iCal)', description: 'Any booking system that offers a calendar subscription link (Boulevard, Vagaro, Fresha, Mindbody, GlossGenius, Google, Apple).', status: 'available', docs: 'https://datatracker.ietf.org/doc/html/rfc5545' };

const MAX_BYTES = 6 * 1024 * 1024;
const FETCH_MS = 8000;
const cache = new Map();   // url → { at, events } — one fetch per ~4 minutes per warm instance
const TTL_MS = 4 * 60e3;

export function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  try { const x = new URL(s); if (!/^https?:$/.test(x.protocol)) return null; if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(x.hostname)) return null; return x.toString(); } catch (_) { return null; }
}

function unfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function parseLine(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...ps] = head.split(';');
  const params = {}; for (const p of ps) { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value };
}

/** An ICS date/time value → { iso, allDay } */
export function icsTime(value, params = {}, defaultTz = 'UTC') {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, Y, M, D, h, mi, se, z] = m;
  const key = `${Y}-${M}-${D}`;
  if (!h || params.VALUE === 'DATE') return { iso: zonedLocalToUtc(key, '00:00:00', params.TZID || defaultTz), allDay: true, key };
  if (z) return { iso: new Date(`${key}T${h}:${mi}:${se || '00'}Z`).toISOString(), allDay: false, key };
  const tz = params.TZID && /\//.test(params.TZID) ? params.TZID : defaultTz;
  try { return { iso: zonedLocalToUtc(key, `${h}:${mi}:${se || '00'}`, tz), allDay: false, key, tz, local: `${h}:${mi}:${se || '00'}` }; }
  catch (_) { return { iso: new Date(`${key}T${h}:${mi}:${se || '00'}Z`).toISOString(), allDay: false, key }; }
}

function durationMs(d) {
  const m = String(d || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w, dd, hh, mm, ss] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+dd || 0) * 86400 + (+hh || 0) * 3600 + (+mm || 0) * 60 + (+ss || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function addDaysKey(key, n) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dowOfKey(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

/** Expand one event's RRULE into start instants inside [from, to]. */
function expand(ev, from, to, defaultTz) {
  const len = ev.end - ev.start;
  const out = [];
  const push = (startMs) => { if (startMs + len > from && startMs < to && !ev.exdates.has(startMs)) out.push({ start: startMs, end: startMs + len }); };
  if (!ev.rrule) { push(ev.start); return out; }
  const r = Object.fromEntries(ev.rrule.split(';').map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL || 1));
  const until = r.UNTIL ? (icsTime(r.UNTIL, {}, defaultTz)?.iso ? Date.parse(icsTime(r.UNTIL, {}, defaultTz).iso) : Infinity) : Infinity;
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => DOW[x.slice(-2)]).filter((x) => x != null) : null;
  const tz = ev.tz || defaultTz;
  const at = (key) => ev.allDay ? Date.parse(zonedLocalToUtc(key, '00:00:00', tz)) : (ev.local ? Date.parse(zonedLocalToUtc(key, ev.local, tz)) : Date.parse(`${key}T${new Date(ev.start).toISOString().slice(11)}`));
  let n = 0; const startKey = ev.key;
  for (let i = 0; i < 800 && n < count; i++) {
    let keys = [];
    if (freq === 'DAILY') keys = [addDaysKey(startKey, i * interval)];
    else if (freq === 'WEEKLY') {
      const weekStart = addDaysKey(startKey, i * 7 * interval - dowOfKey(startKey));
      keys = (byday || [dowOfKey(startKey)]).map((d) => addDaysKey(weekStart, d)).filter((k) => k >= startKey).sort();
    } else if (freq === 'MONTHLY') {
      const [y, m, d] = startKey.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + i * interval, d));
      if (dt.getUTCDate() === d) keys = [dt.toISOString().slice(0, 10)];
    } else { push(ev.start); break; }
    let past = false;
    for (const k of keys) {
      const s = at(k); if (s > until || n >= count) { past = true; break; }
      n++; if (s > to) { past = true; break; } push(s);
    }
    if (past) break;
  }
  return out;
}

/** Parse an ICS feed into busy blocks within [from, to]. */
export function parseIcs(text, { from, to, defaultTz = 'America/New_York' } = {}) {
  const lines = unfold(text).split('\n');
  const f = Date.parse(from || new Date().toISOString()), t = Date.parse(to || new Date(Date.now() + 45 * 864e5).toISOString());
  let calTz = defaultTz; const events = []; let ev = null;
  const overrides = new Map();
  for (const raw of lines) {
    const l = parseLine(raw.trim()); if (!l) { if (raw.trim() === 'BEGIN:VEVENT') ev = { exdates: new Set() }; continue; }
    if (l.name === 'X-WR-TIMEZONE' && /\//.test(l.value)) calTz = l.value.trim();
    if (l.name === 'BEGIN' && l.value === 'VEVENT') { ev = { exdates: new Set() }; continue; }
    if (l.name === 'END' && l.value === 'VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    if (l.name === 'DTSTART') { const x = icsTime(l.value, l.params, calTz); if (x) { ev.start = Date.parse(x.iso); ev.allDay = x.allDay; ev.key = x.key; ev.tz = x.tz; ev.local = x.local; } }
    else if (l.name === 'DTEND') { const x = icsTime(l.value, l.params, calTz); if (x) ev.end = Date.parse(x.iso); }
    else if (l.name === 'DURATION') ev.duration = durationMs(l.value);
    else if (l.name === 'RRULE') ev.rrule = l.value;
    else if (l.name === 'EXDATE') for (const v of l.value.split(',')) { const x = icsTime(v, l.params, calTz); if (x) ev.exdates.add(Date.parse(x.iso)); }
    else if (l.name === 'RECURRENCE-ID') { const x = icsTime(l.value, l.params, calTz); if (x) ev.recurrenceId = Date.parse(x.iso); }
    else if (l.name === 'STATUS') ev.status = l.value.trim().toUpperCase();
    else if (l.name === 'TRANSP') ev.transp = l.value.trim().toUpperCase();
    else if (l.name === 'UID') ev.uid = l.value.trim();
    else if (l.name === 'SUMMARY') ev.summary = l.value.replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
  }
  for (const e of events) if (e.uid && e.recurrenceId != null) overrides.set(e.uid + '@' + e.recurrenceId, e);
  const out = [];
  for (const e of events) {
    if (e.start == null) continue;
    if (e.end == null) e.end = e.start + (e.duration != null ? e.duration : (e.allDay ? 864e5 : 60 * 60e3));
    if (e.end <= e.start) continue;
    if (e.recurrenceId != null) {   // a moved/cancelled single occurrence
      if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT') continue;
      if (e.end > f && e.start < t) out.push({ uid: e.uid, start: e.start, end: e.end, summary: e.summary });
      continue;
    }
    if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT') continue;
    for (const occ of expand(e, f, t, calTz)) {
      if (e.uid && overrides.has(e.uid + '@' + occ.start)) continue;
      out.push({ uid: e.uid, start: occ.start, end: occ.end, summary: e.summary });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Default fetch is SSRF-safe (public addresses only, redirects re-checked, size capped).
const icsFetch = (u, init) => safeFetch(u, { ...init, timeoutMs: FETCH_MS, maxBytes: MAX_BYTES * 2 });
export async function fetchIcs(url, { fetchImpl = icsFetch } = {}) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetchImpl(url, { headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'LolaDesk-Calendar/1.0' }, signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`calendar link answered ${r.status}`);
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('calendar is too large');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('that link isn’t a calendar (.ics) feed');
    return text;
  } finally { clearTimeout(tm); }
}

/** The salon's linked calendars: access_token holds an (encrypted) JSON list of { url, label, staff_id }. */
export function feedsOf(integration) {
  const raw = integration?.access_token;
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.filter((x) => x && normalizeUrl(x.url)); } catch (_) {}
  const one = normalizeUrl(raw || integration?.metadata?.url);
  return one ? [{ url: one, label: integration?.metadata?.label || 'Calendar', staff_id: integration?.metadata?.staff_id || null }] : [];
}

/** Connector contract used by booking-sync (read-only). */
export async function listAppointments(integration, { from, to, fetchImpl } = {}) {
  const tz = integration.metadata?.timezone || 'America/New_York';
  const out = [];
  for (const feed of feedsOf(integration)) {
    const url = normalizeUrl(feed.url);
    const hit = cache.get(url);
    let text;
    if (hit && Date.now() - hit.at < TTL_MS) text = hit.text;
    else { text = await fetchIcs(url, fetchImpl ? { fetchImpl } : {}); cache.set(url, { at: Date.now(), text }); }
    for (const e of parseIcs(text, { from, to, defaultTz: tz })) out.push({
      id: `${(e.uid || 'ev').slice(0, 120)}@${e.start}`, starts_at: new Date(e.start).toISOString(), ends_at: new Date(e.end).toISOString(),
      duration_min: Math.round((e.end - e.start) / 60e3), client: { name: null }, service: e.summary ? e.summary.slice(0, 80) : null,
      // A stylist's own link blocks that stylist (local id); a salon-wide link takes one chair per appointment.
      stylist: feed.staff_id ? 'local:' + feed.staff_id : null, status: 'booked',
    });
  }
  return out;
}
export function clearIcsCache() { cache.clear(); }
export async function createAppointment() { throw new Error('A calendar link is read-only — connect the booking system itself to write bookings there.'); }
