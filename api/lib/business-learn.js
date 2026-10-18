/**
 * api/lib/business-learn.js — Lola learns a salon in one pass.
 * ════════════════════════════════════════════════════════════════
 * Reads the owner's website (several pages), their Google Maps listing (hours,
 * phone, rating, what reviewers say, the salons around them), their Instagram
 * and/or a pasted menu, asks the
 * Telnyx brain for one structured profile — services & prices, team, hours,
 * policies, FAQ, brand voice, ideal client, growth ideas and a first campaign —
 * then writes it where the app actually reads it:
 *   · services table      (only when the salon has no real menu yet)
 *   · staff table         (only when the salon has no real team yet; schedules
 *                          come from ensureBookingBaseline)
 *   · tenants.services / hours / location / team / website_url (only if empty)
 *   · tenants.knowledge   (JSON text, merged — feeds tenantKnowledgePrompt and
 *                          Lola's owner/marketing brain)
 *   · booking_settings    (timezone + cancellation window, only when safe)
 * Never overwrites what the owner set by hand. Real columns only.
 */
import { chat } from './llm.js';
import { safeFetch } from './safe-fetch.js';
import { safePublicUrl } from './onboarding-engine.js';
import { ensureBookingBaseline } from './booking-seed.js';
import { readMaps } from './google-places.js';
import { readInstagram, igHandle } from './instagram-read.js';
import { tolerantWrite, clockToMinutes, minutesToClock } from './setup-store.js';

const PAGES = ['/', '/services', '/menu', '/pricing', '/prices', '/service-menu', '/team', '/stylists', '/staff', '/about', '/faq', '/policies'];
const DEFAULT_STAFF = 'Any available team member';
const LLM_DEADLINE_MS = 38000;

// ── reading ──────────────────────────────────────────────────
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;|&mdash;/g, '-')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function fetchText(url, ms = 7000) {
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LolaDesk/1.0; +https://loladesk.com)' }, timeoutMs: ms, maxBytes: 3 * 1024 * 1024 });
    if (!r.ok || !/html|text/i.test(r.headers.get('content-type') || 'text/html')) return null;
    const html = (await r.text()).slice(0, 400000);
    return { html, url: r.url || url };
  } catch { return null; }
}

/** Home page + the likely menu/team/about pages, in parallel. Same host only. */
export async function readWebsite(websiteUrl) {
  const base = safePublicUrl(websiteUrl);
  if (!base) throw new Error('That website address looks wrong.');
  const home = await fetchText(base, 9000);
  if (!home) throw new Error("I couldn't open that website.");
  const origin = new URL(home.url).origin;
  // Links on the home page that look like menu / team / about pages.
  const linked = [...home.html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1])
    .filter(h => /servic|menu|pric|team|stylist|staff|artist|about|faq|polic/i.test(h))
    .map(h => { try { return new URL(h, origin); } catch { return null; } })
    .filter(u => u && u.origin === origin).map(u => u.toString());
  const candidates = [...new Set([...linked, ...PAGES.slice(1).map(p => origin + p)])].filter(u => u !== home.url).slice(0, 8);
  const pages = await Promise.all(candidates.map(u => fetchText(u, 6000)));
  const parts = [`=== ${home.url} ===\n${htmlToText(home.html).slice(0, 14000)}`];
  const seen = new Set([htmlToText(home.html).slice(0, 400)]);
  for (const p of pages) {
    if (!p) continue;
    const t = htmlToText(p.html);
    const sig = t.slice(0, 400);
    if (t.length < 200 || seen.has(sig)) continue; // skip 404 look-alikes that echo the home page
    seen.add(sig);
    parts.push(`=== ${p.url} ===\n${t.slice(0, 9000)}`);
  }
  const title = (home.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const instagram = (home.html.match(/instagram\.com\/([A-Za-z0-9_.]{2,30})/i) || [])[1] || null;
  const allHtml = [home.html, ...pages.filter(Boolean).map(p => p.html)].join(' ');
  return { url: home.url, title, instagram, links: siteLinks(allHtml), text: parts.join('\n\n').slice(0, 42000), pages: parts.length };
}

