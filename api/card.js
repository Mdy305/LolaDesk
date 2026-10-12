// GET /api/card?b=<booking>&s=<signature> — the link in the "hold your appointment with a card" text.
// Opens a fresh, secure Stripe page (setup mode: nothing is charged) for that booking's client. The link is
// signed per booking and never expires; a client who already has a card on file goes straight to "done".
import { db } from './lib/db.js';
import { cardSigOk, startCardSetup } from './lib/card-on-file.js';

const home = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const b = String(req.query?.b || ''), s = String(req.query?.s || '');
  const go = (url) => { res.statusCode = 302; res.setHeader('Location', url); return res.end(); };
  if (!b || !/^[\w-]{1,64}$/.test(b) || !cardSigOk(b, s)) { res.statusCode = 404; return res.end('This link is not valid.'); }
  const c = db();
  if (!c || !process.env.STRIPE_SECRET_KEY) { res.statusCode = 503; return res.end('Cards can’t be added right now — please try again later.'); }
  try {
    const r = await startCardSetup(b, c);
    if (r.already) return go(`${home()}/paid?card=already`);
    if (r.url) return go(r.url);
    res.statusCode = 404; return res.end('This appointment was not found.');
  } catch (e) {
    console.warn('[card] setup failed:', String(e?.message || e).slice(0, 160));
    res.statusCode = 502; return res.end('Stripe is not reachable right now — please try the link again in a minute.');
  }
}
