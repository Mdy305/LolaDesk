/**
 * /api/operator-setup — Owner configures their voice-control gate.
 * ════════════════════════════════════════════════════════════════════════
 * Authenticated with the owner's Supabase session (Bearer token). Sets the
 * operator phone (soft caller-ID signal) and the spoken PIN (hashed) that
 * authorizes destructive voice actions.
 *
 *   POST /api/operator-setup
 *     headers: Authorization: Bearer <supabase access token>
 *     body:    { operator_phone?: "+1...", pin?: "1234" }
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY (via db.js / auth.js)
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { db, e164 } from './lib/db.js';
import { setOperatorPin } from './lib/operator-db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(bearer(req));
  if(!user?.email) return res.status(401).json({ error: 'Not signed in' });

  const c = db();
  if(!c) return res.status(500).json({ error: 'Database not configured' });

  // Link the signed-in owner to their salon.
  const { data: tenant } = await c.from('tenants')
    .select('id, owner_email').eq('owner_email', user.email).maybeSingle();
  if(!tenant?.id) return res.status(404).json({ error: 'No salon is linked to this account' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const out = { ok: true };

  if(body.operator_phone){
    const phone = e164(body.operator_phone);
    await c.from('tenants').update({ operator_phone: phone }).eq('id', tenant.id);
    out.operator_phone = phone;
  }

  if(body.pin !== undefined){
    const pin = String(body.pin).trim();
    if(!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
    await setOperatorPin(tenant.id, pin);
    out.pin_set = true;
  }

  if(out.operator_phone === undefined && out.pin_set === undefined){
    return res.status(400).json({ error: 'Provide operator_phone and/or pin' });
  }
  return res.status(200).json(out);
}