// Where the salon books today, and its socials — read from the links on its own pages.
const BOOKING_HOSTS = /(vagaro\.com|booksy\.com|square\.site|squareup\.com\/appointments|book\.squareup\.com|glossgenius\.com|fresha\.com|joinblvd\.com|blvd\.app|mindbodyonline\.com|clients\.mindbodyonline|schedulicity\.com|styleseat\.com|acuityscheduling\.com|calendly\.com|setmore\.com|zenoti\.com|phorest\.com|timely\.com|gettimely\.com|salonbiz|meevo|rosysalonsoftware|saloniq|shedul)/i;
const SYSTEM_NAMES = [[/vagaro/i, 'Vagaro'], [/booksy/i, 'Booksy'], [/square/i, 'Square'], [/glossgenius/i, 'GlossGenius'], [/fresha|shedul/i, 'Fresha'], [/joinblvd|blvd\.app/i, 'Boulevard'], [/mindbody/i, 'Mindbody'], [/schedulicity/i, 'Schedulicity'], [/styleseat/i, 'StyleSeat'], [/acuity/i, 'Acuity'], [/calendly/i, 'Calendly'], [/setmore/i, 'Setmore'], [/zenoti/i, 'Zenoti'], [/phorest/i, 'Phorest'], [/timely/i, 'Timely'], [/salonbiz/i, 'SalonBiz'], [/meevo/i, 'Meevo'], [/rosy/i, 'Rosy'], [/saloniq/i, 'SalonIQ']];
const systemName = (url) => (url ? (SYSTEM_NAMES.find(([re]) => re.test(url)) || [null, null])[1] : null);
export function siteLinks(html) {
  const hrefs = [...String(html || '').matchAll(/href=["']([^"'#\s]+)["']/gi)].map(m => m[1]).filter(h => /^https?:\/\//i.test(h));
  const first = (re) => hrefs.find(h => re.test(h)) || null;
  const tel = (String(html || '').match(/href=["']tel:([+\d\-().\s]{7,20})["']/i) || [])[1] || null;
  return {
    booking: first(BOOKING_HOSTS),
    booking_system: systemName(first(BOOKING_HOSTS)),
    facebook: first(/facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^/?]+/i),
    tiktok: first(/tiktok\.com\/@[^/?]+/i),
    youtube: first(/youtube\.com\/(@|c\/|channel\/|user\/)[^/?]+/i),
    phone: tel ? tel.trim() : null,
  };
}

// ── opening hours → the salon's real week (booking_settings.business_hours) ──
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_FROM = (w) => { const k = String(w || '').toLowerCase().slice(0, 3); return DAY_KEYS.includes(k) ? k : ({ tues: 'tue', thur: 'thu', thurs: 'thu' })[String(w).toLowerCase()] || null; };
const clean = (t) => String(t || '').replace(/[\u202f\u2009\u00a0]/g, ' ').replace(/[–—−]/g, '-').trim();
/** "10:00 AM - 7:00 PM" / "9 - 6pm" / "10am-7pm" → { open:'10:00', close:'19:00' } (null if unreadable). */
export function parseRange(text) {
  const t = clean(text).toLowerCase().replace(/\s+/g, ' ');
  if (/24 hours/.test(t)) return { open: '00:00', close: '23:59' };
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  const spans = [];
  for (const part of parts) {
    const m = part.match(/^(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)?$/);
    if (!m) continue;
    const ap = (x) => (x ? x.replace(/\./g, '') : '');
    const endAp = ap(m[4]) || 'pm';
    let endMin = clockToMinutes(m[3] + ' ' + endAp);
    let startMin = clockToMinutes(m[1] + (ap(m[2]) ? ' ' + ap(m[2]) : ' ' + endAp));
    if (startMin != null && endMin != null && startMin >= endMin && !m[2]) startMin = clockToMinutes(m[1] + ' am');
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    spans.push([startMin, endMin]);
  }
  if (!spans.length) return null;
  return { open: minutesToClock(Math.min(...spans.map(s => s[0]))), close: minutesToClock(Math.max(...spans.map(s => s[1]))) };
}
/** Google's weekdayDescriptions ["Monday: 10:00 AM – 7:00 PM", "Sunday: Closed"] → a full week. */
export function parsePlacesHours(lines) {
  const week = {};
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const m = clean(line).match(/^([A-Za-z]+)\s*:\s*(.+)$/);
    const day = m && DAY_FROM(m[1]);
    if (!day) continue;
    if (/closed/i.test(m[2])) { week[day] = { open: '10:00', close: '19:00', closed: true }; continue; }
    const r = parseRange(m[2]);
    if (r) week[day] = { ...r, closed: false };
  }
  return Object.keys(week).length >= 5 ? fillWeek(week) : null;
}
/** "Tue-Fri 10am-7pm, Sat 9am-5pm, Sun-Mon closed" → a full week (days not named are closed). */
export function parseHoursText(text) {
  const t = clean(text);
  if (!t) return null;
  const week = {};
  for (const seg of t.split(/[;\n]|,(?=\s*[A-Za-z]{3})/)) {
    const m = seg.trim().match(/^([A-Za-z]{3,9})(?:\s*(?:-|to|through|&|and)\s*([A-Za-z]{3,9}))?\.?\s*:?\s*(.+)$/i);
    if (!m) continue;
    const a = DAY_FROM(m[1]), b = m[2] ? DAY_FROM(m[2]) : a;
    if (!a || !b) continue;
    const ia = DAY_KEYS.indexOf(a), ib = DAY_KEYS.indexOf(b);
    const days = []; for (let i = ia; ; i = (i + 1) % 7) { days.push(DAY_KEYS[i]); if (i === ib || days.length > 7) break; }
    if (/closed|off/i.test(m[3])) { days.forEach(d => { week[d] = { open: '10:00', close: '19:00', closed: true }; }); continue; }
    const r = parseRange(m[3]);
    if (r) days.forEach(d => { week[d] = { ...r, closed: false }; });
  }
  const open = Object.values(week).filter(d => !d.closed).length;
  return open ? fillWeek(week, true) : null;
}
function fillWeek(week, unnamedClosed = true) {
  const out = {};
  for (const d of DAY_KEYS) out[d] = week[d] || { open: '10:00', close: '19:00', closed: unnamedClosed };
  return out;
}
/** The AI's structured week, checked like any other source. */
export function cleanAiHours(bh) {
  if (!bh || typeof bh !== 'object') return null;
  const week = {};
  for (const d of DAY_KEYS) {
    const x = bh[d] || bh[d[0].toUpperCase() + d.slice(1)];
    if (!x) continue;
    if (x.closed === true || /closed/i.test(String(x.open || ''))) { week[d] = { open: '10:00', close: '19:00', closed: true }; continue; }
    const r = parseRange(`${x.open || ''} - ${x.close || ''}`) || (() => { const o = clockToMinutes(x.open), c = clockToMinutes(x.close); return o != null && c != null && c > o ? { open: minutesToClock(o), close: minutesToClock(c) } : null; })();
    if (r) week[d] = { ...r, closed: false };
  }
  return Object.values(week).filter(d => !d.closed).length && Object.keys(week).length >= 5 ? fillWeek(week) : null;
}

// ── understanding ────────────────────────────────────────────
const SHAPE = `{
 "summary": "2 sentences: what this business is and why clients choose it",
 "positioning": "luxury | boutique | value | clinical | family | trendy",
 "audience": "who the clients are",
 "tone": "brand voice in a few words",
 "usp": "what makes them special",
 "address": "street address or null",
 "city": "city, state or null",
 "timezone": "IANA timezone for that city, e.g. America/New_York, or null",
 "phone": null,
 "hours_text": "e.g. Tue-Fri 10am-7pm, Sat 9am-5pm, Sun-Mon closed, or null",
 "business_hours": {"mon": {"open": "10:00", "close": "19:00", "closed": false}, "tue": null, "wed": null, "thu": null, "fri": null, "sat": null, "sun": null},
 "services": [{"name":"", "price": null, "duration_min": null, "category": null, "description": null}],
 "team": [{"name":"", "role": null}],
 "policies": {"cancellation_window_hours": null, "deposit": null, "notes": null},
 "faq": [{"q":"", "a":""}],
 "marketing": {
   "ideal_client": "",
   "opportunities": ["3 concrete ways to grow this business"],
   "first_campaign": {"name": "", "segment": "lapsed | vip | all", "message": "SMS under 160 chars, warm, uses {first_name}, no links"}
 }
}`;

function parseJson(text) {
  const s = String(text || '').replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

export async function understand({ name, businessMode = 'salon', corpus, llm = chat }) {
  const system = [
    `You are Lola, the new AI front desk and marketing manager for ${name ? `"${name}", ` : ''}a ${businessMode}.`,
    'You just read their website and/or the menu the owner pasted. Learn everything you need to answer their phones, book clients and grow the business.',
    'Rules: only use facts that are in the text. Never invent services, prices, people or hours; use null when unknown. Prices are numbers in dollars (use the starting price for ranges). Durations in minutes.',
    'Keep services to the 30 most important, team to 12, faq to 8.',
    `Return STRICT JSON only, exactly this shape:\n${SHAPE}`,
  ].join('\n');
  const call = llm({ system, messages: [{ role: 'user', content: corpus.slice(0, 42000) }], maxTokens: 3500, temperature: 0.2 });
  const timeout = new Promise(r => setTimeout(() => r({ ok: false, error: 'timeout' }), LLM_DEADLINE_MS));
  const res = await Promise.race([call, timeout]).catch(e => ({ ok: false, error: String(e?.message || e) }));
  return res?.ok ? parseJson(res.text) : null;
}

/** When the brain is unreachable: pull "Service ... $85" lines straight from the text. */
export function heuristicServices(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 &'\/+,.()-]{2,60}?)\s*(?:[-–—:.…]+\s*|\s{2,}|\s)(?:from\s*)?\$\s?(\d{1,4}(?:\.\d{2})?)\+?\s*$/i);
    if (m) out.push({ name: m[1].trim().replace(/[\s.,:-]+$/, ''), price: Number(m[2]) });
    if (out.length >= 30) break;
  }
  return out;
}

// ── cleaning ─────────────────────────────────────────────────
const TEAM_ROLE = /stylist|colou?r|barber|artist|esthetic|aesthetic|nail|lash|brow|massage|therap|injector|nurse|educator|owner|founder|master|director|specialist|hair|makeup|technician|blowout|extension|provider|practitioner/i;
export function cleanProfile(p) {
  const x = p && typeof p === 'object' ? p : {};
  const str = (v, n = 300) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null') ? v.trim().slice(0, n) : null;
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
  const seen = new Set();
  const services = (Array.isArray(x.services) ? x.services : []).map(s => ({
    name: str(s?.name, 80), price: num(s?.price), duration_min: num(s?.duration_min),
    category: str(s?.category, 60), description: str(s?.description, 240),
  })).filter(s => s.name && !seen.has(s.name.toLowerCase()) && seen.add(s.name.toLowerCase())).slice(0, 30)
    .map(s => ({ ...s, duration_min: s.duration_min ? Math.min(600, Math.max(5, Math.round(s.duration_min))) : null, price: s.price ? Math.min(20000, s.price) : null }));
  const tseen = new Set();
  const team = (Array.isArray(x.team) ? x.team : []).map(t => ({ name: str(t?.name, 60), role: str(t?.role, 60) }))
    .filter(t => t.name && t.name.split(' ').length <= 4 && !/salon|spa|studio|team|staff/i.test(t.name) && (!t.role || TEAM_ROLE.test(t.role)))
    .filter(t => !tseen.has(t.name.toLowerCase()) && tseen.add(t.name.toLowerCase())).slice(0, 12);
  let tz = str(x.timezone, 60);
  try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = null; }
  const cw = num(x.policies?.cancellation_window_hours);
  const fc = x.marketing?.first_campaign || {};
  return {
    summary: str(x.summary, 500), positioning: str(x.positioning, 60), audience: str(x.audience, 200), tone: str(x.tone, 120), usp: str(x.usp, 240),
    address: str(x.address, 200), city: str(x.city, 80), timezone: tz, phone: str(x.phone, 30), hours_text: str(x.hours_text, 200),
    business_hours: cleanAiHours(x.business_hours),
    services, team,
    policies: { cancellation_window_hours: cw && cw <= 168 ? Math.round(cw) : null, deposit: str(x.policies?.deposit, 200), notes: str(x.policies?.notes, 400) },
    faq: (Array.isArray(x.faq) ? x.faq : []).map(f => ({ q: str(f?.q, 200), a: str(f?.a, 400) })).filter(f => f.q && f.a).slice(0, 8),
    marketing: {
      ideal_client: str(x.marketing?.ideal_client, 240),
      opportunities: (Array.isArray(x.marketing?.opportunities) ? x.marketing.opportunities : []).map(o => str(o, 200)).filter(Boolean).slice(0, 4),
      first_campaign: str(fc.message, 320) ? { name: str(fc.name, 80) || 'First campaign', segment: ['lapsed', 'vip', 'all'].includes(fc.segment) ? fc.segment : 'lapsed', message: str(fc.message, 320) } : null,
    },
  };
}

export function parseKnowledge(k) {
  if (!k) return {};
  if (typeof k === 'object' && !Array.isArray(k)) return k;
  try { const v = JSON.parse(k); return v && typeof v === 'object' && !Array.isArray(v) ? v : { notes: String(k) }; } catch { return String(k).trim() ? { notes: String(k) } : {}; }
}

function toneToPersona(tone, positioning) {
  const t = `${tone || ''} ${positioning || ''}`.toLowerCase();
  if (/luxur|premium|high.end|upscale|exclusive|elegant/.test(t)) return 'luxury';
  if (/clinic|medical|med.?spa/.test(t)) return 'clinical';
  if (/fun|playful|bold|edgy|trendy/.test(t)) return 'playful';
  if (/friendly|warm|approachable|cozy|family/.test(t)) return 'warm';
  return null;
}

// ── writing ──────────────────────────────────────────────────
async function q(p) { try { const r = await p; return r || {}; } catch (e) { return { error: e }; } }

// Color work books in phases: application → processing (the stylist is free to take
// someone else) → rinse/gloss/finish. A 2h15 balayage becomes 45 / 45 / 45.
const PHASED = /balayage|highlight|lowlight|foil|ombr|colou?r|tint|root|bleach|lighten|toner|gloss|perm|keratin|relax|straighten|brazilian|smoothing/i;
export function phasesFor(name, minutes) {
  const d = Number(minutes) || 0;
  if (!PHASED.test(String(name || '')) || d < 90) return null;
  const r5 = (x) => Math.max(15, Math.round(x / 5) * 5);
  const a1 = r5(d / 3), p = r5(d / 3), a2 = Math.max(15, d - a1 - p);
  return { active_duration_1_min: a1, processing_duration_min: p, active_duration_2_min: a2 };
}

/** "$50 deposit", "25% deposit required" → a suggested deposit policy (never switched on by itself). */
export function depositFromText(text) {
  const t = String(text || '');
  if (!/deposit/i.test(t)) return null;
  const pct = t.match(/(\d{1,3})\s*%/), usd = t.match(/\$\s*(\d{1,4})/);
  if (pct) return { type: 'percent', percent: Math.min(100, Number(pct[1])), source: t.slice(0, 160) };
  if (usd) return { type: 'fixed', fixed_cents: Number(usd[1]) * 100, source: t.slice(0, 160) };
  return { type: 'unknown', source: t.slice(0, 160) };
}

// ── ONE transaction ─────────────────────────────────────────────────────────────────────────────
// The scan's writes — services, prices, the team, staff hours, opening hours, the Google Places payload
// and the salon record — are PLANNED here from a fresh read, then COMMITTED by the database function
// lola_apply_onboarding (sql/sync-atomic-2026-10.sql) in one transaction: all of it lands or none of it
// does. A database without the function self-applies it once (exec_sql); if it still can't, the older
// step-by-step writer runs and the live check names the SQL file to run.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Only well-formed days reach the database (one bad time would roll the whole ingestion back). */
export function cleanWeek(week) {
  if (!week || typeof week !== 'object') return null;
  const out = {};
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const x = week[d]; if (!x || typeof x !== 'object') continue;
    if (x.closed === true) { out[d] = { open: '10:00', close: '19:00', closed: true }; continue; }
    const o = String(x.open || '').slice(0, 5), cl = String(x.close || '').slice(0, 5);
    if (HHMM.test(o) && HHMM.test(cl) && cl > o) out[d] = { open: o, close: cl, closed: false };
  }
  return Object.keys(out).length >= 5 ? out : null;
}

