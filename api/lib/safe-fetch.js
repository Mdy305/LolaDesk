/**
 * api/lib/safe-fetch.js — fetch a URL a USER typed (salon website, iCal feed, marketer target)
 * without letting it reach LolaDesk's own network (SSRF).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  • http/https only, default ports or any port ≥ 1 (credentials in the URL refused)
 *  • the hostname is resolved (all addresses) and EVERY address must be public:
 *    no loopback, private, link-local / cloud metadata, CGNAT, multicast, reserved, ULA, IPv4-mapped
 *  • redirects are followed by hand (max 3), re-checking each hop
 *  • timeout + response size cap
 * Returns a real Response (body capped) so callers keep using .ok/.status/.text()/.json().
 * Throws SafeFetchError on anything refused.
 */
import dns from 'node:dns';
import net from 'node:net';

export class SafeFetchError extends Error {
  constructor(message, code = 'blocked') { super(message); this.name = 'SafeFetchError'; this.code = code; }
}

function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0) >>> 0; }
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([b, m]) => [v4ToInt(b), m]);

function blockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  // dotted IPv4 tail (::ffff:1.2.3.4)
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4ToInt(m[1]); s = s.slice(0, -m[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map(x => parseInt(x || '0', 16));
}

function blockedV6(ip) {
  const w = expandV6(ip);
  if (w.length !== 8 || w.some(x => !Number.isFinite(x))) return true;
  if (w.every(x => x === 0)) return true;                                   // ::
  if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return true;         // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true;                              // fec0::/10 site-local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;                      // documentation
  if (w[0] === 0x0064 && w[1] === 0xff9b) {                                 // NAT64 → embedded v4
    return blockedV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  }
  if (w[0] === 0x2002) return blockedV4(`${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`); // 6to4
  // IPv4-mapped / IPv4-compatible (::ffff:a.b.c.d, ::a.b.c.d)
  if (w.slice(0, 5).every(x => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    return blockedV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  }
  return false;
}

/** true when the address is anything but a normal public unicast address. */
export function isBlockedAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const fam = net.isIP(s);
  if (fam === 4) return blockedV4(s);
  if (fam === 6) return blockedV6(s);
  return true;
}

const isProd = () => process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const lookupAll = async (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Validate a URL (protocol, host, every resolved address). Returns the URL object or throws. */
export async function assertPublicUrl(raw, { lookup = lookupAll } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new SafeFetchError('Invalid URL', 'invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError('Only http and https URLs are allowed', 'bad_protocol');
  if (u.username || u.password) throw new SafeFetchError('URLs with credentials are not allowed', 'credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new SafeFetchError('Invalid URL host', 'invalid_url');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new SafeFetchError('That address is not reachable from LolaDesk', 'private_host');
  }
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await lookup(host); } catch {
      // Outside production an unresolvable name is let through to the (stubbed) fetch so offline
      // tests with *.example hosts keep working; nothing private can be reached by a name that
      // does not resolve. In production it is refused.
      if (!isProd()) return u;
      throw new SafeFetchError('Could not resolve ' + host, 'dns');
    }
  }
  if (!addrs || !addrs.length) throw new SafeFetchError('Could not resolve ' + host, 'dns');
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new SafeFetchError('That address is not reachable from LolaDesk', 'private_address');
  return u;
}

async function readCapped(resp, maxBytes) {
  if (!resp.body) return Buffer.alloc(0);
  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new SafeFetchError('Response too large', 'too_large');
  const chunks = []; let total = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} throw new SafeFetchError('Response too large', 'too_large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * fetch() for user-supplied URLs. Options: any fetch init plus
 *   timeoutMs (default 10000), maxBytes (default 3 MB), maxRedirects (default 3), lookup (tests).
 */
export async function safeFetch(raw, opts = {}) {
  const { timeoutMs = 10000, maxBytes = 3 * 1024 * 1024, maxRedirects = 3, lookup, ...init } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (init.signal) { try { init.signal.addEventListener('abort', () => ctrl.abort(), { once: true }); } catch (_) {} }
  try {
    let url = String(raw || '');
    let method = init.method || 'GET';
    let body = init.body;
    for (let hop = 0; ; hop++) {
      const u = await assertPublicUrl(url, lookup ? { lookup } : {});
      let resp;
      try {
        resp = await fetch(u.href, { ...init, method, body, redirect: 'manual', signal: ctrl.signal });
      } catch (e) {
        if (ctrl.signal.aborted) throw new SafeFetchError('Timed out fetching ' + u.hostname, 'timeout');
        throw e;
      }
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        if (hop >= maxRedirects) throw new SafeFetchError('Too many redirects', 'redirects');
        url = new URL(resp.headers.get('location'), u).href;
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        try { await resp.body?.cancel?.(); } catch (_) {}
        continue;
      }
      const buf = await readCapped(resp, maxBytes);
      const out = new Response(buf.length ? buf : null, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      try { Object.defineProperty(out, 'url', { value: u.href }); } catch (_) {}
      return out;
    }
  } catch (e) {
    if (ctrl.signal.aborted && !(e instanceof SafeFetchError)) throw new SafeFetchError('Timed out', 'timeout');
    throw e;
  } finally { clearTimeout(timer); }
}
