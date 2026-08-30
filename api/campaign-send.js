import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { sendSMS } from './telnyx-sms.js';

const PACE_MS = 250;
const MAX_RECIPIENTS = 150;
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });
  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant found' });
    if(!tenant.phone_number) return res.status(400).json({ ok:false, error:'No Lola number assigned yet' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });
    const input = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    let message = String(input.message||'').trim();
    const audience = String(input.audience||'all').toLowerCase();
    if(!message) return res.status(400).json({ ok:false, error:'A message is required' });
    if(!/stop|opt.?out|unsubscribe/i.test(message)) message = message.trim() + ' Reply STOP to opt out.';
    let query = client.from('clients').select('id,name,phone,last_visit', { count:'exact' })
      .eq('tenant_id', tenant.id).not('phone', 'is', null)
      .or('opted_out.is.null,opted_out.eq.false').limit(MAX_RECIPIENTS);
    if(audience === 'inactive'){ const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-60); query = query.lt('last_visit', cutoff.toISOString()); }
    else if(audience === 'vip') query = query.eq('is_vip', true);
    const { data: recipients, count: totalEligible, error: qErr } = await query;
    if(qErr) return res.status(500).json({ ok:false, error:'Could not load recipients' });
    if(!recipients?.length) return res.status(200).json({ ok:true, sent:0, skipped:0, failed:0, note:'No eligible recipients' });
    const wasTruncated = totalEligible != null && totalEligible > recipients.length;
    let sent=0, skipped=0, failed=0; const errors=[];
    for(const r of recipients){
      try{
        const text = r.name ? message.replace(/\{name\}/gi, r.name.split(' ')[0]) : message.replace(/\{name\}/gi,'there');
        const result = await sendSMS({ from:tenant.phone_number, to:r.phone, text, tenantId:tenant.id });
        if(result?.skipped) skipped++;
        else if(result?.errors?.length){ failed++; errors.push({ phone:r.phone, error:result.errors[0]?.detail }); }
        else sent++;
      }catch(e){ failed++; errors.push({ phone:r.phone, error:e.message }); }
      await sleep(PACE_MS);
    }
    return res.status(200).json({ ok:true, sent, skipped, failed, errors:errors.slice(0,5),
      note:`Sent to ${sent} of ${recipients.length} clients${skipped?`, ${skipped} opted out`:''}${failed?`, ${failed} failed`:''}${wasTruncated?`. ${totalEligible} total eligible — run again for more`:''}.` });
  }catch(e){ return res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
