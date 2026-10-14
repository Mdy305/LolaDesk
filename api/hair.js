/**
 * MMA Studio · AI length & volume.
 * POST { image: "data:image/jpeg;base64,…", inches: 12|18|24 }
 *  → { image: "data:image/…;base64,…" }
 *
 * The browser sends her photo already recolored to the chosen shade (our own color engine),
 * padded at the bottom so there is room for long hair. The image model adds only length and
 * fullness, keeping her face, color and everything else.
 * Runs through the Vercel AI Gateway (no key needed on Vercel: OIDC), or Google directly if
 * GEMINI_API_KEY is set. If neither is available, answers 503 and the studio keeps its classic preview.
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

export function prompt(inches, shade = {}, hasSwatch = false) {
  const color = shade.keep || (!hasSwatch && !shade.name)
    ? 'Keep her natural hair color exactly as it is: same tone, same light and shadow.'
    : `Color all of her hair, roots to ends, in the shade "${String(shade.name || '').slice(0, 40)}"${hasSwatch ? ', matching the hair swatch in the second image' : ''}${shade.story ? ` (${String(shade.story).slice(0, 220)})` : ''}. Paint it the way a master colorist would, never a flat dye: a softly deeper root that melts into the lengths, fine lighter ribbons around the face and through the hair, real shine where the light hits, and every strand with its own subtle variation. It must look like expensive salon color photographed in real life, not a filter.`;
  return [
    'Edit the first image, a photo of a woman. Its bottom part is blank padding: extend the photo naturally into it, continuing her shoulders, body, clothing and the background.',
    `Give her luxury human-hair extensions so her hair falls to ${FALL[inches]}, ${inches} inches long, full and dense like a full 100-gram set, with soft natural movement and healthy, lightly tapered ends.`,
    'Blend the extensions invisibly into her own hair at the same parting. No visible bonds, tapes or wefts.',
    color,
    'Keep her face, identity, skin tone, expression, eyes, makeup, head position, clothing, lighting and background exactly the same.',
    'Photorealistic, like an unretouched photo taken with the same camera, with natural grain. No filters, no beauty retouching, no added accessories, no text.'
  ].join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED.test(origin)) return res.status(403).json({ error: 'origin' });
  const gkey = process.env.GEMINI_API_KEY;   // optional: a direct Google key
  const gw = process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;   // default: Vercel AI Gateway, billed to the Vercel account
  if (!gkey && !gw) return res.status(503).json({ error: 'not_configured' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (limited(ip)) return res.status(429).json({ error: 'busy' });

  const body = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const inches = Number(body.inches);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(String(body.image || ''));
  if (!FALL[inches] || !m || m[1].length > 2.8e6) return res.status(400).json({ error: 'bad_input' });
  const sw = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(String(body.swatch || ''));
  const swatch = sw && sw[1].length < 6e5 ? sw[1] : '';
  const shade = body.shade && typeof body.shade === 'object' ? { name: String(body.shade.name || ''), story: String(body.shade.story || ''), keep: body.shade.keep === true } : {};
  const text = prompt(inches, shade, !!swatch);

  try {
    const image = gkey ? await viaGoogle(gkey, m[1], swatch, text) : await viaGateway(gw, m[1], swatch, text);
    if (image === 'unauthorized') return res.status(503).json({ error: 'not_configured' });
    if (!image) return res.status(502).json({ error: 'no_image' });
    return res.status(200).json({ image });
  } catch (e) {
    console.error('hair model', e);
    return res.status(502).json({ error: 'model' });
  }
}

/* Vercel AI Gateway: OpenAI-style chat completions with image output. */
export async function viaGateway(token, b64, swatch, text) {
  const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: process.env.GATEWAY_HAIR_MODEL || 'google/gemini-3.1-flash-image-preview',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ...(swatch ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${swatch}` } }] : []),
        { type: 'text', text }
      ] }],
      modalities: ['image', 'text'],
      stream: false
    })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 402 || r.status === 403) { console.error('hair gateway', r.status, JSON.stringify(j).slice(0, 300)); return 'unauthorized'; }
  if (!r.ok) { console.error('hair gateway', r.status, JSON.stringify(j).slice(0, 400)); return null; }
  const msg = j.choices && j.choices[0] && j.choices[0].message || {};
  const img = (msg.images || []).map(i => i.image_url && i.image_url.url).find(Boolean);
  return img || null;
}

/* Google Gemini API directly (when GEMINI_API_KEY is set). */
export async function viaGoogle(key, b64, swatch, text) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, ...(swatch ? [{ inline_data: { mime_type: 'image/jpeg', data: swatch } }] : []), { text }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) return 'unauthorized';
  if (!r.ok) { console.error('hair google', r.status, JSON.stringify(j).slice(0, 400)); return null; }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const img = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
  return img && img.data ? `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.data}` : null;
}
function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

