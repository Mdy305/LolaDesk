/**
 * api/lib/studio.js — MMA Studio (try-on boutique) logic, kept pure so it is testable.
 *
 * The widget on the salon's website sends three moments:
 *   lead    — name + mobile captured (the client starts the try-on)
 *   order   — the client reserves: a $500 deposit Checkout is created
 *   booking — the client picks an install slot
 * Prices and the deposit are decided HERE, never trusted from the browser.
 */

export const STUDIO_DEPOSIT_CENTS = Math.max(100, Number(process.env.STUDIO_DEPOSIT_CENTS) || 50000);
// Every set is a full 100 g; the price follows the length.
export const STUDIO_TIERS = Object.freeze({
  natural: { name: 'Natural', inches: 12, grams: 100, cents: 150000 },
  full:    { name: 'Full',    inches: 18, grams: 100, cents: 250000 },
  iconic:  { name: 'Iconic',  inches: 24, grams: 100, cents: 350000 }
});
// A shade other than the client's AI match = Color customization, done the same day as the install.
export const STUDIO_COLOR_CENTS = 50000;
export const STUDIO_METHODS = Object.freeze({ itips: 'I-Tips', tape: 'Tape-In', weft: 'Weft', meddy: 'Method by Meddy' });
export const STUDIO_INSTALL_MINUTES = 120;

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export const money = (cents) => '$' + (Math.round(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
export const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };

/** Validate and normalise what the browser sent. Returns { ok, error?, value? }. */
export function parseStudio(body = {}) {
  const event = String(body.event || '');
  if (!['lead', 'order', 'booking'].includes(event)) return { ok: false, error: 'bad_event' };
  const digits = String(body.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return { ok: false, error: 'bad_phone' };
  const name = clip(body.name, 60);
  if (!name) return { ok: false, error: 'bad_name' };
  const look = body.look || {};
  const tierKey = Object.prototype.hasOwnProperty.call(STUDIO_TIERS, look.fullness) ? look.fullness : 'full';
  const tier = STUDIO_TIERS[tierKey];
  const inches = tier.inches;              // the length IS the tier
  const value = {
    event, name, phone: '+1' + digits, salon: clip(body.salon, 20),
    look: {
      method: STUDIO_METHODS[look.method] || 'Method by Meddy',
      shade: clip(look.shade, 40) || 'Shade by Meddy', code: clip(look.code, 20),
      inches, fullness: tier.name, grams: tier.grams,
      colorChange: look.colorChange === true,
      priceCents: tier.cents + (look.colorChange === true ? STUDIO_COLOR_CENTS : 0),
      match: clip(look.match, 60)          // e.g. "Level 8 · neutral → Greige"
    },
    install: null,
    photos: event === 'order' ? parsePhotos(body.photos) : {}
  };
  if (event === 'booking') {
    const at = new Date(body.install?.startsAt || '');
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 3600e3) return { ok: false, error: 'bad_time' };
    value.install = { startsAt: at.toISOString(), artist: clip(body.install?.artist, 40) || 'Meddy', label: clip(body.install?.label, 60) };
  }
  return { ok: true, value };
}

/** The color reference: the client's photo, the try-on, and one order card with every detail. JPEG only, ≤ 1.5 MB each. */
export const STUDIO_PHOTO_KINDS = Object.freeze(['card', 'before', 'after']);
const PHOTO_MAX_BYTES = 1.5e6;
export function parsePhotos(photos) {
  const out = {};
  if (!photos || typeof photos !== 'object') return out;
  for (const k of STUDIO_PHOTO_KINDS) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(String(photos[k] || ''));
    if (!m) continue;
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 500 || buf.length > PHOTO_MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) continue;   // a real JPEG
    out[k] = buf;
  }
  return out;
}

export function lookLine(v) {
  const l = v.look;
  return `${l.method} · ${l.shade}${l.code ? ' #' + l.code : ''} · ${l.inches}″ ${l.fullness} ${l.grams} g ${l.colorChange ? ' + Color customization (same day)' : ' (perfect match, no color)'} · ${money(l.priceCents)}`;
}

/** The text the owner gets on their phone. */
export function ownerText(v, extra = {}) {
  const who = `${v.name} ${fmtPhone(v.phone)}`;
  if (v.event === 'lead') return `MMA Studio · New lead: ${who} is trying on extensions now.${v.look.match ? ' AI read: ' + v.look.match + '.' : ''} It's in your Lola inbox.`;
  if (v.event === 'order' && extra.paid) return `MMA Studio · DEPOSIT PAID ${money(STUDIO_DEPOSIT_CENTS)}: ${who}. ${lookLine(v)}. Order the hair now. Balance at install: ${money(v.look.priceCents - STUDIO_DEPOSIT_CENTS)}.`;
  if (v.event === 'order') return `MMA Studio · ${who} is paying the ${money(STUDIO_DEPOSIT_CENTS)} deposit: ${lookLine(v)}.${v.look.match ? ' AI read: ' + v.look.match + '.' : ''}${extra.links ? ' Color reference attached.' + extra.links : ''}`;
  return `MMA Studio · Install booked: ${who}, ${v.install.label || v.install.startsAt} with ${v.install.artist}. ${lookLine(v)}.`;
}

export const STUDIO_LINK = process.env.STUDIO_PUBLIC_URL || 'https://www.mmasalon.com/studio';
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

/** The client's own texts: a welcome when she starts, one gentle follow-up the next day if she has not reserved. */
export function clientText(v, kind) {
  const first = firstName(v.name);
  if (kind === 'welcome') return `Bonjour ${first}, it's Lola from MMA Salon. Your try-on is saved. When you're ready, reserve your hair here: ${STUDIO_LINK} Questions? Just reply. Reply STOP to opt out.`;
  if (kind === 'followup') return `Bonjour ${first}, it's Lola from MMA Salon. Still thinking about your new length? Your perfect-match shade is waiting, and your installation is the week after you reserve: ${STUDIO_LINK} Reply with any question, or STOP to opt out.`;
  return '';
}

/** What lands in the Lola inbox thread for this client. */
export function inboxNote(v, extra = {}) {
  if (v.event === 'lead') return `MMA Studio: started the try-on.${v.look.match ? ' AI read ' + v.look.match + '.' : ''}`;
  if (v.event === 'order') return `MMA Studio: ${extra.paid ? 'paid the' : 'started the'} ${money(STUDIO_DEPOSIT_CENTS)} deposit. ${lookLine(v)}.${v.look.match ? ' AI read ' + v.look.match + '.' : ''}${extra.links || ''}`;
  return `MMA Studio: booked the install ${v.install.label || v.install.startsAt} with ${v.install.artist}.`;
}
