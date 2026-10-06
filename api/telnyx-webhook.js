// POST /api/telnyx-webhook — Telnyx Call Control + messaging events (one URL for both).
// Verifies the Ed25519 signature, then routes on event_type:
//   call.initiated (incoming)  → answered by LolaBrain (numbers on a Call Control app use this path)
//   call.* lifecycle           → the call's ONE calls row (shared with agent-variables + insights)
//   message.received           → the live texting pipeline (/api/telnyx-sms): Lola answers it
// It used to save inbound texts and never answer them (a TODO), insert a second calls row per
// call, and refuse every event with 401 whenever TELNYX_PUBLIC_KEY was unset (even in preview).
import { verifyTelnyxSig, answerCallWithAssistant, tenantForNumber } from './lib/telnyx.js';
import { readRawBody } from './lib/telnyx-webhook-verify.js';
import { upsertCallRow } from './lib/call-row.js';
import { db } from './lib/db.js';

// Signatures cover the exact bytes: read them raw.
export const config = { api: { bodyParser: false } };

/** A res-shaped collector so the texting pipeline can run inside this request. */
function collector() {
  const out = { statusCode: 200, body: null, headers: {} };
  out.setHeader = (k, v) => { out.headers[k] = v; return out; };
  out.status = (c) => { out.statusCode = c; return out; };
  out.json = (o) => { out.body = o; return out; };
  out.send = (o) => { out.body = o; return out; };
  out.end = () => out;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const raw = await readRawBody(req);
  if (!verifyTelnyxSig(req.headers || {}, raw)) {
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
        if (p.direction && p.direction !== 'incoming') break;   // calls LolaDesk dials are driven by their own flows
        const tenant = c ? await tenantForNumber(c, p.to) : null;
        if (!tenant) break;
        // ONE brain: LolaBrain answers every salon (the salon is known from the number called).
        // A salon's old per-salon assistant is only a fallback if LolaBrain can't be found.
        let aid = null;
        try { const { resolveAssistant } = await import('./lib/assistant-wiring.js'); aid = (await resolveAssistant()).id || null; } catch (_) {}
        if (!aid) aid = tenant.telnyx_assistant_id || null;
        if (!aid) break;
        await answerCallWithAssistant(p.call_control_id, aid, { commandId: payload?.data?.id || null });
        // The same row agent-variables / insights update (never a second row for one call).
        await upsertCallRow(c, { tenantId: tenant.id, callControlId: p.call_control_id || null, callSessionId: p.call_session_id || null,
          patch: { status: 'in_progress' },
          insert: { from_number: p.from || null, to_number: p.to || null, direction: 'inbound' } });
        break;
      }
      case 'call.answered': {
        if (c && p.call_control_id) await c.from('calls').update({ status: 'in_progress' }).eq('telnyx_call_control_id', p.call_control_id).then((r) => r, () => null);
        break;
      }
      case 'call.hangup':
      case 'call.conversation.ended':           // Telnyx's documented event name
      case 'ai_assistant.conversation_ended': {
        // The transcript + summary land through the insights webhook (call.conversation_insights.generated);
        // here the call is simply closed. (transcript/outcome are generated columns — never written.)
        // A row already closed with a real outcome (booked…) is left as it is.
        if (c && p.call_control_id) {
          await c.from('calls').update({ status: 'completed' }).eq('telnyx_call_control_id', p.call_control_id)
            .in('status', ['ringing', 'in_progress', 'processing', 'dialing', 'connected']).then((r) => r, () => null);
        }
        break;
      }

      // ── SMS EVENTS ─────────────────────────────────────────
      case 'message.received': {
        // One texting pipeline: the same code /api/telnyx-sms runs (routing, STOP/HELP, owner relay,
        // Lola's reply with her booking tools, dedupe of Telnyx retries). The signature is already verified.
        const { handleVerifiedText } = await import('./telnyx-sms.js');
        const out = collector();
        await handleVerifiedText(payload, out);
        return res.status(200).json({ ok: true, forwarded: 'telnyx-sms', result: out.body });
      }
      case 'message.sent':
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
