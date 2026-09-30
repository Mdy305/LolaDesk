/**
 * api/lib/growth-brief.js — Lola, VP of Marketing: where the next dollar is.
 * ════════════════════════════════════════════════════════════════════
 * One page an owner can act on in a minute. Every number is computed from
 * real data — the salon's Google Maps listing and the salons around it,
 * Instagram, the calendar's next 30 days and the client book. Where a dollar
 * figure is an estimate, the move says what it is based on.
 *
 *   SEE      where you stand on the map: rating, reviews, rank vs neighbors,
 *            listing gaps (phone that isn't Lola's line, no booking link…)
 *   DECIDE   ranked moves, biggest money first
 *   DO       each move has one button: a plan to approve, a switch to turn
 *            on, or a 2-minute fix on Google with the exact words to use
 *
 * Lola's brain (Telnyx inference) writes only the short "what clients say"
 * read of the reviews and three post ideas; everything else is deterministic,
 * so the brief is instant and never fails when the brain is slow.
 * Cached in tenants.knowledge.growth_brief (24h; ?refresh=1 rebuilds).
 */
import { chat } from './llm.js';
import { parseKnowledge, mapRank } from './business-learn.js';
import { forecast, latestPlan, bookingLinkFor } from './fill-plan.js';
import { clientHistory, planSegments } from './client-history.js';
import { placesConfigured, placeDetails, nearbyCompetitors, readMaps } from './google-places.js';
import { readInstagram } from './instagram-read.js';

const DAY = 864e5;
const STALE_MS = 24 * 3600e3;
// Conservative reply→booking rates for salon SMS (same basis as the fill plan).
const RATE = { due: 0.22, lapsed: 0.06, second_visit: 0.12 };
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const withTimeout = (p, ms, fallback = null) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);

/** Re-read the listing if it is older than a day (rating and reviews move). */
async function freshGoogle(tenant, k, { now, force }) {
  const g = k.google || null;
  if (!placesConfigured()) return g;
  const age = g?.fetched_at ? now - Date.parse(g.fetched_at) : Infinity;
  // Read in the last 10 minutes (e.g. onboarding just did) → never pay Google twice.
  if (g?.place_id && (age < 10 * 60e3 || (!force && age < STALE_MS))) return g;
  try {
    let place = null, competitors = g?.competitors || [];
    if (g?.place_id) {
      place = await placeDetails(g.place_id);
      if (force || !competitors.length || age > 7 * DAY) competitors = await nearbyCompetitors(place).catch(() => competitors);
    } else {
      const link = g?.maps_url || tenant.gmb_url;
      if (!link) return g;
      const r = await readMaps(link, { name: tenant.name, city: tenant.location });
      if (!r?.ok) return g;
      place = r.place; competitors = r.competitors;
    }
    return { ...(g || {}), place_id: place.id, name: place.name, address: place.address, lat: place.lat, lng: place.lng, rating: place.rating,
      reviews_count: place.reviews_count, review_link: place.review_link, maps_url: place.maps_url || g?.maps_url, phone: place.phone, website: place.website,
      hours: place.hours, photos_count: place.photos_count, type: place.type, price_level: place.price_level, status: place.status,
      reviews: (place.reviews || []).slice(0, 5).map((r) => ({ rating: r.rating, text: String(r.text || '').slice(0, 600), ago: r.ago })),
      competitors: competitors.slice(0, 12), fetched_at: new Date(now).toISOString(), pending: undefined };
  } catch (_) { return g; }
}

/** Visits in the last 30 days and how many of those clients already rebooked. */
async function recentVisits(c, tenantId, now) {
  const since = new Date(now - 30 * DAY).toISOString(), until = new Date(now).toISOString();
  try {
    const { data } = await c.from('bookings').select('client_id,start_time,status').eq('tenant_id', tenantId).gte('start_time', since).lte('start_time', until).limit(5000);
    return (data || []).filter((b) => !/^(cancel|no[-_ ]?show|declined|void)/i.test(b.status || ''));
  } catch (_) { return []; }
}

/** The ranked moves. Pure — easy to test, same inputs give the same plan. */
/** Average ticket: the calendar's, else what clients actually spent per visit. */
export function avgTicket(fc, hist) {
  if (fc?.avg_ticket) return fc.avg_ticket;
  let spend = 0, visits = 0;
  for (const h of hist?.values?.() || []) if (h.spend > 0 && h.visits > 0) { spend += h.spend; visits += h.visits; }
  return visits ? Math.round(spend / visits) : 0;
}

