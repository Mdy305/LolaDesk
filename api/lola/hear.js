/**
 * POST /api/lola/hear — Lola's ears on Telnyx.
 * { audio: base64, mime: 'audio/webm' } → { ok, text }
 * Speech-to-text by Telnyx AI (OpenAI-compatible /ai/audio/transcriptions).
 * Public (the sign-in page talks to her too), so: size cap + per-IP limit.
 */
const URL_STT = 'https://api.telnyx.com/v2/ai/audio/transcriptions';
// Telnyx STT docs: whisper-large-v3-turbo is the fast + accurate one, distil-large-v2 the lightweight fallback.
const MODELS = () => [process.env.LOLA_STT_MODEL, 'openai/whisper-large-v3-turbo', 'distil-whisper/distil-large-v2'].filter(Boolean);
// Words a salon says that generic speech-to-text mishears (Whisper's prompt biases toward them).
const SALON_WORDS = 'LolaDesk, Lola, balayage, highlights, keratin, blowout, ombré, toner, gloss, root touch-up, extensions, lash lift, brow lamination, microblading, manicure, pedicure, gel, facial, Botox, filler, appointment, reschedule, deposit, no-show';
const hits = new Map();
function limited(ip, max = 60, windowMs = 10 * 60e3) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h); return h.length > max;
}
let workingModel = null;

export async function transcribeAudio(buf, mime = 'audio/webm', { deadline = Date.now() + 45000, prompt = '' } = {}) {
  const key = process.env.TELNYX_API_KEY;
  if (!key) return { ok: false, error: 'telnyx_not_configured' };
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const models = workingModel ? [workingModel] : [...new Set(MODELS())];
  let last = '';
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 3000) { last = last || 'timeout'; break; }   // stay inside Vercel's 60s, whatever happens
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), 'speech.' + ext);
    fd.append('model', model);
    fd.append('language', 'en');
    fd.append('prompt', [SALON_WORDS, prompt].filter(Boolean).join(', ').slice(0, 800));
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), Math.min(20000, left));
    try {
      const r = await fetch(URL_STT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: ac.signal });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { workingModel = model; return { ok: true, text: String(j.text || j.data?.text || '').trim(), model }; }
      last = `${r.status} ${j?.errors?.[0]?.detail || j?.error?.message || j?.error || ''}`.slice(0, 160);
      if (r.status === 401 || r.status === 403) break;
    } catch (e) { last = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)); }
    finally { clearTimeout(t); }
  }
  if (workingModel && !/^(401|403)/.test(last) && deadline - Date.now() > 6000) { workingModel = null; return transcribeAudio(buf, mime, { deadline, prompt }); }   // the remembered model stopped answering: try them all again
  return { ok: false, error: 'stt_failed', detail: last };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const b = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const b64 = String(b.audio || '');
  if (!b64) return res.status(400).json({ ok: false, error: 'no_audio' });
  if (b64.length > 4_000_000) return res.status(413).json({ ok: false, error: 'too_long' });
  const buf = Buffer.from(b64, 'base64');
  const mime = /^audio\/[\w.+-]+$/.test(String(b.mime || '')) ? b.mime : 'audio/webm';
  const r = await transcribeAudio(buf, mime);
  if (!r.ok) { console.warn('[hear]', r.error, r.detail || ''); return res.status(502).json({ ok: false, error: r.error }); }
  return res.status(200).json({ ok: true, text: r.text });
}
