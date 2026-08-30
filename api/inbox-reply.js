/**
 * api/inbox-reply.js — owner sends a manual reply from the Inbox UI.
 * ════════════════════════════════════════════════════════════════
 * Previously inbox.html's sendReply() only pushed the typed message into
 * a local in-memory array and re-rendered — the client never actually
 * received anything. This endpoint does the real send: looks up the
 * conversation (verifying it belongs to the authenticated tenant), sends
 * through Telnyx using the tenant's own number, and logs the message so
 * it shows up in real conversation history on future loads.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { db, logMessage } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { sendSMS } from './telnyx-sms.js';

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
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });

    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const input = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const conversationId = input.conversation_id;
    const text = String(input.text||'').trim();
    if(!conversationId || !text) return res.status(400).json({ ok:false, error:'conversation_id and text are required' });
    if(text.length > 1500) return res.status(400).json({ ok:false, error:'Message is too long' });

    // Verify the conversation actually belongs to this tenant — never
    // trust a client-supplied conversation_id blindly.
    const { data: conv } = await client.from('conversations').select('*').eq('id', conversationId).eq('tenant_id', tenant.id).maybeSingle();
    if(!conv) return res.status(404).json({ ok:false, error:'Conversation not found' });

    const channel = String(conv.channel||'sms').toLowerCase();
    if(!['sms','whatsapp'].includes(channel)){
      return res.status(400).json({ ok:false, error:`Replying from the dashboard isn't supported for ${channel} yet` });
    }
    if(!tenant.phone_number) return res.status(400).json({ ok:false, error:'No Lola number assigned yet — add one from Settings' });
    if(!conv.from_number) return res.status(400).json({ ok:false, error:'No phone number on file for this conversation' });

    const result = await sendSMS({
      from: tenant.phone_number,
      to: conv.from_number,
      text,
      tenantId: tenant.id,
      type: channel === 'whatsapp' ? 'WHATSAPP' : 'SMS'
    });

    if(result?.skipped){
      return res.status(200).json({ ok:false, error:'This client has opted out of texts' });
    }
    if(result?.errors?.length){
      return res.status(502).json({ ok:false, error: result.errors[0]?.detail || 'Telnyx could not send this message' });
    }

    await logMessage({ conversationId, tenantId: tenant.id, role:'assistant', agent:'owner', content:text });
    await client.from('conversations').update({ last_message:text, unread:false }).eq('id', conversationId);

    return res.status(200).json({ ok:true });
  }catch(error){
    return res.status(500).json({ ok:false, error:String(error?.message||error) });
  }
}