export async function planProfile(c, tenant, profile, { source = {} } = {}) {
  const [{ data: fresh }, { data: bs0 }, { data: svcRows }, { data: staffRows }] = await Promise.all([
    q(c.from('tenants').select('*').eq('id', tenant.id).maybeSingle()),
    q(c.from('booking_settings').select('*').eq('tenant_id', tenant.id).maybeSingle()),
    q(c.from('services').select('*').eq('tenant_id', tenant.id)),
    q(c.from('staff').select('*').eq('tenant_id', tenant.id)),
  ]);
  const t = fresh || tenant;
  const place = source.google?.place || null;
  const report = { services_added: 0, team_added: 0, timezone: null, hours: false, notes: [] };
  const plan = { hours: null, services_insert: [], services_price: [], staff_insert: [], default_staff: DEFAULT_STAFF, tenant_patch: {}, settings_patch: {} };

  // Opening hours: Google first (exact), then the website.
  const gWeek = place?.hours?.length ? cleanWeek(parsePlacesHours(place.hours)) : null;
  const week = gWeek || cleanWeek(profile.business_hours) || cleanWeek(parseHoursText(profile.hours_text));
  if (week) plan.hours = { week, source: gWeek ? 'google' : 'website' };

  // The menu: the whole menu for a salon without one; prices for services already listed without a price.
  const isPlaceholder = (x) => /^consultation$/i.test(x.name || '') && !Number(x.price);
  const real = (svcRows || []).filter((x) => !isPlaceholder(x) && x.is_active !== false);
  if (!real.length) {
    plan.services_insert = profile.services.map((x) => ({ name: x.name, description: x.description || '', category: x.category || null,
      duration_minutes: x.duration_min || 60, price: x.price || 0, ...(phasesFor(x.name, x.duration_min || 60) || {}) }));
    const unpriced = profile.services.filter((x) => !x.price).map((x) => x.name);
    if (unpriced.length) report.needs_price = unpriced.slice(0, 30);
    report.processing_phased = plan.services_insert.filter((x) => x.processing_duration_min).length || undefined;
  } else {
    const priced = new Map(profile.services.filter((x) => x.price > 0).map((x) => [String(x.name).toLowerCase(), x.price]));
    plan.services_price = real.filter((x) => !Number(x.price) && priced.has(String(x.name).toLowerCase())).map((x) => ({ name: x.name, price: priced.get(String(x.name).toLowerCase()) }));
  }

  // The team.
  const realStaff = (staffRows || []).filter((x) => x.name !== DEFAULT_STAFF);
  if (!realStaff.length && profile.team.length) plan.staff_insert = profile.team.map((m) => ({ name: m.name, role: m.role || 'Stylist' }));

  // The salon record Lola reads on every call — blanks only — and the Google Places payload.
  const patch = plan.tenant_patch;
  const menu = Array.isArray(t.services) ? t.services.filter((x) => x && (x.name || typeof x === 'string')) : [];
  if ((!menu.length || menu.every((x) => /^consultation$/i.test(x.name || x))) && profile.services.length)
    patch.services = profile.services.map((x) => ({ name: x.name, price: x.price, duration: x.duration_min ? `${x.duration_min} min` : null }));
  if (!t.hours && profile.hours_text) patch.hours = profile.hours_text;
  if (!t.location && (profile.address || profile.city)) patch.location = profile.address || profile.city;
  if ((!Array.isArray(t.team) || !t.team.length) && profile.team.length) patch.team = profile.team;
  if (!t.website_url && source.website) patch.website_url = source.website;
  if (place) {
    if (!t.location && place.address) patch.location = place.address;
    if (!t.hours && !patch.hours && place.hours?.length) patch.hours = place.hours.join('; ').slice(0, 400);
    if (!t.google_review_url && place.review_link) { patch.google_review_url = place.review_link; report.reviews_on = true; }
  }
  if (!t.gmb_url && (place?.maps_url || source.maps_url)) patch.gmb_url = place?.maps_url || source.maps_url;
  if (patch.hours) report.hours = true;
  const persona = toneToPersona(profile.tone, profile.positioning);
  if (persona && (!t.persona || t.persona === 'warm')) patch.persona = persona;
  patch.knowledge = knowledgeFor(parseKnowledge(t.knowledge), profile, source, place);

  // Booking settings the scan found.
  const dep = depositFromText(profile.policies?.deposit);
  if (dep) { report.deposit_found = dep; plan.settings_patch.deposits_detected = dep; }
  if (profile.timezone && (!bs0 || !bs0.timezone || bs0.timezone === 'America/New_York') && profile.timezone !== (bs0?.timezone || 'America/New_York')) plan.settings_patch.timezone = profile.timezone;
  if (profile.policies.cancellation_window_hours != null) plan.settings_patch.cancellation_window_hours = profile.policies.cancellation_window_hours;
  return { plan, report, tenant: t, settings: bs0 || null };
}

