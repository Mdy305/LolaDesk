/**
 * api/lib/business-learn.js — Lola learns a salon in one pass.
 * ════════════════════════════════════════════════════════════════
 * Reads the owner's website (several pages) and/or a pasted menu, asks the
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
import { safePublicUrl } from './onboarding-engine.js';
import { ensureBookingBaseline } from './booking-seed.js';

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
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LolaDesk/1.0; +https://loladesk.com)' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
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
  return { url: home.url, title, instagram, text: parts.join('\n\n').slice(0, 42000), pages: parts.length };
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

export async function applyProfile(c, tenant, profile, { source = {} } = {}) {
  const report = { services_added: 0, team_added: 0, timezone: null, hours: false, notes: [] };
  const { data: fresh } = await q(c.from('tenants').select('*').eq('id', tenant.id).maybeSingle());
  const t = fresh || tenant;

  // 1) The service menu, where booking reads it.
  const { data: svcRows } = await q(c.from('services').select('*').eq('tenant_id', t.id));
  const isPlaceholder = (s) => /^consultation$/i.test(s.name || '') && !Number(s.price);
  const realServices = (svcRows || []).filter(s => !isPlaceholder(s));
  if (!realServices.length && profile.services.length) {
    const rows = profile.services.map(s => ({
      tenant_id: t.id, name: s.name, description: s.description || '', category: s.category || null,
      duration_minutes: s.duration_min || 60, price: s.price || 0, is_active: true,
    }));
    const ins = await q(c.from('services').insert(rows));
    if (!ins.error) {
      report.services_added = rows.length;
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
    learned: { at: new Date().toISOString(), website: source.website || null, pasted_menu: !!source.notes, services: profile.services.length, team: profile.team.length },
  });
  const up = await q(c.from('tenants').update(patch).eq('id', t.id));
  if (up.error) {
    // An older tenants table may lack a column — retry with the core fields only.
    const core = {}; for (const k of ['services', 'hours', 'location', 'knowledge']) if (patch[k] !== undefined) core[k] = patch[k];
    const again = await q(c.from('tenants').update(core).eq('id', t.id));
    if (again.error) report.notes.push('tenant_update_failed');
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

// ── Lola's words ─────────────────────────────────────────────
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
export function learnedSay(profile, report, source = {}) {
  const bits = [];
  const priced = profile.services.map(s => s.price).filter(Boolean);
  if (profile.services.length) bits.push(`${profile.services.length} service${profile.services.length === 1 ? '' : 's'}${priced.length > 1 ? ` from ${money(Math.min(...priced))} to ${money(Math.max(...priced))}` : ''}`);
  if (profile.hours_text) bits.push('your hours');
  if (profile.team.length) bits.push(`your team (${profile.team.slice(0, 3).map(t => t.name.split(' ')[0]).join(', ')}${profile.team.length > 3 ? '…' : ''})`);
  if (profile.faq.length) bits.push(`${profile.faq.length} common question${profile.faq.length === 1 ? '' : 's'}`);
  const from = source.website ? `I read ${source.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}` : 'I read your menu';
  let say = bits.length ? `${from} and learned ${bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits.at(-1) : bits[0]}.` : `${from}, but couldn't find services or prices. Paste your menu and I'll learn it.`;
  if (profile.tone || profile.positioning) say += ` I'll sound like your brand: ${String(profile.tone || profile.positioning).toLowerCase().replace(/\.$/, '')}.`;
  const fc = profile.marketing.first_campaign;
  if (fc) say += ` My first move: text your ${fc.segment === 'all' ? 'clients' : fc.segment === 'vip' ? 'VIP clients' : 'clients who haven’t been in for a while'}. Want to see the message?`;
  const suggestions = [];
  if (fc) suggestions.push(`Text my ${fc.segment === 'vip' ? 'VIP' : 'lapsed'} clients: ${fc.message}`);
  if (profile.marketing.opportunities.length) suggestions.push('How can I grow this month?');
  suggestions.push('Catch me up on today');
  return { say, suggestions: suggestions.slice(0, 3) };
}

/** One call: read → understand → write. */
export async function learnBusiness(c, tenant, { website, notes, instagram, city, llm } = {}) {
  const source = { website: null, notes: null, instagram: null };
  const chunks = [];
  let readError = null;
  if (website) {
    try { const site = await readWebsite(website); source.website = site.url; source.instagram = site.instagram; chunks.push(site.text); }
    catch (e) { readError = e.message; }
  }
  if (notes && String(notes).trim()) { source.notes = String(notes).slice(0, 20000); chunks.push(`=== MENU / NOTES FROM THE OWNER ===\n${source.notes}`); }
  if (instagram) source.instagram = String(instagram).replace(/^@|https?:\/\/(www\.)?instagram\.com\//g, '').replace(/\/.*$/, '').slice(0, 40) || source.instagram;
  if (city) chunks.push(`=== LOCATION (from the owner) ===\n${String(city).slice(0, 120)}`);
  if (!chunks.length || (!source.website && !source.notes)) {
    return { ok: false, error: readError || 'Give me your website or paste your menu.', say: readError ? `${String(readError).replace(/\.?$/, '.')} Try pasting your menu instead.` : 'Give me your website or paste your menu and I’ll learn it.' };
  }
  const corpus = chunks.join('\n\n');
  let raw = await understand({ name: tenant.name, businessMode: tenant.business_mode || 'salon', corpus, llm });
  let usedBrain = !!raw;
  if (!raw) raw = { services: heuristicServices(corpus), city: city || null };
  const profile = cleanProfile(raw);
  if (!profile.city && city) profile.city = String(city).slice(0, 80);
  const report = await applyProfile(c, tenant, profile, { source });
  const { say, suggestions } = learnedSay(profile, report, source);
  return { ok: true, used_brain: usedBrain, read_error: readError, source, profile, report, say, suggestions };
}
