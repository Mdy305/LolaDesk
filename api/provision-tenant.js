/**
 * Reuses the account-level LolaDesk and LolaBrain Telnyx assistants.
 * It only creates an assistant when the corresponding shared assistant
 * cannot be found, preventing duplicate voice agents per tenant.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';

const TELNYX = 'https://api.telnyx.com/v2';
function appUrl(){ return process.env.APP_URL || 'https://www.loladesk.com'; }
function authHeaders(){ return { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.TELNYX_API_KEY}` }; }
function normalizedName(value){ return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function existingAssistants(){
  try{
    const r = await fetch(`${TELNYX}/ai/assistants`, { headers: authHeaders() });
    if(!r.ok) throw new Error(`Telnyx assistants lookup failed: ${r.status}`);
    const j = await r.json();
    const list = (j && (j.data || j.assistants?.data || j.assistants)) || [];
    return {
      client: list.find(a => ['loladesk','lola'].includes(normalizedName(a.name))),
      brain: list.find(a => ['lolabrain','lolaops','jarvis'].includes(normalizedName(a.name)))
    };
  }catch{
    return { client:null, brain:null };
  }
}

async function postSelf(path, payload){
  const r = await fetch(`${appUrl()}${path}`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  let data = null;
  try{ data = await r.json(); }catch{}
  if(!r.ok) throw new Error(data?.error || `${path} failed: ${r.status}`);
  return data;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });
  if(!process.env.TELNYX_API_KEY) return res.status(500).json({ ok:false, error:'Missing TELNYX_API_KEY' });

  const user = await getUserFromToken(bearer(req));
  if(!user?.email) return res.status(401).json({ ok:false, error:'Not authenticated' });
  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });
  const { data: rows } = await c.from('tenants').select('*').eq('owner_email', user.email).limit(1);
  const tenant = rows && rows[0];
  if(!tenant?.id) return res.status(404).json({ ok:false, error:'No salon found for this account' });

  const tenantArg = { slug: tenant.slug, name: tenant.name, owner_name: tenant.owner_name };
  try{
    const have = await existingAssistants();
    const out = { ok:true, reused:{}, assistants:{} };

    if(have.client){
      out.assistants.loladesk = { id:have.client.id, name:have.client.name, reused:true };
      out.reused.loladesk = true;
    }else{
      const created = await postSelf('/api/telnyx-agents', { tenant: tenantArg });
      out.assistants.loladesk = created;
    }

    if(have.brain){
      out.assistants.lolabrain = { id:have.brain.id, name:have.brain.name, reused:true };
      out.reused.lolabrain = true;
    }else{
      const created = await postSelf('/api/operator-provision', { tenant: tenantArg });
      out.assistants.lolabrain = created;
    }

    const brain = have.brain || out.assistants.lolabrain?.result?.data || out.assistants.lolabrain;
    out.texmlAppId = brain?.telephony_settings?.default_texml_app_id || null;
    out.message = 'Existing LolaDesk and LolaBrain assistants are reused whenever available.';
    return res.status(200).json(out);
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