export function rankMoves({ tenant, google, ig, fc, seg, hist, visits, plan, lolaLine, bookingLink }) {
  const moves = [];
  const avg = avgTicket(fc, hist);
  const add = (m) => moves.push({ impact_usd: null, basis: null, done: false, ...m });

  // 1 · Open chairs in the next 30 days → the fill plan.
  if (fc?.has_schedule && fc.revenue_at_stake > 0) {
    const projected = Number(plan?.strategy?.projected_revenue) || 0;
    const planned = plan && ['proposed', 'active', 'paused'].includes(plan.status);
    add({ key: 'fill_plan', title: `Fill ${Math.round(fc.hours_to_target)} open chair-hours`,
      why: `The next 30 days are ${Math.round((fc.util || 0) * 100)}% booked${fc.slow_weekdays?.length ? `; ${fc.slow_weekdays.map((w) => w.weekday + 's').join(' and ')} are the slowest` : ''}. ${money(fc.revenue_at_stake)} of chair time is still open.`,
      impact_usd: projected || Math.round(fc.revenue_at_stake * 0.3),
      basis: projected ? 'Lola’s 30-day plan projection' : 'about 30% of the open chair time, at your menu’s hourly rate',
      action: { label: plan?.status === 'proposed' ? 'Approve the plan' : planned ? 'See the plan' : 'Build the plan', href: '/campaigns' }, done: plan?.status === 'active' });
  }
  // 2 · Clients who are due back now.
  if (seg?.due?.length && avg) add({ key: 'due', title: `Text ${seg.due.length} clients who are due back`,
    why: `They come in on a rhythm and it’s time. Nothing is booked for them yet.`, impact_usd: Math.round(seg.due.length * RATE.due * avg),
    basis: `${Math.round(RATE.due * 100)}% of them booking, at your ${money(avg)} average ticket`, action: { label: 'Send with the plan', href: '/campaigns' } });
  // 3 · Win back the lapsed.
  if (seg?.lapsed?.length && avg) add({ key: 'win_back', title: `Win back ${seg.lapsed.length} clients who stopped coming`,
    why: `No visit in 90+ days. A personal note from you brings some of them home.`, impact_usd: Math.round(seg.lapsed.length * RATE.lapsed * avg),
    basis: `${Math.round(RATE.lapsed * 100)}% coming back, at ${money(avg)}`, action: { label: 'Write the note', href: '/campaigns' } });
  // 4 · First-timers who never came back.
  if (seg?.second_visit?.length && avg) add({ key: 'second_visit', title: `Bring ${seg.second_visit.length} first-time clients back`,
    why: 'They came once. The second visit is the one that makes a regular.', impact_usd: Math.round(seg.second_visit.length * RATE.second_visit * avg),
    basis: `${Math.round(RATE.second_visit * 100)}% rebooking, at ${money(avg)}`, action: { label: 'Invite them back', href: '/campaigns' } });
  // 5 · Rebooking at the door.
  if (visits?.length >= 10 && hist) {
    const ids = [...new Set(visits.map((v) => v.client_id).filter(Boolean))];
    const rebooked = ids.filter((id) => hist.get(id)?.upcoming).length;
    const rate = ids.length ? rebooked / ids.length : 0;
    if (ids.length && rate < 0.5 && avg) add({ key: 'rebook', title: `Rebook more clients before they leave`,
      why: `Only ${Math.round(rate * 100)}% of last month’s clients have their next visit booked. The best salons are above 60%.`,
      impact_usd: Math.round((0.5 - rate) * ids.length * avg * 0.5), basis: `lifting rebooking to 50% for last month’s ${ids.length} clients, half of them staying`,
      action: { label: 'Open booking settings', href: '/booking-settings' } });
  }

  if (google?.place_id) {
    const rank = mapRank({ id: google.place_id, rating: google.rating, reviews_count: google.reviews_count }, google.competitors || []);
    const leader = rank?.leader;
    // 6 · The review engine.
    const reviewsOn = !!String(tenant.google_review_url || '').trim() && tenant.review_requests !== false && tenant.autopilot_enabled !== false;
    const perMonth = Math.max(1, Math.round(new Set((visits || []).map((v) => v.client_id).filter(Boolean)).size * 0.12));
    const gap = leader ? Math.max(0, (leader.reviews_count || 0) - (google.reviews_count || 0)) : 0;
    add({ key: 'reviews', title: reviewsOn ? 'Google reviews are on autopilot' : 'Turn on Google review requests',
      why: `${google.rating ? google.rating.toFixed(1) + '★ from ' + (google.reviews_count || 0).toLocaleString('en-US') + ' reviews' : 'No rating yet'}${rank ? `, #${rank.rank} of ${rank.of} on the map around you` : ''}.${leader && gap ? ` ${leader.name} has ${gap.toLocaleString('en-US')} more reviews.` : ''} Reviews are what moves you up the map.`,
      metric: `~${perMonth} new reviews a month${gap ? `, ${Math.ceil(gap / perMonth)} months to catch ${leader.name}` : ''}`,
      basis: '12% of the clients you see asked right after a great visit', action: reviewsOn ? { label: 'See reviews', href: '/reviews' } : { label: 'Turn on', api: 'enable_reviews' }, done: reviewsOn, weight: reviewsOn ? 1 : 700 });
    // 7 · Every call from Google should reach Lola.
    if (lolaLine && google.phone && digits(google.phone) !== digits(lolaLine)) add({ key: 'listing_phone', title: 'Put Lola’s number on your Google listing',
      why: `People who tap “Call” on Google Maps reach ${google.phone}, not Lola. Every call Lola misses is a booking that walks.`,
      fix: `Google Business Profile → Edit profile → Contact → Phone: ${lolaLine}`, action: { label: 'Open Google', href: 'https://business.google.com/' }, weight: 800 });
    if (bookingLink && !google.website) add({ key: 'listing_booking', title: 'Add your booking link to Google',
      why: 'Your listing has no website, so clients who want to book have nowhere to go.', fix: `Edit profile → Contact → Website: ${bookingLink}`,
      action: { label: 'Open Google', href: 'https://business.google.com/', copy: bookingLink }, weight: 500 });
    else if (bookingLink) add({ key: 'listing_booking', title: 'Add an “Appointments” link on Google',
      why: 'A booking button on the listing turns a Maps search straight into a booking, day or night.', fix: `Edit profile → Contact → Appointment links: ${bookingLink}`,
      action: { label: 'Open Google', href: 'https://business.google.com/', copy: bookingLink }, weight: 380 });
    if ((google.photos_count || 0) < 10) add({ key: 'listing_photos', title: 'Add photos of your best work',
      why: `Your listing shows ${google.photos_count || 'no'} photo${google.photos_count === 1 ? '' : 's'}. Listings with fresh photos get far more clicks.`,
      fix: 'Add 10+ photos: the space, the team, before/after of your signature services.', action: { label: 'Open Google', href: 'https://business.google.com/' }, weight: 220 });
    if (!google.hours?.length) add({ key: 'listing_hours', title: 'Add your hours to Google',
      why: 'Without hours, Google shows you less and clients assume you might be closed.', action: { label: 'Open Google', href: 'https://business.google.com/' }, weight: 260 });
  } else {
    add({ key: 'connect_maps', title: 'Show Lola your Google Maps listing',
      why: 'Paste the link you share for your salon on Google Maps. Lola compares you with the salons around you and turns on review requests.',
      action: { label: 'Add the link', href: '/onboarding?learn=1' }, weight: 650 });
  }

  // 8 · Instagram → bookings.
  if (ig?.handle && bookingLink) add({ key: 'instagram', title: `Turn @${ig.handle} into bookings`,
    why: `${ig.followers ? ig.followers.toLocaleString('en-US') + ' people follow you. ' : ''}Put the booking link in your bio and end every post with “Book in bio”. Lola answers the DMs that follow.`,
    fix: `Instagram → Edit profile → Links: ${bookingLink}`, action: { label: 'Copy booking link', copy: bookingLink },
    impact_usd: ig.followers && avg ? Math.round(ig.followers * 0.001 * avg) : null, basis: ig.followers ? '1 booking a month per 1,000 followers' : null, weight: 300, confidence: 0.4 });
  else if (!ig?.handle) add({ key: 'connect_instagram', title: 'Show Lola your Instagram', why: 'She’ll size your audience and plan posts that bring bookings.', action: { label: 'Add it', href: '/onboarding?learn=1' }, weight: 120 });

  // Done moves sink; softer estimates (confidence < 1) count for less when ranking.
  const score = (m) => m.done ? -1 : (m.impact_usd || 0) * (m.confidence ?? 1) + (m.weight || 0);
  return moves.sort((a, b) => score(b) - score(a)).map(({ weight, confidence, ...m }) => m);
}

