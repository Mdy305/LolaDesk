// Signed OAuth state. The connect step runs for the SIGNED-IN owner only and
// seals which salon started it; the callback trusts nothing but a valid seal.
// (Before: state was plain base64 of ?tenant=<slug>, so anyone could attach
// their own Google/Square account to another salon.)
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const MAX_AGE_MS = 30 * 60 * 1000;
const key = () => process.env.OAUTH_STATE_SECRET || ('oauth-state:' + (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''));

export function sealState(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, t: Date.now(), n: randomBytes(6).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', key()).update(data).digest('base64url');
  return data + '.' + sig;
}

export function openState(raw) {
  try {
    const [data, sig] = String(raw || '').split('.');
    if (!data || !sig) return null;
    const expect = createHmac('sha256', key()).update(data).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const s = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!s || !s.tid || Date.now() - Number(s.t || 0) > MAX_AGE_MS) return null;
    return s;
  } catch { return null; }
}