function knowledgeFor(prior, profile, source, place) {
  return {
    ...prior,
    summary: profile.summary || prior.summary || null,
    positioning: profile.positioning || prior.positioning || null,
    audience: profile.audience || prior.audience || null,
    tone: profile.tone || prior.tone || null,
    usp: profile.usp || prior.usp || null,
    faq: profile.faq.length ? profile.faq : (prior.faq || []),
    policies: profile.policies,
    marketing: profile.marketing,
    instagram: source.instagram || prior.instagram || null,
    // How clients reach the salon today (never the Lola line in tenants.phone_number).
    salon_phone: place?.phone || profile.phone || source.links?.phone || prior.salon_phone || null,
    booking_link: source.links?.booking || prior.booking_link || null,
    booking_system: source.links?.booking_system || prior.booking_system || null,
    socials: { ...(prior.socials || {}), ...Object.fromEntries(['facebook', 'tiktok', 'youtube'].map(k => [k, source.links?.[k] || prior.socials?.[k] || null])) },
    instagram_profile: source.instagram_profile || prior.instagram_profile || null,
    google: place ? {
      place_id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng, rating: place.rating, reviews_count: place.reviews_count,
      review_link: place.review_link, maps_url: place.maps_url || source.maps_url, phone: place.phone, website: place.website, hours: place.hours,
      photos_count: place.photos_count, type: place.type, price_level: place.price_level, status: place.status,
      reviews: (place.reviews || []).slice(0, 5).map(r => ({ rating: r.rating, text: String(r.text || '').slice(0, 600), ago: r.ago })),
      competitors: (source.google?.competitors || []).slice(0, 12), fetched_at: new Date().toISOString(),
    } : (source.maps_url ? { ...(prior.google || {}), maps_url: source.maps_url, pending: source.google?.reason || 'unread' } : (prior.google || null)),
    learned: { at: new Date().toISOString(), website: source.website || null, maps: source.maps_url || null, pasted_menu: !!source.notes, services: profile.services.length, team: profile.team.length },
  };
}

