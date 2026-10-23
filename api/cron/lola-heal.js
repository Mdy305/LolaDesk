/**
 * /api/cron/lola-heal — every 30 minutes Lola checks her own wiring and repairs it, so nobody has to
 * open a page for her to come back: her phone assistant's brain (a model Telnyx still serves), tools,
 * salon details and greeting; the support line's brain; and every salon number ringing her.
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron GET; POST for manual runs).
 */
import { db } from '../lib/db.js';

const step = async (name, fn, out) => {
  try { out[name] = await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))]); }
  catch (e) { out[name] = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — lola-heal cron is disabled' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.TELNYX_API_KEY) { try { const { runDoctor } = await import('../lib/doctor.js'); await runDoctor({ c: db() }); } catch (_) {} return res.status(200).json({ ok: true, skipped: 'TELNYX_API_KEY not set' }); }
  const out = {};
  await step('models', async () => { const tm = await import('../lib/telnyx-models.js'); await tm.telnyxModels({ fresh: true }); return { ok: true, fast: await tm.modelFor('fast'), power: await tm.modelFor('power'), assistant: await tm.modelFor('assistant') }; }, out);
  await step('assistant', async () => {
    const { wireAssistant } = await import('../lib/assistant-wiring.js');
    const w = await wireAssistant({ heal: true });
    return { ok: !!w.ok, healed: !!w.healed, model: w.model || null, fixed: (w.miswired || []).length, added: w.added_tools || [], error: w.error || null };
  }, out);
  await step('doctor', async () => { const { runDoctor } = await import('../lib/doctor.js'); const r = await runDoctor({ c: db() }); return { ok: r.ok, failing: r.checks.filter((x) => !x.ok).map((x) => x.key), repaired: r.checks.filter((x) => x.healed).map((x) => x.key) }; }, out);
  await step('support_line', async () => {
    const { careState } = await import('../lib/customer-care.js');
    const care = await careState(db());
    if (!care?.assistant_id) return { ok: true, skipped: 'no support line' };
    const tm = await import('../lib/telnyx-models.js');
    const { telnyxRequest, telnyxData } = await import('../lib/telnyx-client.js');
    const a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(care.assistant_id), { timeoutMs: 8000 })) || {};
    const listed = a.model ? await tm.modelListed(a.model) : false;
    if (!a.model || listed === true || (listed === null && !tm.looksRetired(a.model))) return { ok: true, model: a.model || 'telnyx default' };
    const next = await tm.modelFor('assistant');
    const { updateAssistant } = await import('../lib/assistant-wiring.js');
    await updateAssistant(care.assistant_id, { model: next });
    return { ok: true, model: next, was: a.model || null, healed: true };
  }, out);
  await step('numbers', async () => {
    const { wireTenantNumbers } = await import('../lib/tenant-wiring.js');
    const w = await wireTenantNumbers(db(), { heal: true });
    return { ok: !w.error, numbers: (w.numbers || []).length, healed: w.healed || 0, broken: w.broken || 0, error: w.error || null };
  }, out);
  const ok = Object.values(out).every((x) => x && x.ok !== false);
  if (!ok) console.warn('[cron/lola-heal]', JSON.stringify(out).slice(0, 800));
  return res.status(200).json({ ok, ...out });
}
