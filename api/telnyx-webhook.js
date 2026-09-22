// POST /api/telnyx-webhook — receives every Telnyx event for calls and SMS.
// Verifies the Ed25519 signature, then routes based on event_type.
// This is the SKELETON: individual event branches are stubs that log and
// return 200. Fill them in as your flows go live.
import { verifyTelnyxSig, sendSMS, answerCallWithAssistant, tenantForNumber } from './lib/telnyx.js';
import { db } from './lib/db.js';

// Vercel gives us raw body via req.body when the content-type is JSON,
// but for signature verification we need the RAW payload string. Force
// this handler to accept raw body via config.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const raw = await readRawBody(req);
  // Signature check
  if (!verifyTelnyxSig(req.headers, raw)) {
    return res.status(401).json({ ok: false, error: 'invalid_signature' });
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, error: 'bad_json' }); }

  const event = payload?.data?.event_type;
  const p = payload?.data?.payload || {};
  const c = db();

  try {
    switch (event) {
      // ── CALL EVENTS ────────────────────────────────────────
      case 'call.initiated': {
        // Inbound call. Resolve tenant by the "to" (their Lola number)
        // and answer the call with their Telnyx AI Assistant.
        const to = p.to;
        const tenant = await tenantForNumber(c, to);
        if (!tenant || !tenant.telnyx_assistant_id) break;
        await answerCallWithAssistant(p.call_control_id, tenant.telnyx_assistant_id);
        await c.from('calls').insert({
          tenant_id: tenant.id,
          call_control_id: p.call_control_id,
          from: p.from,
          to: p.to,
          direction: 'in',
          status: 'active',
          started_at: new Date().toISOString()
        });
        break;
      }
      case 'call.answered': {
        await c.from('calls').update({ status: 'active', started_at: new Date().toISOString() })
          .eq('call_control_id', p.call_control_id);
        break;
      }
      case 'call.hangup': {
        await c.from('calls').update({
          status: 'ended',
          ended_at: new Date().toISOString(),
          duration_sec: p.hangup_source === 'callee' ? null : null
        }).eq('call_control_id', p.call_control_id);
        break;
      }
      case 'ai_assistant.conversation_ended': {
        // Persist transcript + outcome.
        await c.from('calls').update({
          transcript: p.transcript || [],
          summary: p.summary || null,
          outcome: p.outcome || 'handled'
        }).eq('call_control_id', p.call_control_id);
        break;
      }

      // ── SMS EVENTS ─────────────────────────────────────────
      case 'message.received': {
        const to = p.to?.[0]?.phone_number || p.to;
        const tenant = await tenantForNumber(c, to);
        if (!tenant) break;
        const from = p.from?.phone_number || p.from;
        // Look up or create the client
        let { data: client } = await c.from('clients').select('id').eq('tenant_id', tenant.id).eq('phone', from).maybeSingle();
        if (!client) {
          const inserted = await c.from('clients').insert({ tenant_id: tenant.id, phone: from }).select().single();
          client = inserted.data;
        }
        // Find or create thread
        let { data: thread } = await c.from('inbox_threads').select('id, autopilot').eq('tenant_id', tenant.id).eq('client_phone', from).maybeSingle();
        if (!thread) {
          const inserted = await c.from('inbox_threads').insert({
            tenant_id: tenant.id, client_id: client?.id, client_phone: from,
            channel: 'sms', unread: true, autopilot: true
          }).select().single();
          thread = inserted.data;
        }
        // Persist the inbound message
        await c.from('inbox_messages').insert({
          thread_id: thread.id, tenant_id: tenant.id,
          direction: 'in', text: p.text, created_at: new Date().toISOString()
        });
        await c.from('inbox_threads').update({ unread: true, preview: p.text, when: new Date().toISOString() }).eq('id', thread.id);

        // If autopilot is on, hand to Lola. Otherwise the owner will reply
        // manually from inbox.html.
        if (thread.autopilot) {
          // TODO: build the AI reply (Kimi via Telnyx AI Inference or Claude),
          // then sendSMS() the reply back. Left as a hook so this webhook
          // ships safely — the reply pipeline is its own module.
        }
        break;
      }
      case 'message.finalized': {
        // Outbound status update from Telnyx (delivered/failed).
        break;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Never fail-noisy back to Telnyx or they'll disable the webhook.
    console.error('telnyx-webhook error', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