/** Commit a plan in one transaction. → { ok, result } | { ok:false, missing:true } | { ok:false, error } */
export async function commitOnboarding(c, tenantId, plan) {
  const call = async () => { try { return await c.rpc('lola_apply_onboarding', { p_tenant_id: tenantId, p_plan: plan }); } catch (e) { return { data: null, error: { message: String(e?.message || e) } }; } };
  const { isMissingFunction, ensureSyncSchema } = await import('./sync-schema.js');
  let r = await call();
  if (r?.error && isMissingFunction(r.error)) {
    const st = await ensureSyncSchema();
    if (st === 'applied' || st === 'up-to-date') r = await call();
  }
  if (r?.error) return isMissingFunction(r.error) ? { ok: false, missing: true } : { ok: false, error: String(r.error.message || r.error).slice(0, 300) };
  const out = Array.isArray(r?.data) ? r.data[0] : r?.data;
  return out && out.ok ? { ok: true, result: out } : { ok: false, error: 'the database did not confirm the save' };
}

export async function applyProfile(c, tenant, profile, { source = {} } = {}) {
  let planned = null;
  try { planned = await planProfile(c, tenant, profile, { source }); } catch (e) { planned = null; }
  if (planned) {
    const { plan, report } = planned;
    const done = await commitOnboarding(c, tenant.id, plan);
    if (done.ok) {
      const x = done.result;
      report.atomic = true;
      report.services_added = Number(x.services_added) || 0;
      report.team_added = Number(x.team_added) || 0;
      if (x.prices_filled) report.prices_filled = Number(x.prices_filled);
      if (x.schedules_set) report.schedules_refit = Number(x.schedules_set);
      if (x.hours) { report.hours = true; report.hours_source = plan.hours?.source; report.business_hours = plan.hours?.week; }
      if (plan.settings_patch.timezone) report.timezone = plan.settings_patch.timezone;
      if (report.needs_price) { const want = new Set(report.needs_price.map((n) => String(n).toLowerCase())); report.needs_price = (x.services || []).filter((r) => want.has(String(r.name).toLowerCase())).map((r) => ({ id: r.id, name: r.name })); }
      if (report.team_added && !x.hours && !plan.hours) { try { await ensureBookingBaseline(tenant.id); } catch { report.notes.push('schedules_pending'); } }
      return report;
    }
    if (!done.missing) {
      // The transaction refused: NOTHING was written (no half-synced salon). Say so; the owner can retry.
      report.atomic = true; report.failed = true; report.notes.push('atomic_rollback'); report.error = done.error;
      return report;
    }
  }
  // No database function yet: the step-by-step writer (the live check asks for sql/sync-atomic-2026-10.sql).
  const legacy = await applyProfileSteps(c, tenant, profile, { source });
  legacy.atomic = false;
  return legacy;
}

