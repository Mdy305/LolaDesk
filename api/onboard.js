// /api/onboard — retired before launch: it accepted a salon slug and overwrote that salon from anyone.
// The live flow is /onboarding (signup + /api/onboarding/*).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({ ok: false, error: 'gone', use: '/onboarding (signup + /api/onboarding/*)' });
}
