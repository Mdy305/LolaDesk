/**
 * api/lib/google-places.js — Lola reads a salon's Google Maps listing.
 *
 * The owner pastes the link they share for their salon on Google Maps
 * (maps.app.goo.gl/…, google.com/maps/place/…, or ?cid=…). Lola resolves it to
 * the place, then reads what clients see: rating, review count, recent
 * reviews, hours, phone, website, photos — and the salons around it.
 * Places API (New). Key: GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY).
 */
const BASE = 'https://places.googleapis.com/v1';
const key = () => process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
export const placesConfigured = () => !!key();

const DETAIL_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'reviews', 'regularOpeningHours',
  'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'googleMapsUri', 'photos', 'primaryType', 'types', 'priceLevel', 'businessStatus', 'editorialSummary'].join(',');
const LIST_FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.rating', 'places.userRatingCount',
  'places.primaryType', 'places.priceLevel', 'places.googleMapsUri', 'places.websiteUri'].join(',');

async function g(path, { method = 'GET', body, fields, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': fields }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Places ${r.status}: ${j?.error?.message || r.statusText}`);
    return j;
  } finally { clearTimeout(t); }
}

/** Pull what we can out of a Maps link without any API: name, coordinates, place id. */
export function parseMapsUrl(url) {
  const u = String(url || '');
  const out = { name: null, lat: null, lng: null, placeId: null, cid: null, query: null };
  const place = u.match(/\/maps\/place\/([^/@?]+)/); if (place) out.name = decodeURIComponent(place[1].replace(/\+/g, ' ')).trim();
  const at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if (at) { out.lat = +at[1]; out.lng = +at[2]; }
  const d = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if (d) { out.lat = +d[1]; out.lng = +d[2]; }
  const pid = u.match(/(?:place_id[:=]|!1s)(ChI[A-Za-z0-9_-]{10,})/); if (pid) out.placeId = pid[1];
  const cid = u.match(/[?&]cid=(\d+)/); if (cid) out.cid = cid[1];
  const q = u.match(/[?&](?:q|query)=([^&]+)/); if (q) out.query = decodeURIComponent(q[1].replace(/\+/g, ' '));
  return out;
}

/** Follow maps.app.goo.gl / goo.gl/maps short links to the full URL. */
export async function expandMapsUrl(url) {
  let u = String(url || '').trim(); if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  for (let i = 0; i < 4; i++) {
    let host = ''; try { host = new URL(u).hostname; } catch (_) { return u; }
    const shortLink = /goo\.gl|g\.co|maps\.app/i.test(host);
    const cidOnly = /google\./i.test(host) && /[?&]cid=\d+/.test(u) && !/\/maps\/place\//.test(u);
    if (!shortLink && !cidOnly) break;
    try {
      const r = await fetch(u, { redirect: 'manual' });
      const loc = r.headers.get('location'); if (!loc) break;
      u = new URL(loc, u).toString();
    } catch (_) { break; }
  }
  return u;
}

/** Find the place a link (or a name + city) points to. */
export async function resolvePlace({ mapsUrl, name, city } = {}) {
  if (!placesConfigured()) return null;
  const raw = String(mapsUrl || '').trim();
  const isLink = /^(https?:\/\/)?([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl|g\.co|maps\.app\.goo\.gl)\b/i.test(raw);
  // Not a link (a pasted name or address)? Search for it as written.
  if (raw && !isLink) name = raw;
  const full = raw && isLink ? await expandMapsUrl(raw) : '';
  const p = parseMapsUrl(full);
  if (p.placeId) return p.placeId;
  const text = [p.name || p.query || name, p.name ? '' : city].filter(Boolean).join(', ');
  if (!text) return null;
  const body = { textQuery: text, pageSize: 1 };
  if (p.lat != null) body.locationBias = { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 800 } };
  const j = await g('/places:searchText', { method: 'POST', body, fields: 'places.id' });
  return j?.places?.[0]?.id || null;
}

export async function placeDetails(placeId) {
  const j = await g('/places/' + encodeURIComponent(placeId), { fields: DETAIL_FIELDS });
  return {
    id: j.id, name: j.displayName?.text || '', address: j.formattedAddress || '', lat: j.location?.latitude ?? null, lng: j.location?.longitude ?? null,
    rating: j.rating ?? null, reviews_count: j.userRatingCount ?? 0, price_level: j.priceLevel || null, type: j.primaryType || (j.types || [])[0] || null,
    phone: j.nationalPhoneNumber || j.internationalPhoneNumber || null, website: j.websiteUri || null, maps_url: j.googleMapsUri || null,
    status: j.businessStatus || null, photos_count: Array.isArray(j.photos) ? j.photos.length : 0, summary: j.editorialSummary?.text || '',
    hours: j.regularOpeningHours?.weekdayDescriptions || [],
    reviews: (j.reviews || []).map((r) => ({ rating: r.rating, text: r.text?.text || r.originalText?.text || '', when: r.publishTime || null, ago: r.relativePublishTimeDescription || '' })),
    review_link: j.id ? `https://search.google.com/local/writereview?placeid=${j.id}` : null,
  };
}

/** The salons a client would compare on the map. */
export async function nearbyCompetitors(place, { radius = 2500, max = 12 } = {}) {
  if (!place || place.lat == null) return [];
  const type = /spa/i.test(place.type || '') ? 'spa' : /beauty|nail/i.test(place.type || '') ? 'beauty_salon' : 'hair_salon';
  const body = { includedTypes: [type], maxResultCount: Math.min(20, max + 1), rankPreference: 'POPULARITY',
    locationRestriction: { circle: { center: { latitude: place.lat, longitude: place.lng }, radius } } };
  const j = await g('/places:searchNearby', { method: 'POST', body, fields: LIST_FIELDS });
  return (j.places || []).filter((x) => x.id !== place.id).slice(0, max).map((x) => ({
    id: x.id, name: x.displayName?.text || '', rating: x.rating ?? null, reviews_count: x.userRatingCount ?? 0, price_level: x.priceLevel || null, maps_url: x.googleMapsUri || null, website: x.websiteUri || null,
  }));
}

/** Popularity on the map: stars weighted by how many people vouched for them. */
export const prominence = (x) => (Number(x?.rating) || 0) * Math.log10((Number(x?.reviews_count) || 0) + 1);

/** One call for onboarding: link → the listing + the salons around it. Never throws. */
export async function readMaps(mapsUrl, { name, city } = {}) {
  const link = String(mapsUrl || '').trim().slice(0, 600);
  if (!link) return null;
  if (!placesConfigured()) return { ok: false, reason: 'no_key', maps_url: link, parsed: parseMapsUrl(link) };
  try {
    const id = await resolvePlace({ mapsUrl: link, name, city });
    if (!id) return { ok: false, reason: 'not_found', maps_url: link };
    const place = await placeDetails(id);
    let competitors = [];
    try { competitors = await nearbyCompetitors(place); } catch (_) { /* the listing alone is still worth it */ }
    return { ok: true, place, competitors, maps_url: link };
  } catch (e) { return { ok: false, reason: 'error', error: String(e?.message || e), maps_url: link }; }
}
