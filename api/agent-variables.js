/**
 * /api/agent-variables — Telnyx Dynamic Variables Webhook
 * ONE Lola assistant serves EVERY salon. Telnyx POSTs here before
 * speaking; we resolve which tenant owns the dialed number and return
 * that salon's real data from the database.
 */
import { getClientByPhone, getClientMemory, db } from './lib/db.js';
import { buildTenantVariables } from './lib/tenant-variables.js';
import { resolveInboundTenant } from './lib/tenant-resolver.js';
import { clientStory, welcomeBack } from './lib/client-brain.js';
import { discloseGreeting } from './lib/legal.js';
import { toolKeyOk } from './lib/tool-key.js';

// Her first words on this call: a returning client is welcomed by name with their last visit;
// everyone hears that the call may be recorded and that she's an AI.
export function greetingFor(salon, story){
  const hi = story && story.known ? welcomeBack(story, { salon, voice: true }) : '';
  return discloseGreeting(hi || `Thanks for calling ${salon || 'the salon'}! This is Lola. How can I help you today?`);
}

function pickToNumber(b){
  // Telnyx AI Assistant dynamic-variables payloads name the numbers
  // telnyx_agent_target (the salon line) and telnyx_end_user_target (the caller).
  return b?.data?.payload?.telnyx_agent_target || b?.telnyx_agent_target || b?.data?.payload?.to || b?.payload?.to || b?.to ||
    b?.data?.payload?.to_number || b?.telephony_data?.to || b?.call?.to ||
    (Array.isArray(b?.to) ? b.to[0]?.phone_number : null) || b?.To || '';
}
// A salon's website widget names its line in a custom header (X-LolaDesk-Salon). Telnyx passes call
// headers to this webhook; accept every shape it uses so web calls get the salon's real facts.
function pickWebSalon(b){
  const p = b?.data?.payload || b || {};
  const direct = p.loladesk_salon || p['x-loladesk-salon'] || p['X-LolaDesk-Salon'] || p.custom_headers?.['X-LolaDesk-Salon'] || p.custom_headers?.['x-loladesk-salon'];
  if(direct) return String(direct);
  const list = Array.isArray(p.custom_headers) ? p.custom_headers : Array.isArray(p.sip_headers) ? p.sip_headers : [];
  const h = list.find((x) => /x-loladesk-salon/i.test(String(x?.name || '')));
  return h ? String(h.value || '') : '';
}
function pickFromNumber(b){
  return b?.data?.payload?.telnyx_end_user_target || b?.telnyx_end_user_target || b?.data?.payload?.from || b?.payload?.from || b?.from ||
    b?.data?.payload?.from_number || b?.telephony_data?.from || b?.call?.from || b?.From || '';
}

