// /api/billing/portal — retired before launch: it accepted any Stripe customer id from anyone.
// The live flow is /api/billing (signed in).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({ ok: false, error: 'gone', use: '/api/billing (signed in)' });
}
