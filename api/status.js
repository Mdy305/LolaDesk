/**
 * GET /api/status — "why isn't it working?" in one call, safe to open publicly.
 * Only yes/no answers and plain-language fixes: never a key, number or secret.
 *   release   which LolaDesk update is live (so we know the deploy landed)
 *   settings  each required Vercel variable: set or missing
 *   live      real probes: database, Telnyx key, Telnyx AI brain, salon numbers' texting registration (10DLC)
 *   fixes     what to do, in order
 * Cached 60s per instance.
 */
import { db } from './lib/db.js';

export const RELEASE = 'lola-anyplatform+status';
let cache = null;

const has = (...k) => k.some((x) => !!String(process.env[x] || '').trim());
async function tget(path, timeoutMs = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.telnyx.com/v2' + path, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 0, error: String(e?.name === 'AbortError' ? 'timeout' : e?.message || e) }; }
  finally { clearTimeout(t); }
}

export async function buildStatus() {
  const settings = {
    TELNYX_API_KEY: has('TELNYX_API_KEY'),
    TELNYX_ASSISTANT: has('TELNYX_LOLA_BRAIN_ID', 'TELNYX_ASSISTANT_ID'),
    TELNYX_VOICE_APP_ID: has('TELNYX_VOICE_APP_ID'),
    TELNYX_PUBLIC_KEY: has('TELNYX_PUBLIC_KEY'),
    SUPABASE: has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    CRON_SECRET: has('CRON_SECRET'),
    ADMIN_EMAILS: has('ADMIN_EMAILS'),
    INTEGRATION_ENCRYPTION_KEY: has('INTEGRATION_ENCRYPTION_KEY'),
    STRIPE_SECRET_KEY: has('STRIPE_SECRET_KEY'),
    GOOGLE_PLACES_API_KEY: has('GOOGLE_PLACES_API_KEY'),
  };
  const live = {};
  const fixes = [];
  // Database
  try { const c = db(); const { error } = c ? await c.from('tenants').select('id').limit(1) : { error: { message: 'not configured' } }; live.database = !error; } catch (_) { live.database = false; }
  // Telnyx key + AI brain
  if (settings.TELNYX_API_KEY) {
    const bal = await tget('/balance');
    live.telnyx_key = bal.ok;
    if (bal.ok) live.telnyx_balance_ok = Number(bal.j?.data?.available_credit ?? bal.j?.data?.balance ?? 1) > 0;
    const models = await tget('/ai/models');
    const ids = (models.j?.data || []).map((m) => m.id || m.name).filter(Boolean);
    live.telnyx_ai = models.ok && ids.length > 0;
    live.fast_model = ids.some((x) => /Llama-3\.3-70B/i.test(x));
    // Texting registration (10DLC) for every number on the account
    const nums = await tget('/phone_numbers?page[size]=100');
    const list = (nums.j?.data || []).map((n) => n.phone_number).filter(Boolean);
    live.numbers = list.length;
    const reg = await tget('/10dlc/phone_number_campaigns?page[size]=250');
    if (reg.ok) {
      const registered = new Set((reg.j?.records || reg.j?.data || []).map((r) => r.phoneNumber || r.phone_number).filter(Boolean));
      live.numbers_registered_10dlc = list.filter((n) => registered.has(n)).length;
    } else live.numbers_registered_10dlc = null;
  }
  if (!live.database) fixes.push('LolaDesk can’t reach its database — Vercel → Settings → Environment Variables: check SUPABASE_URL and SUPABASE_SERVICE_KEY, then Redeploy.');
  if (!settings.TELNYX_API_KEY) fixes.push('Add TELNYX_API_KEY in Vercel (Telnyx → API Keys), then Redeploy — without it Lola can’t think, speak, call or text.');
  else if (live.telnyx_key === false) fixes.push('Telnyx refuses the TELNYX_API_KEY in Vercel — create a new key in Telnyx → API Keys, paste it in Vercel, Redeploy.');
  if (live.telnyx_balance_ok === false) fixes.push('Your Telnyx balance is empty — calls, texts and Lola’s brain stop. Top up in Telnyx → Billing.');
  if (settings.TELNYX_API_KEY && live.telnyx_key && !live.telnyx_ai) fixes.push('Telnyx AI isn’t enabled on your account — Telnyx → AI → Inference: turn it on (Lola’s brain and hearing run there).');
  if (!settings.TELNYX_ASSISTANT) fixes.push('Add TELNYX_LOLA_BRAIN_ID in Vercel = your Telnyx AI assistant id (assistant-…), then Redeploy.');
  if (!settings.TELNYX_VOICE_APP_ID) fixes.push('Add TELNYX_VOICE_APP_ID in Vercel = your Telnyx Voice API application id, then Redeploy — needed for “Call me” and calling clients.');
  if (live.numbers > 0 && live.numbers_registered_10dlc === 0) fixes.push('None of your Telnyx numbers is registered for business texting (10DLC) — US carriers block the texts. Telnyx → Messaging → 10DLC: register your brand + campaign and assign your salon number.');
  else if (live.numbers > 0 && live.numbers_registered_10dlc != null && live.numbers_registered_10dlc < live.numbers) fixes.push(`${live.numbers - live.numbers_registered_10dlc} of your ${live.numbers} Telnyx numbers aren’t on a 10DLC campaign — texts from them get blocked. Assign them in Telnyx → Messaging → 10DLC.`);
  if (!settings.CRON_SECRET) fixes.push('Add CRON_SECRET in Vercel (any long random word), then Redeploy — without it calendar sync, reminders, deposits and Boulevard writes never run.');
  if (!settings.INTEGRATION_ENCRYPTION_KEY) fixes.push('Add INTEGRATION_ENCRYPTION_KEY in Vercel (run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"), then Redeploy — needed to connect Boulevard/Square/calendar links securely.');
  if (!settings.ADMIN_EMAILS) fixes.push('Add ADMIN_EMAILS in Vercel = your login email, then Redeploy — unlocks Admin and the full “Lola, run a check”.');
  return { ok: fixes.length === 0, release: RELEASE, settings, live, fixes, checked_at: new Date().toISOString() };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (cache && Date.now() - cache.at < 60e3) return res.status(200).json(cache.body);
  const body = await buildStatus().catch((e) => ({ ok: false, release: RELEASE, error: String(e?.message || e) }));
  cache = { at: Date.now(), body };
  return res.status(200).json(body);
}
