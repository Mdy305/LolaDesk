/**
 * api/lib/instagram-read.js — what the public sees on a salon's Instagram.
 * Best effort, no login, no API key: the public profile page carries the
 * follower / post counts in its og:description. Instagram often blocks
 * servers — then Lola keeps the handle and simply says she couldn't read it.
 */
export function igHandle(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})/i) || s.match(/^@?([A-Za-z0-9_.]{1,30})\/?$/);
  const h = m ? m[1].replace(/\.+$/, '') : null;
  return h && !/^(p|reel|reels|explore|stories|accounts)$/i.test(h) ? h.toLowerCase() : null;
}

const num = (v) => {
  const m = String(v || '').replace(/,/g, '').match(/^([\d.]+)\s*([KkMm])?/);
  if (!m) return null;
  const n = parseFloat(m[1]) * (/k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** Parse "1,234 Followers, 56 Following, 789 Posts - See Instagram photos and videos from Name (@handle)". */
export function parseIgDescription(desc) {
  const d = String(desc || '').replace(/&quot;/g, '"').replace(/&#064;/g, '@').replace(/&amp;/g, '&');
  const f = d.match(/([\d.,]+\s*[KkMm]?)\s+Followers/i), g = d.match(/([\d.,]+\s*[KkMm]?)\s+Following/i), p = d.match(/([\d.,]+\s*[KkMm]?)\s+Posts/i);
  if (!f && !p) return null;
  const name = (d.match(/from\s+(.+?)\s+\(@/i) || [])[1] || null;
  return { followers: f ? num(f[1]) : null, following: g ? num(g[1]) : null, posts: p ? num(p[1]) : null, name };
}

export async function readInstagram(input, { timeoutMs = 6000 } = {}) {
  const handle = igHandle(input);
  if (!handle) return null;
  const out = { handle, url: `https://www.instagram.com/${handle}/`, followers: null, posts: null, name: null, read: false, at: new Date().toISOString() };
  try {
    const r = await fetch(out.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Accept-Language': 'en-US' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return out;
    const html = (await r.text()).slice(0, 300000);
    const desc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) || [])[1];
    const got = parseIgDescription(desc);
    if (got) Object.assign(out, got, { read: true });
  } catch (_) { /* blocked or offline — keep the handle */ }
  return out;
}