async function applyProfileSteps(c, tenant, profile, { source = {} } = {}) {
  const report = { services_added: 0, team_added: 0, timezone: null, hours: false, notes: [] };
  const { data: fresh } = await q(c.from('tenants').select('*').eq('id', tenant.id).maybeSingle());
  const t = fresh || tenant;
  const place = source.google?.place || null;

  // 0) Opening hours → the salon's REAL week, where booking reads it (Google first — it's exact —
  //    then the website). Never over hours the owner set by hand. Stylists still on the starter week
  //    get the salon's week too.
  try {
    const week = (place?.hours?.length ? parsePlacesHours(place.hours) : null) || profile.business_hours || parseHoursText(profile.hours_text);
    const hoursSource = place?.hours?.length && parsePlacesHours(place.hours) ? 'google' : 'website';
    const { data: bs0 } = await q(c.from('booking_settings').select('*').eq('tenant_id', t.id).maybeSingle());
    const md0 = (bs0?.metadata && typeof bs0.metadata === 'object') ? bs0.metadata : {};
    const ownerSet = md0.hours_confirmed_at && !['website', 'google'].includes(md0.hours_source);
    if (week && !ownerSet) {
      const metadata = { ...md0, business_hours: week, hours_confirmed_at: new Date().toISOString(), hours_source: hoursSource };
      const payload = { tenant_id: t.id, business_hours: week, metadata };
      const w = await tolerantWrite((pl) => q(c.from('booking_settings').upsert(pl, { onConflict: 'tenant_id' })), payload, { required: ['tenant_id', 'metadata'] });
      if (!w.error) {
        report.hours = true; report.hours_source = hoursSource; report.business_hours = week;
        await refitStarterSchedules(c, t.id, week).then((n) => { if (n) report.schedules_refit = n; }, () => {});
      } else report.notes.push('hours_write_failed');
    }
  } catch (_) { report.notes.push('hours_failed'); }

  // 1) The service menu, where booking reads it.
  const { data: svcRows } = await q(c.from('services').select('*').eq('tenant_id', t.id));
  const isPlaceholder = (s) => /^consultation$/i.test(s.name || '') && !Number(s.price);
  const realServices = (svcRows || []).filter(s => !isPlaceholder(s) && s.is_active !== false);
  if (!realServices.length && profile.services.length) {
    const rows = profile.services.map(s => ({
      tenant_id: t.id, name: s.name, description: s.description || '', category: s.category || null,
      duration_minutes: s.duration_min || 60, price: s.price || 0, is_active: true,
    }));
    // Services the website doesn't price are kept — and Lola asks the owner for those prices.
    const unpriced = profile.services.filter(s => !s.price).map(s => s.name);
    if (unpriced.length) report.needs_price = unpriced.slice(0, 30);
    const ins = await tolerantWrite((pl) => q(c.from('services').insert(pl).select('id,name,duration_minutes')), rows, { required: ['tenant_id', 'name'] });
    if (!ins.error) {
      report.services_added = rows.length;
      if (report.needs_price) { const want = new Set(report.needs_price.map(n => n.toLowerCase())); report.needs_price = (ins.data || []).filter(r => want.has(String(r.name).toLowerCase())).map(r => ({ id: r.id, name: r.name })); }
      // Processing time for color services (separate update: a database without the phase columns still gets the menu).
      let phased = 0;
      for (const r of ins.data || []) { const ph = phasesFor(r.name, r.duration_minutes); if (ph) { const u = await q(c.from('services').update(ph).eq('id', r.id)); if (!u.error) phased++; } }
      if (phased) report.processing_phased = phased;
      const placeholders = (svcRows || []).filter(isPlaceholder).map(s => s.id);
      if (placeholders.length) await q(c.from('services').update({ is_active: false }).in('id', placeholders));
    } else report.notes.push('services_insert_failed');
  }

  // 2) The team (schedules are healed by ensureBookingBaseline).
  const { data: staffRows } = await q(c.from('staff').select('*').eq('tenant_id', t.id));
  const realStaff = (staffRows || []).filter(s => s.name !== DEFAULT_STAFF);
  if (!realStaff.length && profile.team.length) {
    const rows = profile.team.map(m => ({ tenant_id: t.id, name: m.name, role: m.role || 'Stylist', is_active: true }));
    const ins = await q(c.from('staff').insert(rows));
    if (!ins.error) {
      report.team_added = rows.length;
      try { await ensureBookingBaseline(t.id); } catch { report.notes.push('schedules_pending'); }
      const defaults = (staffRows || []).filter(s => s.name === DEFAULT_STAFF).map(s => s.id);
      if (defaults.length) await q(c.from('staff').update({ is_active: false }).in('id', defaults));
    } else report.notes.push('staff_insert_failed');
  }

  // 3) The tenant record Lola reads on every call — fill blanks only.
  const patch = {};
  const menu = Array.isArray(t.services) ? t.services.filter(s => s && (s.name || typeof s === 'string')) : [];
  if ((!menu.length || menu.every(s => /^consultation$/i.test(s.name || s))) && profile.services.length)
    patch.services = profile.services.map(s => ({ name: s.name, price: s.price, duration: s.duration_min ? `${s.duration_min} min` : null }));
  if (!t.hours && profile.hours_text) { patch.hours = profile.hours_text; report.hours = true; }
  if (!t.location && (profile.address || profile.city)) patch.location = profile.address || profile.city;
  if ((!Array.isArray(t.team) || !t.team.length) && profile.team.length) patch.team = profile.team;
  if (!t.website_url && source.website) patch.website_url = source.website;
  if (place) {
    if (!t.location && place.address) patch.location = place.address;
    if (!t.hours && !patch.hours && place.hours?.length) { patch.hours = place.hours.join('; ').slice(0, 400); report.hours = true; }
    if (!t.google_review_url && place.review_link) { patch.google_review_url = place.review_link; report.reviews_on = true; }
  }
  if (!t.gmb_url && (place?.maps_url || source.maps_url)) patch.gmb_url = place?.maps_url || source.maps_url;
  const dep = depositFromText(profile.policies?.deposit);
  if (dep) {
    report.deposit_found = dep;
    try {
      const { data: bs } = await q(c.from('booking_settings').select('tenant_id,metadata').eq('tenant_id', t.id).maybeSingle());
      if (bs) await q(c.from('booking_settings').update({ metadata: { ...(bs.metadata || {}), deposits_detected: dep } }).eq('tenant_id', t.id));
    } catch (_) {}
  }
  const persona = toneToPersona(profile.tone, profile.positioning);
  if (persona && (!t.persona || t.persona === 'warm')) patch.persona = persona;
  const prior = parseKnowledge(t.knowledge);
  patch.knowledge = JSON.stringify({
    ...prior,
    summary: profile.summary || prior.summary || null,
    positioning: profile.positioning || prior.positioning || null,
    audience: profile.audience || prior.audience || null,
    tone: profile.tone || prior.tone || null,
    usp: profile.usp || prior.usp || null,
    faq: profile.faq.length ? profile.faq : (prior.faq || []),
    policies: profile.policies,
    marketing: profile.marketing,
    instagram: source.instagram || prior.instagram || null,
    // How clients reach the salon today (never the Lola line in tenants.phone_number).
    salon_phone: place?.phone || profile.phone || source.links?.phone || prior.salon_phone || null,
    booking_link: source.links?.booking || prior.booking_link || null,
    booking_system: source.links?.booking_system || prior.booking_system || null,
    socials: { ...(prior.socials || {}), ...Object.fromEntries(['facebook', 'tiktok', 'youtube'].map(k => [k, source.links?.[k] || prior.socials?.[k] || null])) },
    instagram_profile: source.instagram_profile || prior.instagram_profile || null,
    google: place ? {
      place_id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng, rating: place.rating, reviews_count: place.reviews_count,
      review_link: place.review_link, maps_url: place.maps_url || source.maps_url, phone: place.phone, website: place.website, hours: place.hours,
      photos_count: place.photos_count, type: place.type, price_level: place.price_level, status: place.status,
      reviews: (place.reviews || []).slice(0, 5).map(r => ({ rating: r.rating, text: String(r.text || '').slice(0, 600), ago: r.ago })),
      competitors: (source.google.competitors || []).slice(0, 12), fetched_at: new Date().toISOString(),
    } : (source.maps_url ? { ...(prior.google || {}), maps_url: source.maps_url, pending: source.google?.reason || 'unread' } : (prior.google || null)),
    learned: { at: new Date().toISOString(), website: source.website || null, maps: source.maps_url || null, pasted_menu: !!source.notes, services: profile.services.length, team: profile.team.length },
  });
  const up = await q(c.from('tenants').update(patch).eq('id', t.id));
  if (up.error) {
    // An older tenants table may lack a column — retry with the core fields only.
    const core = {}; for (const k of ['services', 'hours', 'location', 'knowledge']) if (patch[k] !== undefined) core[k] = patch[k];
    const again = await q(c.from('tenants').update(core).eq('id', t.id));
    if (again.error) report.notes.push('tenant_update_failed');
    // The review link is what turns the review engine on — try it on its own.
    for (const k of ['google_review_url', 'gmb_url']) if (patch[k]) {
      const one = await q(c.from('tenants').update({ [k]: patch[k] }).eq('id', t.id));
      if (one.error && k === 'google_review_url') report.reviews_on = false;
    }
  }

  // 4) Booking settings: timezone only for a brand-new calendar; cancellation window if stated.
  const { data: bs } = await q(c.from('booking_settings').select('*').eq('tenant_id', t.id).maybeSingle());
  const bsPatch = {};
  if (profile.timezone && (!bs || !bs.timezone || bs.timezone === 'America/New_York') && profile.timezone !== (bs?.timezone || 'America/New_York')) {
    const { data: anyBooking } = await q(c.from('bookings').select('id').eq('tenant_id', t.id).limit(1));
    if (!(anyBooking || []).length) { bsPatch.timezone = profile.timezone; report.timezone = profile.timezone; }
  }
  if (profile.policies.cancellation_window_hours != null) bsPatch.cancellation_window_hours = profile.policies.cancellation_window_hours;
  if (Object.keys(bsPatch).length) {
    const r = bs ? await q(c.from('booking_settings').update(bsPatch).eq('tenant_id', t.id))
      : await q(c.from('booking_settings').insert({ tenant_id: t.id, ...bsPatch }));
    if (r.error) { report.notes.push('booking_settings_failed'); report.timezone = null; }
  }
  return report;
}

