/**
 * api/lib/review-syndication.js — the Atomic Review Syndication engine
 * ════════════════════════════════════════════════════════════════════
 * End to end, per the blueprint:
 *   CSV upload -> filter (rating === 5 && length > 10 chars) -> moderation
 *   -> sha-256 de-dup -> 1080x1080 card render (@vercel/og) -> Supabase
 *   storage CDN -> cron publishes to Meta Graph API (Facebook page photo,
 *   optional Instagram), staggered +48h apart.
 *
 * Everything is tenant-scoped. Meta credentials resolve per-tenant from the
 * `integrations` table (provider 'meta') with env-var fallback.
 */

import crypto from 'crypto';
import { ImageResponse } from '@vercel/og';
import { getTenantIntegrations } from './db.js';

// ── pure helpers (unit-testable, no DB / network) ──────────────────

export function hashReview(author, body){
  return crypto.createHash('sha256')
    .update(`${String(author ?? '').trim()}\u0000${String(body ?? '').trim()}`)
    .digest('hex');
}

const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const ADDRESS_RE = /\b\d{1,6}\s+(?:n\.?|s\.?|e\.?|w\.?)?\s*[a-z0-9]+\s+(?:street|st|avenue|ave|boulevard|blvd|road|rd|lane|ln|drive|dr|court|ct|way|place|pl)\b/i;

/**
 * Guardrail: flag reviews that leak a phone number or a street/postal
 * address before they are ever rendered into a public card.
 */
export function moderateReview(body){
  const t = String(body ?? '');
  if(PHONE_RE.test(t)) return { flagged: true, reason: 'phone_number' };
  if(ADDRESS_RE.test(t) || ZIP_RE.test(t)) return { flagged: true, reason: 'address' };
  return { flagged: false, reason: null };
}

