/**
 * api/telnyx-book-tool.js — Webhook Tool for Telnyx's native AI Assistant
 * ════════════════════════════════════════════════════════════════
 * Configure this as a "Webhook Tool" on your Telnyx AI Assistant
 * (Mission Control -> AI -> Assistants -> your assistant -> Webhook Tools):
 *
 *   URL:     https://www.loladesk.com/api/telnyx-book-tool
 *   Method:  POST
 *   Headers: x-lola-booking-secret = <your BOOKING_TOOL_SECRET value>
 *   Body parameters (the assistant fills these in from the conversation):
 *     tenant_id    - reference the {{tenant_id}} dynamic variable
 *                    (already returned by /api/agent-variables - do NOT
 *                    let the caller/model supply this themselves)
 *     service      - the service name the caller asked to book
 *     stylist      - optional, the stylist/team member if requested
 *     starts_at    - ISO 8601 datetime the appointment should start
 *                    (instruct the assistant to always resolve relative
 *                    phrases like "tomorrow at 3pm" to a real ISO
 *                    timestamp before calling this tool)
 *     duration_min - optional, defaults to 60
 *     client_name  - the caller's name
 *
 * This reuses createBookingSafe() - the exact same function every other
 * booking path in LolaDesk uses (dashboard, SMS, calendar UI) - so a
 * voice booking automatically gets real conflict detection, sync to any
 * connected external platform (Square/Boulevard/etc.), and a real
 * confirmation text, with zero extra work.
 *
 * ENV VARS: BOOKING_TOOL_SECRET
 */
import { db, getClientByPhone, upsertClient } from './lib/db.js';
import { getTenantById } from './lib/operator-db.js';
import { createBookingSafe } from './lib/calendar-engine.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-lola-booking-secret');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ speak: 'Method not allowed' });

  // Shared-secret gate - same pattern as operator-tools.js. Telnyx lets
  // you set custom headers on a Webhook Tool in Mission Control; this is
  // NOT the same signature scheme used for call/message event webhooks.
  const provided = req.headers['x-lola-booking-secret'];
  const expected = process.env.BOOKING_TOOL_SECRET;
  if(!expected || !provided || provided !== expected){
    return res.status(401).json({ speak: "I'm not able to book that from here right now." });
  }

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { tenant_id, service, stylist, starts_at, duration_min, client_name, client_phone } = body;

    if(!tenant_id) return res.status(400).json({ speak: "I couldn't tell which salon this call belongs to." });
    if(!service) return res.status(400).json({ speak: 'What service would you like to book?' });
    if(!starts_at) return res.status(400).json({ speak: 'What day and time works for you?' });

    const startDate = new Date(starts_at);
    if(isNaN(startDate.getTime())){
      return res.status(400).json({ speak: "I didn't catch a clear date and time for that." });
    }
    if(startDate < new Date()){
      return res.status(400).json({ speak: "That time's already passed - could you give me another day or time?" });
    }

    const tenant = await getTenantById(tenant_id);
    if(!tenant) return res.status(404).json({ speak: "I couldn't find this salon's account." });

    const client = db();
    if(!client) return res.status(503).json({ speak: 'Booking system is unavailable right now.' });

    // Identify/create the client record so the confirmation text and
    // future caller-recognition (agent-variables.js) both work.
    const phone = client_phone || req.body?.from_number || '';
    let clientRow = null;
    if(phone){
      clientRow = await getClientByPhone(tenant.id, phone) || await upsertClient(tenant.id, { phone, name: client_name });
    }

    const result = await createBookingSafe({
      tenant,
      clientId: clientRow?.id || null,
      service,
      stylist: stylist || null,
      startsAt: startDate.toISOString(),
      durationMin: Number(duration_min) || 60,
      price: null
    });

    if(!result.ok){
      if(result.conflict){
        return res.status(200).json({ speak: `That time isn't available - could you give me another time?` });
      }
      return res.status(200).json({ speak: "I wasn't able to lock that in - let's try a different time." });
    }

    const when = startDate.toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' });
    return res.status(200).json({
      speak: `You're all set for ${service}${stylist ? ' with '+stylist : ''} on ${when}. I'll text you a confirmation.`,
      booking_id: result.booking?.id || null
    });
  }catch(e){
    return res.status(200).json({ speak: "Something went wrong on my end - let's try that again in a moment.", _error: String(e?.message||e) });
  }
}