/** A 0–100 read of how findable and bookable the salon is. */
export function visibilityScore(google, { bookingLink, lolaLine } = {}) {
  if (!google?.place_id) return null;
  const rank = mapRank({ id: google.place_id, rating: google.rating, reviews_count: google.reviews_count }, google.competitors || []);
  const leaderReviews = Math.max(google.reviews_count || 0, rank?.leader?.reviews_count || 0, 1);
  const stars = Math.max(0, Math.min(1, ((google.rating || 0) - 3.5) / 1.5));
  const volume = Math.min(1, (google.reviews_count || 0) / leaderReviews);
  const complete = [google.hours?.length, google.website, (google.photos_count || 0) >= 10, !lolaLine || digits(google.phone) === digits(lolaLine), !!bookingLink].filter(Boolean).length / 5;
  return Math.round(40 * stars + 35 * volume + 25 * complete);
}

/** Lola's read of the reviews: what clients love, what to fix, three posts. Labeled prose (Kimi writes prose reliably). */
export async function clientVoice({ tenant, google, k, llm = chat, timeoutMs = 16000 }) {
  const reviews = (google?.reviews || []).filter((r) => r.text).slice(0, 5);
  if (!llm || (!reviews.length && !k.summary)) return null;
  const system = `You are Lola, VP of Marketing for ${tenant.name || 'a salon'}. Be specific, warm and brief. Only use what is in the text. No hashtags, no emojis.
Answer in exactly this format:
HEADLINE: one sentence — the single biggest growth opportunity.
LOVED:
- what clients love (3 short lines, from the reviews)
FIX:
- what to improve (up to 2 short lines; write "- Nothing stands out" if the reviews are all positive)
POSTS:
- 3 Instagram post ideas that would bring bookings, one line each`;
  const user = [k.summary ? `About the salon: ${k.summary}` : '', k.usp ? `What makes them special: ${k.usp}` : '',
    reviews.length ? `Recent Google reviews:\n${reviews.map((r) => `(${r.rating}★) ${r.text}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  const res = await withTimeout(llm({ system, messages: [{ role: 'user', content: user.slice(0, 6000) }], maxTokens: 600, temperature: 0.4 }), timeoutMs);
  if (!res?.ok || !res.text) return null;
  const text = String(res.text).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const block = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:HEADLINE|LOVED|FIX|POSTS):|$)`, 'i'));
    return m ? m[1].trim() : '';
  };
  const list = (label) => block(label).split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l && !/^nothing stands out/i.test(l)).slice(0, 3);
  const out = { headline: block('HEADLINE').split('\n')[0].slice(0, 240) || null, loved: list('LOVED'), fix: list('FIX'), posts: list('POSTS') };
  return out.headline || out.loved.length || out.posts.length ? out : null;
}

export async function lolaLineFor(c, tenant) {
  if (tenant.phone_number) return tenant.phone_number;
  try {
    const { data } = await c.from('tenant_numbers').select('phone_number,kind,status').eq('tenant_id', tenant.id).limit(10);
    const rows = (data || []).filter((r) => !r.status || r.status === 'active');
    return (rows.find((r) => r.kind === 'primary') || rows[0])?.phone_number || null;
  } catch (_) { return null; }
}

/** Build (or return the cached) brief. */
export async function growthBrief(c, tenant, { now = Date.now(), refresh = false, llm = chat, save = true } = {}) {
  const k = parseKnowledge(tenant.knowledge);
  const cached = k.growth_brief;
  if (!refresh && cached?.at && now - Date.parse(cached.at) < STALE_MS) return { ...cached, cached: true };

  const nowD = new Date(now);
  const [google, ig, fc, hist, visits, plan, lolaLine] = await Promise.all([
    freshGoogle(tenant, k, { now, force: refresh }),
    k.instagram && (refresh || !k.instagram_profile?.at || now - Date.parse(k.instagram_profile.at) > 7 * DAY) ? readInstagram(k.instagram).then((r) => r || k.instagram_profile) : Promise.resolve(k.instagram_profile || (k.instagram ? { handle: k.instagram } : null)),
    forecast(c, tenant, { now: nowD }).catch(() => null),
    clientHistory(c, tenant.id, { now: nowD }).catch(() => null),
    recentVisits(c, tenant.id, now),
    latestPlan(c, tenant.id).catch(() => null),
    lolaLineFor(c, tenant),
  ]);
  const seg = hist ? planSegments(hist, { now: nowD }) : null;
  const bookingLink = bookingLinkFor(tenant);
  const moves = rankMoves({ tenant, google, ig, fc, seg, hist, visits, plan, lolaLine, bookingLink });
  const rank = google?.place_id ? mapRank({ id: google.place_id, rating: google.rating, reviews_count: google.reviews_count }, google.competitors || []) : null;
  // No brain this time (a quick rebuild after a switch)? Keep what she already read in the reviews.
  const voice = llm ? await clientVoice({ tenant, google, k, llm }).catch(() => null)
    : (cached?.voice ? { ...cached.voice, headline: cached.headline || null } : null);
  const open = moves.filter((m) => !m.done);
  const upside = open.reduce((s, m) => s + (m.impact_usd || 0), 0);
  const brief = {
    at: nowD.toISOString(),
    headline: voice?.headline || (open[0] ? `${open[0].title}.` : 'You’re in great shape. Lola keeps watching.'),
    upside_usd: upside,
    score: visibilityScore(google, { bookingLink, lolaLine }),
    google: google?.place_id ? { name: google.name, rating: google.rating, reviews_count: google.reviews_count, photos_count: google.photos_count, maps_url: google.maps_url,
      review_link: google.review_link, rank: rank?.rank || null, of: rank?.of || null,
      leader: rank?.leader ? { name: rank.leader.name, rating: rank.leader.rating, reviews_count: rank.leader.reviews_count } : null,
      competitors: (google.competitors || []).slice().sort((a, b) => (b.reviews_count || 0) - (a.reviews_count || 0)).slice(0, 5)
        .map((x) => ({ name: x.name, rating: x.rating, reviews_count: x.reviews_count, maps_url: x.maps_url })) }
      : (google?.maps_url ? { maps_url: google.maps_url, pending: google.pending || 'unread' } : null),
    instagram: ig?.handle ? { handle: ig.handle, followers: ig.followers ?? null, posts: ig.posts ?? null, read: !!ig.read } : null,
    business: fc ? { util: fc.util, open_hours: fc.hours_to_target, revenue_at_stake: fc.revenue_at_stake, avg_ticket: avgTicket(fc, hist),
      clients: seg?.total || 0, due: seg?.due?.length || 0, lapsed: seg?.lapsed?.length || 0, second_visit: seg?.second_visit?.length || 0 } : null,
    voice: voice ? { loved: voice.loved, fix: voice.fix, posts: voice.posts } : null,
    moves,
  };
  if (save) {
    const nextK = { ...k, growth_brief: brief };
    if (google?.place_id) nextK.google = google;
    if (ig?.handle) nextK.instagram_profile = ig;
    try { await c.from('tenants').update({ knowledge: JSON.stringify(nextK) }).eq('id', tenant.id); } catch (_) { /* the brief still returns */ }
  }
  return brief;
}

/** The one switch in the brief: Google review requests on. */
export async function enableReviews(c, tenant) {
  const k = parseKnowledge(tenant.knowledge);
  const link = String(tenant.google_review_url || '').trim() || k.google?.review_link;
  if (!link) return { ok: false, error: 'Show Lola your Google Maps listing first.' };
  const patch = { google_review_url: link, review_requests: true };
  let r = await c.from('tenants').update(patch).eq('id', tenant.id);
  if (r?.error) r = await c.from('tenants').update({ google_review_url: link }).eq('id', tenant.id);
  if (r?.error) return { ok: false, error: 'Couldn’t save that. Try again.' };
  const note = tenant.autopilot_enabled === false ? ' Autopilot is paused, so they’ll start when you turn it back on.' : '';
  return { ok: true, say: `Done. After every visit, happy clients get your Google review link.${note}`, google_review_url: link };
}
