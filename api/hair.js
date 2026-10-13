/**
 * MMA Studio · AI length & volume.
 * POST { image: "data:image/jpeg;base64,…", inches: 12|18|24 }
 *  → { image: "data:image/…;base64,…" }
 *
 * The browser sends her photo already recolored to the chosen shade (our own color engine),
 * padded at the bottom so there is room for long hair. The image model adds only length and
 * fullness, keeping her face, color and everything else.
 * Needs GEMINI_API_KEY in the Vercel project. Without it, answers 503 and the studio keeps
 * its classic preview.
 */
const MODEL = process.env.HAIR_MODEL || 'gemini-2.5-flash-image';
const ALLOWED = /^https:\/\/(studio\.mmasalon\.com|(www\.)?mmasalon\.com|mma-studio[a-z0-9-]*\.vercel\.app)$/;
const FALL = {
  12: 'just past her collarbones',
  18: 'below her shoulder blades (bra-strap length)',
  24: 'the middle of her back'
};
const hits = new Map();   // best-effort per-instance rate limit
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > 40;
}

export function prompt(inches) {
  return [
    'Edit this photo. The bottom part of the image is blank padding: extend the photo naturally into it, continuing her shoulders, body, clothing and the background.',
    `Add luxury human-hair extensions so her hair falls to ${FALL[inches]}, ${inches} inches long, full and dense like a full 100-gram set, with soft natural movement and healthy, lightly tapered ends.`,
    'Blend the extensions invisibly into her own hair at the same parting. No visible bonds, tapes or wefts.',
    'Keep the hair color exactly as it is in the photo: same tone, same light and shadow. Change only the length and the fullness.',
    'Keep her face, identity, skin, expression, eyes, makeup, head position, clothing, lighting and background exactly the same.',
    'Photorealistic, like an unretouched photo taken with the same camera. No filters, no beauty retouching, no added accessories.'
  ].join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED.test(origin)) return res.status(403).json({ error: 'origin' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (limited(ip)) return res.status(429).json({ error: 'busy' });

  const body = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const inches = Number(body.inches);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(String(body.image || ''));
  if (!FALL[inches] || !m || m[1].length > 2.8e6) return res.status(400).json({ error: 'bad_input' });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: m[1] } }, { text: prompt(inches) }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('hair model', r.status, JSON.stringify(j).slice(0, 400)); return res.status(502).json({ error: 'model' }); }
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const img = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
    if (!img || !img.data) return res.status(502).json({ error: 'no_image' });
    return res.status(200).json({ image: `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.data}` });
  } catch (e) {
    console.error('hair model', e);
    return res.status(502).json({ error: 'model' });
  }
}
function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