/** Stylists still on the starter week (09:00–19:00 every day, from the booking seed) take the salon's hours. */
async function refitStarterSchedules(c, tenantId, week) {
  const { data: staff } = await q(c.from('staff').select('id').eq('tenant_id', tenantId));
  const ids = (staff || []).map(s => s.id);
  if (!ids.length) return 0;
  const { data: rows } = await q(c.from('staff_schedules').select('staff_id,day_of_week,start_time,end_time').in('staff_id', ids));
  const by = new Map(); for (const r of rows || []) { if (!by.has(r.staff_id)) by.set(r.staff_id, []); by.get(r.staff_id).push(r); }
  const starter = (list) => list.length === 7 && list.every(r => String(r.start_time).slice(0, 5) === '09:00' && String(r.end_time).slice(0, 5) === '19:00');
  const salonRows = Object.entries(week).filter(([, d]) => !d.closed).map(([k, d]) => ({ day_of_week: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(k), start_time: d.open + ':00', end_time: d.close + ':00' }));
  let n = 0;
  for (const [sid, list] of by) {
    if (!starter(list)) continue;   // the owner shaped this stylist's week — leave it
    const del = await q(c.from('staff_schedules').delete().eq('staff_id', sid));
    if (del.error) continue;
    const ins = await q(c.from('staff_schedules').insert(salonRows.map(r => ({ tenant_id: tenantId, staff_id: sid, ...r }))));
    if (!ins.error) n++;
  }
  return n;
}

