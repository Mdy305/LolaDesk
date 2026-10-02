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
import { db, logMessage, e164, upsertClient, getOrStartConversation } from './lib/db.js';
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
    let conversationId = input.conversation_id;
    const text = String(input.text||'').trim();
    if(!text) return res.status(400).json({ ok:false, error:'Type a message first' });
    if(text.length > 1500) return res.status(400).json({ ok:false, error:'Message is too long' });

    // A new message to someone with no thread yet ("New message" → a number):
    // find or create the client and their SMS conversation, then send.
    let conv = null;
    const isNew = !conversationId || /^new-/.test(String(conversationId));
    if(isNew){
      const to = e164(input.to || input.phone || '');
      if(!to || to.replace(/\D/g,'').length < 10) return res.status(400).json({ ok:false, error:'That doesn’t look like a phone number' });
      let cl = null;
      try{ const { data } = await client.from('clients').select('*').eq('tenant_id', tenant.id).eq('phone', to).maybeSingle(); cl = data; }catch{}
      if(!cl) cl = await upsertClient(tenant.id, { phone: to }).catch(()=>null);
      conv = await getOrStartConversation(tenant.id, { clientId: cl?.id || null, channel: 'sms', agent: 'lola' }).catch(()=>null);
      if(!conv?.id) return res.status(500).json({ ok:false, error:'Couldn’t start the conversation' });
      conversationId = conv.id;
      try{ await client.from('conversations').update({ from_number: to }).eq('id', conv.id); }catch{}
      conv = { ...conv, from_number: to, client_phone: cl?.phone || to };
    } else {
      // Verify the conversation actually belongs to this tenant — never
      // trust a client-supplied conversation_id blindly.
      const { data } = await client.from('conversations').select('*').eq('id', conversationId).eq('tenant_id', tenant.id).maybeSingle();
      conv = data;
      if(!conv) return res.status(404).json({ ok:false, error:'Conversation not found' });
    }

    const channel = String(conv.channel||'sms').toLowerCase();
    if(channel === 'instagram'){
      const { replyAsSalon } = await import('./lib/instagram-dm.js');
      const r = await replyAsSalon(client, tenant.id, conv.client_id, text);
      if(!r.ok) return res.status(400).json({ ok:false, error: r.error });
      await logMessage({ conversationId, tenantId: tenant.id, role:'assistant', agent:'owner', content:text });
      await client.from('conversations').update({ last_message:text, unread:false }).eq('id', conversationId);
      return res.status(200).json({ ok:true, conversation_id: conversationId });
    }
    if(!['sms','whatsapp'].includes(channel)){
      return res.status(400).json({ ok:false, error:`Replying from the dashboard isn't supported for ${channel} yet` });
    }
    // Who to text: the thread's number, else the client's phone on file.
    let to = conv.from_number || conv.client_phone || null;
    if(!to && conv.client_id){
      try{ const { data } = await client.from('clients').select('phone').eq('id', conv.client_id).eq('tenant_id', tenant.id).maybeSingle(); to = data?.phone || null; }catch{}
    }
    if(!to && input.to) to = e164(input.to);
    if(!to) return res.status(400).json({ ok:false, error:'No phone number on file for this conversation' });

    const result = await sendSMS({
      to,
      text,
      tenantId: tenant.id,
      type: channel === 'whatsapp' ? 'WHATSAPP' : 'SMS'
    });

    if(result?.skipped && result.reason === 'no_salon_number'){
      return res.status(400).json({ ok:false, error:'No Lola number assigned yet — add one in Salon → Phone & texting' });
    }
    if(result?.skipped){
      return res.status(200).json({ ok:false, error:'This client has opted out of texts' });
    }
    if(result?.errors?.length){
      return res.status(502).json({ ok:false, error: result.errors[0]?.detail || 'Telnyx could not send this message' });
    }

    await logMessage({ conversationId, tenantId: tenant.id, role:'assistant', agent:'owner', content:text });
    await client.from('conversations').update({ last_message:text, unread:false }).eq('id', conversationId);

    return res.status(200).json({ ok:true, conversation_id: conversationId });
  }catch(error){
    return res.status(500).json({ ok:false, error:String(error?.message||error) });
  }
}