export function normalizeRating(value){
  const s = String(value ?? '').replace(/[^0-9.]/g, '');
  if(!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Minimal CSV parser: quoted fields, escaped quotes, embedded commas/newlines.
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text ?? '');
  for(let i = 0; i < src.length; i++){
    const c = src[i];
    if(inQuotes){
      if(c === '"'){
        if(src[i + 1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n' || c === '\r'){
        if(c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        if(row.some(x => x !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if(field !== '' || row.length){
    row.push(field);
    if(row.some(x => x !== '')) rows.push(row);
  }
  return rows;
}

const HEADER_ALIASES = {
  rating: ['rating', 'stars', 'star_rating', 'score', 'star'],
  author: ['author', 'author_name', 'reviewer', 'name', 'customer', 'user'],
  body: ['review', 'review_body', 'review_text', 'body', 'text', 'content', 'comment', 'message']
};

function colIndex(header, aliases){
  const h = header.map(s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  for(const a of aliases){
    const i = h.indexOf(a);
    if(i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a CSV into { rating, author, body } rows. Accepts the common
 * Yelp / Google / Shopify export header names; falls back to positional
 * (rating, author, body…) when the header is unrecognised.
 */
export function parseReviewCSV(text){
  const grid = parseCSV(text);
  if(!grid.length) return { rows: [], error: 'CSV is empty' };
  const first = grid[0];
  const iRating = colIndex(first, HEADER_ALIASES.rating);
  const iAuthor = colIndex(first, HEADER_ALIASES.author);
  const iBody = colIndex(first, HEADER_ALIASES.body);
  const hasHeader = iRating >= 0 || iAuthor >= 0 || iBody >= 0;

  const dataRows = (hasHeader ? grid.slice(1) : grid)
    .filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if(!dataRows.length) return { rows: [], error: hasHeader ? 'CSV has a header but no data rows' : 'CSV has no data rows' };

  const rows = dataRows.map(r => {
    if(!hasHeader) return { rating: r[0], author: r[1] ?? '', body: r.slice(2).join(' ').trim() };
    return {
      rating: iRating >= 0 ? r[iRating] : r[0],
      author: iAuthor >= 0 ? r[iAuthor] : '',
      body: iBody >= 0 ? r[iBody] : (iRating >= 0 ? r.slice(2).join(' ').trim() : '')
    };
  });
  return { rows, error: null };
}

/**
 * The blueprint filter: keep only rating === 5 with body longer than
 * 10 chars, and drop anything moderation flags.
 */
export function filterReviews(rows, { minBodyLength = 11 } = {}){
  const accepted = [], rejected = [];
  for(const row of (rows || [])){
    const rating = normalizeRating(row.rating);
    const body = String(row.body ?? '').trim();
    const author = String(row.author ?? '').trim();
    if(rating !== 5){ rejected.push({ row, reason: 'not_five_star' }); continue; }
    if(body.length < minBodyLength){ rejected.push({ row, reason: 'too_short' }); continue; }
    const mod = moderateReview(body);
    if(mod.flagged){ rejected.push({ row, reason: 'flagged', detail: mod.reason }); continue; }
    accepted.push({ rating, author, body });
  }
  return { accepted, rejected };
}

// ── card renderer (1080x1080 PNG via @vercel/og) ───────────────────

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });

// Gold 5-pointed star as an inline SVG data URI. @vercel/og's bundled font
// lacks U+2605, so stars are images — no dynamic Google Fonts fetch, zero
// network at render time, deterministic output.
const STAR = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><path fill="#eab308" d="M12 2l2.9 6.26 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8-5.1-4.7 6.9-.8z"/></svg>'
);

function clean(text){
  return String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Render the luxury review card. Dark slate #09090b, gold #eab308 stars,
 * white quote, gray attribution, neon-lime brand mark.
 */
export async function renderReviewCardPng({ author, body, tenantName } = {}){
  const quote = clean(body).slice(0, 300) || 'Amazing experience.';
  const byline = clean(author) || 'Happy client';
  const brand = clean(tenantName) || 'LolaDesk';

  const stars = Array.from({ length: 5 }, (_, i) =>
    h('img', { src: STAR, width: 60, height: 60, style: { display: 'flex', marginRight: i < 4 ? 8 : 0 } })
  );

  const card = h('div',
    { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#09090b', color: '#fafafa', padding: 110 } },
    h('div', { style: { display: 'flex', flexDirection: 'row', justifyContent: 'center' } }, stars),
    h('div', { style: { display: 'flex', fontSize: 44, marginTop: 48, textAlign: 'center', lineHeight: 1.35, maxWidth: 840, color: '#f4f4f5' } }, `"${quote}"`),
    h('div', { style: { display: 'flex', fontSize: 30, marginTop: 46, color: '#a1a1aa' } }, `— ${byline}`),
    h('div', { style: { display: 'flex', flexDirection: 'row', marginTop: 64, alignItems: 'center' } },
      h('div', { style: { display: 'flex', fontSize: 22, letterSpacing: 4, color: '#ccff00', textTransform: 'uppercase' } }, brand),
      h('div', { style: { display: 'flex', fontSize: 22, marginLeft: 18, color: '#52525b' } }, '· verified review')
    )
  );

  const res = new ImageResponse(card, { width: 1080, height: 1080 });
  return Buffer.from(await res.arrayBuffer());
}

// ── DB / network pipeline ──────────────────────────────────────────

/**
 * Filter + moderate + de-dup + stagger-insert. Returns a summary the upload
 * endpoint can relay. `client` is a Supabase client (injectable for tests).
 */
export async function scheduleReviews(client, tenantId, source, rows, { staggerHours = 48, minBodyLength = 11 } = {}){
  if(!client) return { ok: false, error: 'db_not_configured' };
  const { accepted, rejected } = filterReviews(rows, { minBodyLength });
  const skipped = { not_five_star: 0, too_short: 0, flagged: 0, duplicate: 0 };
  for(const r of rejected){
    if(r.reason === 'not_five_star') skipped.not_five_star++;
    else if(r.reason === 'too_short') skipped.too_short++;
    else skipped.flagged++;
  }

  const candidates = accepted.map(r => ({ ...r, content_hash: hashReview(r.author, r.body) }));
  let existing = new Set();
  try{
    const hashes = candidates.map(c => c.content_hash);
    if(hashes.length){
      const { data } = await client.from('review_queue').select('content_hash').in('content_hash', hashes);
      existing = new Set((data || []).map(x => x.content_hash));
    }
  }catch{ /* a missing table shouldn't crash the upload; proceed to insert */ }
  // Dedup both against rows already in the queue AND within the batch itself.
  const seen = new Set(existing);
  const fresh = [];
  for(const c of candidates){
    if(seen.has(c.content_hash)){ skipped.duplicate++; continue; }
    seen.add(c.content_hash);
    fresh.push(c);
  }

  const base = Date.now();
  const toInsert = fresh.map((c, i) => ({
    tenant_id: tenantId,
    source,
    content_hash: c.content_hash,
    author_name: c.author,
    rating: 5,
    review_body: c.body,
    status: 'scheduled',
    scheduled_for: new Date(base + i * staggerHours * 3600 * 1000).toISOString()
  }));

  let inserted = 0;
  if(toInsert.length){
    const { data, error } = await client.from('review_queue').insert(toInsert).select();
    if(error) return { ok: false, error: error.message, scheduled: 0, skipped };
    inserted = (data || []).length;
  }
  return { ok: true, accepted: accepted.length, scheduled: inserted, skipped };
}

/**
 * Render a card for a queue row, upload it to the public review-cards
 * bucket, and store the URL back on the row.
 */
export async function storeReviewCard(client, tenant, review){
  const png = await renderReviewCardPng({ author: review.author_name, body: review.review_body, tenantName: tenant?.name });
  const path = `${tenant?.id || 'global'}/review-${review.id}.png`;
  const { error: upErr } = await client.storage.from('review-cards').upload(path, png, { contentType: 'image/png', upsert: true, cacheControl: '31536000' });
  if(upErr) throw new Error(upErr.message || 'storage upload failed');
  const { data } = client.storage.from('review-cards').getPublicUrl(path);
  const url = data?.publicUrl;
  if(!url) throw new Error('no public url for card');
  await client.from('review_queue').update({ image_url: url }).eq('id', review.id).eq('tenant_id', tenant?.id || review.tenant_id);
  return url;
}

/**
 * Resolve Meta credentials for a tenant: per-tenant 'meta' integration
 * first (decrypted token + metadata page_id / ig_user_id), env fallback.
 */
export async function resolveMetaConfig(client, tenantId){
  const env = {
    accessToken: process.env.META_ACCESS_TOKEN || null,
    pageId: process.env.META_PAGE_ID || null,
    igUserId: process.env.META_IG_ID || null
  };
  if(!client || !tenantId) return env;
  try{
    const integrations = await getTenantIntegrations(tenantId);
    const meta = integrations.find(i => i.provider === 'meta' || i.provider === 'facebook');
    if(meta?.access_token){
      return {
        accessToken: meta.access_token,
        pageId: meta.metadata?.page_id || meta.metadata?.pageId || env.pageId,
        igUserId: meta.metadata?.ig_user_id || meta.metadata?.igUserId || env.igUserId
      };
    }
  }catch{ /* fall through to env */ }
  return env;
}

const META_GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Publish a rendered card to Meta. Facebook page photo is primary; when an
 * Instagram business id is configured the same image is also published there.
 * Throws on failure so the cron can mark the row failed.
 */
export async function publishToMeta(config, { imageUrl, caption }){
  if(!config?.accessToken) throw new Error('No Meta access token configured');
  if(!config.pageId && !config.igUserId) throw new Error('No Meta page_id or ig_user_id configured');

  let postId = null, provider = null;

  if(config.pageId){
    const r = await fetch(`${META_GRAPH}/${config.pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: imageUrl, caption, access_token: config.accessToken })
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(data?.error?.message || `Meta Facebook publish failed (${r.status})`);
    postId = data.post_id || data.id || null;
    provider = 'facebook';
  }

  if(config.igUserId){
    const create = await fetch(`${META_GRAPH}/${config.igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image_url: imageUrl, caption, access_token: config.accessToken })
    });
    const cdata = await create.json().catch(() => ({}));
    if(!create.ok) throw new Error(cdata?.error?.message || `Meta Instagram media create failed (${create.status})`);

    const publish = await fetch(`${META_GRAPH}/${config.igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: cdata.id, access_token: config.accessToken })
    });
    const pdata = await publish.json().catch(() => ({}));
    if(!publish.ok) throw new Error(pdata?.error?.message || `Meta Instagram publish failed (${publish.status})`);

    postId = postId || pdata.id || cdata.id;
    provider = provider ? 'facebook+instagram' : 'instagram';
  }

  return { posted: true, postId, provider };
}

export default { hashReview, moderateReview, normalizeRating, parseReviewCSV, filterReviews, renderReviewCardPng, scheduleReviews, storeReviewCard, resolveMetaConfig, publishToMeta };