// ── Lola's words ─────────────────────────────────────────────
/** Where the salon sits on the map among its neighbors (stars × how many vouched). */
export function mapRank(place, competitors) {
  if (!place) return null;
  const score = (x) => (Number(x?.rating) || 0) * Math.log10((Number(x?.reviews_count) || 0) + 1);
  const all = [place, ...(competitors || []).filter(x => x && x.id !== place.id)];
  if (all.length < 2) return null;
  const sorted = all.slice().sort((a, b) => score(b) - score(a));
  return { rank: sorted.findIndex(x => x.id === place.id) + 1, of: all.length, leader: sorted[0].id === place.id ? sorted[1] : sorted[0] };
}
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
export function learnedSay(profile, report, source = {}) {
  const bits = [];
  const priced = profile.services.map(s => s.price).filter(Boolean);
  if (profile.services.length) bits.push(`${profile.services.length} service${profile.services.length === 1 ? '' : 's'}${priced.length > 1 ? ` from ${money(Math.min(...priced))} to ${money(Math.max(...priced))}` : ''}`);
  if (report.hours) bits.push(`your opening hours (from ${report.hours_source === 'google' ? 'Google' : 'your website'} — they're now your booking hours)`);
  else if (profile.hours_text) bits.push('your hours');
  if (profile.team.length) bits.push(`your team (${profile.team.slice(0, 3).map(t => t.name.split(' ')[0]).join(', ')}${profile.team.length > 3 ? '…' : ''})`);
  if (profile.faq.length) bits.push(`${profile.faq.length} common question${profile.faq.length === 1 ? '' : 's'}`);
  const place = source.google?.place;
  const from = source.website ? `I read ${source.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}${place ? ' and your Google Maps listing' : ''}`
    : place ? 'I read your Google Maps listing' : 'I read your menu';
  if (report.failed) return { say: `${from}, but saving it failed, so I saved nothing — your setup is exactly as it was. Say “learn my website” to try again.`, suggestions: ['Learn my website'] };
  let say = bits.length ? `${from} and learned ${bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits.at(-1) : bits[0]}.` : `${from}, but couldn't find services or prices. Paste your menu and I'll learn it.`;
  if (place?.rating) {
    const rank = mapRank(place, source.google.competitors || []);
    say += ` On Google Maps you're ${place.rating.toFixed(1)}★ from ${place.reviews_count.toLocaleString('en-US')} reviews${rank ? ` — #${rank.rank} of ${rank.of} salons around you` : ''}.`;
    if (report.reviews_on) say += ' I turned on Google review requests: every happy client gets your review link after their visit.';
  }
  if (source.links?.booking_system) say += ` I see your clients book in ${source.links.booking_system} — connect it in Settings → Booking and I'll book straight into it.`;
  if (report.needs_price?.length) say += ` Your website doesn't show prices for ${report.needs_price.length === 1 ? report.needs_price[0].name : report.needs_price.length + ' services'} — add ${report.needs_price.length === 1 ? 'it' : 'them'} below and I can quote and book ${report.needs_price.length === 1 ? 'it' : 'them'}.`;
  if (profile.tone || profile.positioning) say += ` I'll sound like your brand: ${String(profile.tone || profile.positioning).toLowerCase().replace(/\.$/, '')}.`;
  const fc = profile.marketing.first_campaign;
  if (fc) say += ` My first move: text your ${fc.segment === 'all' ? 'clients' : fc.segment === 'vip' ? 'VIP clients' : 'clients who haven’t been in for a while'}. Want to see the message?`;
  const suggestions = [];
  if (fc) suggestions.push(`Text my ${fc.segment === 'vip' ? 'VIP' : 'lapsed'} clients: ${fc.message}`);
  if (profile.marketing.opportunities.length) suggestions.push('How can I grow this month?');
  if (place) suggestions.unshift('Show my growth plan');
  suggestions.push('Catch me up on today');
  return { say, suggestions: suggestions.slice(0, 3) };
}

/** One call: read → understand → write. */
export async function learnBusiness(c, tenant, { website, notes, instagram, city, maps_url, llm } = {}) {
  const source = { website: null, notes: null, instagram: null, maps_url: null, google: null, instagram_profile: null };
  const chunks = [];
  let readError = null;
  // Google Maps first: it can also hand us the website the owner didn't type.
  if (maps_url) {
    source.maps_url = String(maps_url).trim().slice(0, 600);
    const [g, ig] = await Promise.all([
      readMaps(source.maps_url, { name: tenant.name, city }),
      instagram ? readInstagram(instagram) : Promise.resolve(null),
    ]);
    source.google = g; source.instagram_profile = ig;
    if (g?.ok) {
      const p = g.place;
      chunks.push([`=== GOOGLE MAPS LISTING ===`, p.name, p.address, p.phone ? `Phone: ${p.phone}` : '', p.website ? `Website: ${p.website}` : '',
        p.hours.length ? `Hours: ${p.hours.join('; ')}` : '', p.summary, p.rating ? `Rating ${p.rating} from ${p.reviews_count} reviews` : '',
        ...p.reviews.map(r => `Review (${r.rating}★): ${r.text}`)].filter(Boolean).join('\n'));
      if (!website && p.website) website = p.website;
    }
  } else if (instagram) source.instagram_profile = await readInstagram(instagram);
  if (website) {
    try { const site = await readWebsite(website); source.website = site.url; source.instagram = site.instagram; source.links = site.links || null; chunks.push(site.text); }
    catch (e) { readError = e.message; }
  }
  if (notes && String(notes).trim()) { source.notes = String(notes).slice(0, 20000); chunks.push(`=== MENU / NOTES FROM THE OWNER ===\n${source.notes}`); }
  if (instagram) source.instagram = String(instagram).replace(/^@|https?:\/\/(www\.)?instagram\.com\//g, '').replace(/\/.*$/, '').slice(0, 40) || source.instagram;
  if (source.instagram_profile?.read) chunks.push(`=== INSTAGRAM @${source.instagram_profile.handle} ===\n${source.instagram_profile.followers ?? '?'} followers, ${source.instagram_profile.posts ?? '?'} posts`);
  if (city) chunks.push(`=== LOCATION (from the owner) ===\n${String(city).slice(0, 120)}`);
  if (!chunks.length || (!source.website && !source.notes && !source.google?.ok)) {
    // Keep the Maps link even when it can't be read yet — the growth plan reads it later.
    if (source.maps_url && !tenant.gmb_url) { try { await c.from('tenants').update({ gmb_url: source.maps_url }).eq('id', tenant.id); } catch (_) {} }
    const mapsMiss = source.maps_url && !source.google?.ok
      ? (source.google?.reason === 'no_key' ? 'I saved your Google Maps link — I’ll read it as soon as Google Maps is connected.' : 'I couldn’t find that place on Google Maps.')
      : null;
    const say = readError ? `${String(readError).replace(/\.?$/, '.')} Try pasting your menu instead.`
      : mapsMiss ? `${mapsMiss} Add your website or paste your menu so I can learn the rest.`
      : 'Give me your website or paste your menu and I’ll learn it.';
    return { ok: false, error: readError || mapsMiss || 'Give me your website or paste your menu.', say, saved_maps: !!source.maps_url };
  }
  const corpus = chunks.join('\n\n');
  let raw = await understand({ name: tenant.name, businessMode: tenant.business_mode || 'salon', corpus, llm });
  let usedBrain = !!raw;
  if (!raw) raw = { services: heuristicServices(corpus), city: city || null };
  const profile = cleanProfile(raw);
  if (!profile.city && city) profile.city = String(city).slice(0, 80);
  const report = await applyProfile(c, tenant, profile, { source });
  const { say, suggestions } = learnedSay(profile, report, source);
  return { ok: !report.failed, ...(report.failed ? { error: 'save_failed_nothing_written' } : {}), used_brain: usedBrain, read_error: readError, source, profile, report, say, suggestions };
}
