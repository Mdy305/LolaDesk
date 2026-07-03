/**
 * /api/webhooks/whatsapp — Telnyx WhatsApp webhook
 * ════════════════════════════════════════════════════════════════
 * Thin alias onto the real multi-tenant messaging handler.
 *
 * The full WhatsApp pipeline already lives in /api/telnyx-sms.js:
 * it detects payload.type === 'WHATSAPP', resolves the tenant by the
 * called number, runs the STOP/HELP/START compliance gate and opt-out
 * check, loads client memory, asks Lola's real brain (lib/llm.js with
 * her per-tenant persona), persists the conversation, logs
 * whatsapp_received / whatsapp_sent usage events, and replies via
 * Telnyx's WhatsApp message shape — all identically to SMS.
 *
 * This file exists only so a Telnyx messaging profile can point its
 * WhatsApp webhook at /api/webhooks/whatsapp instead of
 * /api/telnyx-sms and get exactly the same behavior. One pipeline,
 * two URLs — never two implementations.
 *
 * (A previous version of this file returned a hardcoded mock reply
 * and billed a fake tenant id. If you're pointing Telnyx here, you
 * now get the real Lola.)
 */
export { default } from '../telnyx-sms.js';