function callerMemory(client){
  if(client && !client.name) client.name = [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
  if(!client || !client.name) return { caller_known:'false', caller_name:'', caller_brief:'' };
  const bits = [];
  if(client.last_service) bits.push('last came in for ' + client.last_service);
  if(client.preferred_stylist) bits.push('usually sees ' + client.preferred_stylist);
  if(client.last_visit){
    const days = Math.floor((Date.now() - new Date(client.last_visit).getTime()) / 86400000);
    if(days > 0 && days < 400) bits.push('last visit ~' + days + ' days ago');
  }
  if(client.is_vip) bits.push('is a VIP client');
  if(client.notes) bits.push('note: ' + client.notes);
  return {
    caller_known: 'true',
    caller_name: client.name,
    caller_brief: bits.length ? client.name + ' — ' + bits.join(', ') + '.' : client.name + ' is a returning client.',
    caller_vip: client.is_vip ? 'true' : 'false',
    caller_stylist: client.preferred_stylist || ''
  };
}

export default async function handler(req, res){
  // Server-to-server only (Telnyx): no browser CORS.
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const q = (()=>{ try{ return new URL(req.url,'http://x').searchParams; }catch{ return new URLSearchParams(); } })();
    const qTo = q.get('to');
    const isPhone = (v) => String(v || '').replace(/\D/g, '').length >= 8;
    let toNumber = qTo || pickToNumber(body);
    if(!isPhone(toNumber) && isPhone(pickWebSalon(body))) toNumber = pickWebSalon(body);
    const fromNumber = pickFromNumber(body);
    // Caller memory (name, last visit, notes) is private: only for LolaDesk's own signed request, and
    // only for a real caller line (a website visitor has no verified number).
    const signed = toolKeyOk(q.get('k') || req.query?.k, 'variables');
    const web = /web/i.test(String(body?.data?.payload?.telnyx_conversation_channel || body?.telnyx_conversation_channel || ''));
    const mayRemember = signed && !web && isPhone(fromNumber);
    // Unsigned = the assistant's wiring drifted (or predates signing): re-sign it in the background.
    if(!signed && process.env.TELNYX_API_KEY && Date.now() - (globalThis.__lolaVarsHealAt || 0) > 10 * 60e3){
      globalThis.__lolaVarsHealAt = Date.now();
      import('./lib/assistant-wiring.js').then((m) => m.wireAssistant({ heal: true })).catch(() => {});
    }

    // ── MULTI-TENANT ROUTING (the literal "before she speaks" gate) ──
    // Telnyx calls this webhook to fetch the AI assistant's system facts
    // BEFORE the first syllable. If the dialed number can't be resolved to
    // exactly one tenant, return NEUTRAL placeholders — never the demo
    // salon's name/services, never another tenant's data.
    const routing = await resolveInboundTenant({ to: toNumber, from: fromNumber });
    const tenant = routing.status === 'resolved' ? routing.tenant : null;

    // ── POST-CALL INSIGHTS CORRELATION + LIVE CALL ROW ──
    // The post-call insights webhook (call.conversation_insights.generated)
    // arrives with only call ids — no dialed number — so record this
    // conversation's call_control_id → tenant mapping, and the live calls row
    // the Lola Live panel streams. Telnyx waits at most ~3s for THIS answer,
    // so the bookkeeping runs AFTER the reply is sent (see the end).
    const bookkeeping = async () => { if(tenant?.id){
      const callControlId = body?.data?.payload?.call_control_id || body?.call_control_id || null;
      const callSessionId = body?.data?.payload?.call_session_id || body?.data?.call_session_id || body?.call_session_id || null;
      const callLegId = body?.data?.payload?.call_leg_id || body?.data?.call_leg_id || body?.call_leg_id || null;
      if(callControlId){
        const c2 = db();
        try{
          if(c2) await c2.from('call_sessions').upsert({
            call_control_id: callControlId,
            tenant_id: tenant.id,
            from_number: fromNumber || null,
            to_number: toNumber || null
          }, { onConflict: 'call_control_id' }).then((r) => r, () => null);
        }catch(e){ /* never block */ }
        // ONE row per call (the insights webhook and Call Control events update this same row).
        try{
          if(c2){
            const { upsertCallRow } = await import('./lib/call-row.js');
            const patch = { status: 'in_progress' };
            if(callLegId) patch.call_leg_id = callLegId;
            await upsertCallRow(c2, { tenantId: tenant.id, callControlId, callSessionId, patch,
              insert: { from_number: fromNumber || null, to_number: toNumber || null, direction: 'inbound', call_session_id: callSessionId || null, call_leg_id: callLegId || null } });
          }
        }catch(e){ /* never block */ }
      }
    } };
    // Reply first, then the bookkeeping (kept alive on Vercel with waitUntil).
    const replyThenBook = async (payload, extraWork = null) => {
      res.status(200).json(payload);
      const work = Promise.resolve().then(async () => { await bookkeeping(); if(extraWork) await extraWork(); }).catch(() => {});
      try{ const { afterResponse } = await import('./lib/booking-outbox.js'); afterResponse(work); }catch(_){}
      await work;
    };

    if(!tenant){
      return replyThenBook({
        dynamic_variables: {
          tenant_id: '',
          to: toNumber || '',
          from: fromNumber || '',
          company_name: 'our salon',
          business_type: 'salon',
          location: '', hours: '', services: '', staff: '', marketing_context: '',
          booking_url: '', knowledge: '',
          caller_known: 'false', caller_name: '', caller_brief: '',
          lola_greeting: greetingFor('', null)
        },
        routing: { status: routing.status, reason: routing.reason || null }
      });
    }

    // A forwarding test arriving (Lola's line called "from" itself or from the salon's number): mark it working (after the reply).
    const forwarded = async () => { try{ const { noteForwardedArrival } = await import('./lib/forwarding.js'); await noteForwardedArrival(db(), tenant, fromNumber, toNumber); }catch(_){} };
    // An expired / cancelled / unpaid salon: Lola tells callers the line is paused instead of taking requests.
    const gateP = (async () => { try{ const { serviceGate } = await import('./lib/paid-hooks.js'); return await serviceGate(tenant); }catch(_){ return { ok: true }; } })();

    let memory = { caller_known:'false', caller_name:'', caller_brief:'' };
    let story = null;
    try{
      if(tenant?.id && fromNumber && mayRemember){
        const [client, mem] = await Promise.all([getClientByPhone(tenant.id, fromNumber), getClientMemory(tenant.id, fromNumber).catch(() => [])]);
        try{ story = client ? await clientStory(db(), tenant, client) : null; }catch(_){}
        // Resolve the stylist's NAME from preferred_staff_id (the canonical
        // schema has no preferred_stylist text column).
        if(client?.preferred_staff_id){
          const c2 = db();
          const { data: st } = await c2.from('staff').select('name').eq('id', client.preferred_staff_id).maybeSingle();
          if(st?.name) client.preferred_stylist = st.name;
        }
        memory = callerMemory(client);
        if(story?.brief){ memory.caller_known = 'true'; memory.caller_brief = story.brief + '.'; }
        // ── LOLA REMEMBERS: fold the caller's LAST call memory (written by
        // the post-call insights pipeline, keyed 'last_call') into the brief
        // so the next call repeats what happened — "last call you booked a
        // balayage". Best-effort; a memory read failure never blocks the
        // 1s dynamic-variables response.
        const lastCall = mem.find(m => m.key === 'last_call');
        if(lastCall?.value){
          const v = typeof lastCall.value === 'string' ? JSON.parse(lastCall.value) : lastCall.value;
          const outcome = String(v?.outcome || '').trim();
          const summary = String(v?.summary || '').trim();
          // 'booked' marker only when the outcome doesn't already say it.
          const booked = (v?.booked && outcome.toLowerCase() !== 'booked') ? 'booked' : null;
          const tail = [booked, outcome, summary].filter(Boolean).join(' · ');
          if(tail){
            memory.caller_known = 'true';
            memory.caller_brief = (memory.caller_brief ? memory.caller_brief + ' ' : '') +
              'Last call: ' + tail + '.';
          }
        }
      }
    }catch(e){}

    // ONE source of truth: the same builder the dashboard orb uses, so the
    // phone path and the orb path can never disagree on Lola's facts.
    const dynamic_variables = await buildTenantVariables(tenant, {
      to: toNumber,
      from: fromNumber,
      memory
    });

    dynamic_variables.lola_greeting = greetingFor(tenant.name, story);
    const gate = await gateP;
    if(gate && gate.ok === false){
      const say = gate.say || `the salon's line is not taking requests right now — please text or call back later`;
      dynamic_variables.salon_paused = 'true';
      dynamic_variables.salon_paused_note = `IMPORTANT: ${tenant.name || 'This salon'} is not taking requests through Lola right now. Do not check availability, book, move or cancel anything, and do not take messages. Politely tell the caller: ${say}. Then end the call.`;
      dynamic_variables.lola_greeting = discloseGreeting(`Thanks for calling ${tenant.name || 'the salon'}! This is Lola — ${String(say).replace(/[.!\s]+$/, '')}.`);
    }
    return replyThenBook({ dynamic_variables }, forwarded);
  }catch(e){
    return res.status(200).json({
      dynamic_variables: {
        company_name: 'our salon',
        business_type: 'salon',
        services: '', staff: '', hours: '', booking_url: '', marketing_context: '',
        lola_greeting: greetingFor('', null)
      },
      _error: String(e)
    });
  }
}
