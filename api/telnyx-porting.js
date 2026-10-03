/**
 * /api/telnyx-porting — the signed-in salon's number transfer (legacy Settings / Numbers pages).
 * Delegates to the one engine (api/lib/setup/telecom.js) so this path does the FULL documented
 * Telnyx flow too (create → details → documents → confirm), stores the PIN and account number
 * encrypted only, and gives a temporary number a real routing row wired to Lola.
 *   GET  → { ok, orders: [...] }  this salon's transfers (no PINs / account numbers), synced first
 *   POST { phone_number, current_carrier?, account_number?, account_pin?, entity_name?, ... ,
 *          confirmed? } → { ok, say, needs?, needs_confirmation? }
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { portStart, portStatus } from './lib/setup/telecom.js';

const PUBLIC = ['id', 'requested_phone_number', 'status', 'current_carrier', 'foc_date', 'temporary_phone_number', 'created_at', 'updated_at'];

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({ ok:false, error: 'no tenant mapped to this account' });

    if(req.method === 'GET'){
      await portStatus(tenant).catch(() => null);
      const c = db();
      const { data } = c ? await c.from('tenant_number_ports').select('*').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(25) : { data: [] };
      const orders = (data || []).map((r) => ({ ...Object.fromEntries(PUBLIC.map((k) => [k, r[k] ?? null])), phone_numbers: [r.requested_phone_number].filter(Boolean) }));
      return res.status(200).json({ ok: true, orders });
    }

    if(req.method === 'POST'){
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const details = {
        phone_number: b.requested_phone_number || b.phone_number,
        carrier: b.current_carrier || b.carrier,
        account_number: b.account_number,
        pin: b.account_pin !== undefined && b.account_pin !== '' ? b.account_pin : b.pin,
        entity_name: b.entity_name || b.billing_name,
        auth_person_name: b.auth_person_name || b.authorized_contact_name || user?.user_metadata?.full_name || user?.user_metadata?.name,
        email: b.authorized_contact_email || user?.email,
        street: b.street, city: b.city, state: b.state, zip: b.zip,
        bill_url: b.bill_url, bill_base64: b.bill_base64, bill_filename: b.bill_filename, no_bill: b.no_bill === true ? true : undefined,
        loa_url: b.loa_url, loa_base64: b.loa_base64, loa_filename: b.loa_filename,
        temporary_number: b.use_temporary_number === true || b.temporary_number === true ? true : undefined,
      };
      Object.keys(details).forEach((k) => (details[k] === undefined || details[k] === null || details[k] === '') && delete details[k]);
      const r = await portStart(tenant, details, { authorized: b.confirmed === true });
      if(r.ok === false) return res.status(400).json({ ok: false, error: r.say, say: r.say });
      return res.status(200).json({ ok: true, say: r.say, needs: r.needs || [], needs_confirmation: !!r.needs_confirmation, submitted: !!r.submitted });
    }
    return res.status(405).json({ ok:false, error: 'Method Not Allowed' });
  }catch(e){
    return res.status(500).json({ ok:false, error: 'Something went wrong — try again, or ask Lola to move your number.' });
  }
}
