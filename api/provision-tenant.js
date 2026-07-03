/**
 * /api/provision-tenant — One call that makes a new salon fully live.
 * ════════════════════════════════════════════════════════════════════════
 * Creates BOTH Telnyx assistants for the authenticated owner's tenant:
 *   - the client-facing Lola (front desk)      via /api/telnyx-agents
 *   - the owner-facing Lola Ops (Jarvis)        via /api/operator-provision
 *
 * This is what turns "signed up" into "working" without anyone touching a
 * terminal. Idempotent: if an assistant for this tenant already exists it is
 * skipped, so re-running onboarding doesn't create duplicates.
 *
 * Auth: requires the owner's Supabase session. Only ever provisions the
 * tenant owned by the caller — never a tenant named in the request.
 *
 * POST /api/provision-tenant   (Authorization: Bearer <access token>)
 *   -> { ok, client: {...}, operator: {...}, texmlAppId }
 *
 * ENV: TELNYX_API_KEY, APP_URL (and SUPABASE_* via auth/db)
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';

const TELNYX = 'https://api.telnyx.com/v2';
function appUrl(){ return process.env.APP_URL || 'https://www.loladesk.com'; }
function authHeaders(){ return { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` }; }

// Existing assistants whose name contains this tenant's salon name -> skip.
async function existingFor(salonName){
  try{
    const r = await fetch(`${TELNYX}/ai/assistants`, { headers: authHeaders() });
    const j = await r.json();
    const list = (j && (j.data || j.assistants?.data || j.assistants)) || [];
    const needle = String(salonName||'').toLowerCase();
    return {
      client: list.find(a => (a.name||'').toLowerCase() === `lola — ${needle}` || (a.name||'').toLowerCase() === 'lola'),
      operator: list.find(a => (a.name||'').toLowerCase() === `lola ops — ${needle}`)
    };
  }catch{ return { client:null, operator:null }; }
}

async function postSelf(path, payload){
  const r = await fetch(`${appUrl()}${path}`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
  let data = null; try{ data = await r.json(); }catch{}
  return { status: r.status, data };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  if(!process.env.TELNYX_API_KEY) return res.status(500).json({ ok:false, error:'Missing TELNYX_API_KEY' });

  // Owner-scoped: only provision the caller's own tenant.
  const user = await getUserFromToken(bearer(req));
  if(!user?.email) return res.status(401).json({ ok:false, error:'Not authenticated' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });
  const { data: rows } = await c.from('tenants').select('*').eq('owner_email', user.email).limit(1);
  const tenant = rows && rows[0];
  if(!tenant?.id) return res.status(404).json({ ok:false, error:'No salon found for this account' });

  const tenantArg = { slug: tenant.slug, name: tenant.name, owner_name: tenant.owner_name };

  try{
    const have = await existingFor(tenant.name);
    const out = { ok:true, skipped:{} };

    // 1) Client-facing Lola (front desk)
    if(have.client){ out.client = { skipped:true, id: have.client.id }; out.skipped.client = true; }
    else { const r = await postSelf('/api/telnyx-agents', { tenant: tenantArg }); out.client = r.data; }

    // 2) Owner-facing Lola Ops (Jarvis)
    if(have.operator){ out.operator = { skipped:true, id: have.operator.id }; out.skipped.operator = true; }
    else { const r = await postSelf('/api/operator-provision', { tenant: tenantArg }); out.operator = r.data; }

    // Surface the TeXML app id (used to attach a phone number) if present.
    const opData = out.operator?.result?.data || out.operator;
    out.texmlAppId = opData?.telephony_settings?.default_texml_app_id || null;

    return res.status(200).json(out);
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
