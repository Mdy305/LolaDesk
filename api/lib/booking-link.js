/**
 * api/lib/booking-link.js — the ONE answer to "where does this salon's
 * client go to book?" — for every tenant, on every surface (Lola's calls
 * and texts, campaigns, the website chat widget, Home, Settings).
 *
 *   1. The salon's own booking link, when the owner set one (Boulevard,
 *      Vagaro, Square, their website…).
 *   2. Otherwise the salon's LolaDesk booking page: /book?t=<slug or id>.
 *      The public booking page accepts either, so this is never empty and
 *      never broken — even for a salon with no slug.
 *
 * Self-healing: a stored value that is really LolaDesk's own booking page
 * (older code wrote "…/book.html?t=<slug>" at provisioning, and "?t=" or
 * "?t=undefined" for salons without a slug) is recomputed, not trusted.
 */

export function appBase() {
  return String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
}

/** The salon's LolaDesk-hosted booking page ('' only if the tenant has no id at all). */
export function lolaBookingPage(tenant) {
  const key = String(tenant?.slug || '').trim() || String(tenant?.id || '').trim();
  return key ? `${appBase()}/book?t=${encodeURIComponent(key)}` : '';
}

function isOwnBookingPage(u) {
  let base;
  try { base = new URL(appBase()).hostname.replace(/^www\./, ''); } catch { base = 'loladesk.com'; }
  const host = u.hostname.replace(/^www\./, '');
  return (host === base || host === 'loladesk.com') && /^\/book(\.html)?\/?$/.test(u.pathname);
}

/** Where this salon's clients book. Always a working https link for a real tenant. */
export function bookingLinkFor(tenant) {
  const own = String(tenant?.booking_url || '').trim();
  if (own) {
    try {
      const u = new URL(own);
      if (/^https?:$/.test(u.protocol) && u.hostname.includes('.') && !isOwnBookingPage(u)) return own;
    } catch { /* not a URL — fall through to the LolaDesk page */ }
  }
  return lolaBookingPage(tenant);
}

/**
 * Settings input → value to store. '' / null clears it (use the LolaDesk
 * page). "mma.salon/book" becomes "https://mma.salon/book". Anything that
 * isn't a real web address is rejected with a message an owner understands.
 */
export function normalizeBookingUrl(input) {
  if (input == null) return { ok: true, value: null };
  const s = String(input).trim();
  if (!s) return { ok: true, value: null };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) {
    return { ok: false, error: 'Booking link must be a web address starting with https://' };
  }
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { u = null; }
  if (!u || !u.hostname.includes('.') || /\s/.test(s)) {
    return { ok: false, error: 'That doesn’t look like a web address. Paste the full link, e.g. https://yoursalon.com/book' };
  }
  if (isOwnBookingPage(u)) return { ok: true, value: null }; // their LolaDesk page is already the default
  return { ok: true, value: u.toString() };
}

/**
 * Telnyx accepts only text, true/false and whole numbers as dynamic-variable
 * values ("Value for key … must be a boolean, string, or integer"). One odd
 * column in one salon's row must never break that salon's calls.
 */
export function telnyxSafeVariables(vars = {}) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) out[k] = '';
    else if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isInteger(v) ? v : String(v);
    else if (typeof v === 'object') { try { out[k] = JSON.stringify(v); } catch { out[k] = ''; } }
    else out[k] = String(v);
  }
  return out;
}
