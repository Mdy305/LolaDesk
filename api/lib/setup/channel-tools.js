/**
 * api/lib/setup/channel-tools.js — Lola connects the salon's channels by talking.
 * Instagram DMs, Facebook Messenger and WhatsApp: same Lola, same memory, same
 * booking hands on every one. Contract: SETUP_TOOLS / SETUP_CONFIRM / runSetupTool
 * (never throws; plain words; no IDs or Meta/Telnyx jargon for the salon).
 */
import { db } from '../db.js';

export const SETUP_TOOLS = [
  { type: 'function', function: { name: 'channels_status', description: 'Which messaging channels Lola answers for this salon right now: Instagram DMs, Facebook Messenger and WhatsApp.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'connect_instagram', description: 'Start connecting the salon’s Instagram (Business or Creator account) so Lola answers its DMs. Opens Instagram’s sign-in.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'connect_facebook', description: 'Start connecting the salon’s Facebook Page so Lola answers Facebook Messenger. Opens Facebook’s sign-in.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'choose_facebook_page', description: 'After Facebook sign-in, when the owner manages several Facebook Pages: connect the one they pick (by name).', parameters: { type: 'object', properties: { page_name: { type: 'string', description: 'The Page name the owner said' }, page_id: { type: 'string', description: 'Page id when the app passes one' } }, required: [] } } },
  { type: 'function', function: { name: 'disconnect_channel', description: 'Stop Lola answering on Instagram, Facebook Messenger or WhatsApp. Ask the owner to confirm first.', parameters: { type: 'object', properties: { channel: { type: 'string', enum: ['instagram', 'facebook', 'messenger', 'whatsapp'] }, confirmed: { type: 'boolean', description: 'true only after the owner clearly said yes' } }, required: ['channel'] } } },
  { type: 'function', function: { name: 'whatsapp_status', description: 'Is WhatsApp on for the salon’s number, and do reminders go out on WhatsApp?', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'turn_on_whatsapp', description: 'Turn on WhatsApp for the salon’s Lola number (finishes right away when it’s already approved; otherwise asks the LolaDesk team to complete Meta’s step).', parameters: { type: 'object', properties: {}, required: [] } } },
];
export const SETUP_CONFIRM = new Set(['disconnect_channel']);

const NAMES = { instagram: 'Instagram', messenger: 'Facebook Messenger', whatsapp: 'WhatsApp' };

async function statusAll(c, tenant) {
  const ig = await import('../instagram-dm.js');
  const fb = await import('../messenger-dm.js');
  const wa = await import('../whatsapp-setup.js');
  const igRow = await ig.channelFor(c, tenant.id);
  const fbRow = await fb.channelFor(c, tenant.id);
  const pages = await fb.pendingPages(c, tenant.id);
  const w = await wa.whatsappStatus(c, tenant);
  const instagram = igRow && igRow.status === 'active'
    ? { on: true, say: `Instagram is connected${igRow.username ? ' (@' + igRow.username + ')' : ''} — Lola answers your DMs.` }
    : { on: false, available: ig.igConfigured(), say: ig.igConfigured() ? 'Instagram isn’t connected yet.' : 'Instagram is coming soon — LolaDesk is finishing Meta’s approval.' };
  const messenger = fbRow && fbRow.status === 'active'
    ? { on: true, page: fbRow.username || null, say: `Facebook Messenger is connected for ${fbRow.username || 'your Page'} — Lola answers your messages.` }
    : fbRow && fbRow.status === 'needs_reconnect'
      ? { on: false, needs_reconnect: true, say: 'Facebook Messenger needs you to sign in to Facebook again — say “connect Facebook”.' }
      : pages.length
        ? { on: false, choose: pages.map((p) => ({ id: p.id, name: p.name })), say: 'Pick which Facebook Page is your salon: ' + pages.map((p) => p.name).join(', ') + '.' }
        : { on: false, available: fb.fbConfigured(), say: fb.fbConfigured() ? 'Facebook Messenger isn’t connected yet.' : 'Facebook Messenger is coming soon — LolaDesk is finishing Meta’s approval.' };
  const whatsapp = { on: !!w.on, state: w.state, say: w.say };
  return { instagram, messenger, whatsapp };
}
export { statusAll as channelsStatus };

export async function runSetupTool({ tenant, name, args = {}, req = null } = {}) {
  try {
    const c = db();
    if (!c || !tenant || !tenant.id) return { ok: false, say: 'I can’t reach your salon’s settings right now — try again in a moment.' };
    args = args || {};
    switch (name) {
      case 'channels_status': {
        const s = await statusAll(c, tenant);
        return { ok: true, say: [s.instagram.say, s.messenger.say, s.whatsapp.say].join(' '), data: s, suggestions: [!s.instagram.on && 'Connect Instagram', !s.messenger.on && 'Connect Facebook', !s.whatsapp.on && 'Turn on WhatsApp'].filter(Boolean) };
      }
      case 'connect_instagram': {
        const ig = await import('../instagram-dm.js');
        if (!ig.igConfigured()) return { ok: false, say: 'Instagram is coming soon — LolaDesk is finishing Meta’s approval. I’ll let you know when it’s ready.' };
        return { ok: true, say: 'Opening Instagram — sign in with your salon’s Business or Creator account and tap Allow. I’ll take it from there.', ui: { open: 'oauth', provider: 'instagram', url: ig.authUrl(tenant.id) } };
      }
      case 'connect_facebook': {
        const fb = await import('../messenger-dm.js');
        if (!fb.fbConfigured()) return { ok: false, say: 'Facebook Messenger is coming soon — LolaDesk is finishing Meta’s approval. I’ll let you know when it’s ready.' };
        return { ok: true, say: 'Opening Facebook — sign in, pick your salon’s Page and tap Allow. I’ll answer your Messenger from then on.', ui: { open: 'oauth', provider: 'facebook', url: fb.authUrl(tenant.id) } };
      }
      case 'choose_facebook_page': {
        const fb = await import('../messenger-dm.js');
        const pages = await fb.pendingPages(c, tenant.id);
        if (!args.page_id && !args.page_name) {
          if (!pages.length) return { ok: false, say: 'There’s no Facebook sign-in waiting. Say “connect Facebook” and I’ll open it.' };
          return { ok: true, say: 'Which Page is your salon: ' + pages.map((p) => p.name).join(', ') + '?', data: { pages: pages.map((p) => ({ id: p.id, name: p.name })) }, suggestions: pages.map((p) => p.name).slice(0, 4) };
        }
        const r = await fb.choosePage(c, tenant.id, { pageId: args.page_id || null, pageName: args.page_name || null });
        return { ok: !!r.ok, say: r.say, ...(r.ok ? {} : { suggestions: (r.pages || []).map((p) => p.name).slice(0, 4) }) };
      }
      case 'disconnect_channel': {
        const ch = String(args.channel || '').toLowerCase() === 'facebook' ? 'messenger' : String(args.channel || '').toLowerCase();
        if (!NAMES[ch]) return { ok: false, say: 'Which one should I disconnect — Instagram, Facebook Messenger or WhatsApp?' };
        if (args.confirmed !== true) {
          const what = ch === 'whatsapp' ? 'Reminders and confirmations will go by text instead of WhatsApp.' : `I’ll stop answering your ${NAMES[ch]} messages.`;
          return { ok: true, needs_confirmation: true, say: `Disconnect ${NAMES[ch]}? ${what} Say yes to confirm.` };
        }
        if (ch === 'instagram') { const ig = await import('../instagram-dm.js'); await ig.disconnect(c, tenant.id); }
        else if (ch === 'messenger') { const fb = await import('../messenger-dm.js'); await fb.disconnect(c, tenant.id); }
        else { const wa = await import('../whatsapp-setup.js'); await wa.disconnectWhatsApp(c, tenant.id); }
        return { ok: true, say: `${NAMES[ch]} is disconnected.` + (ch === 'whatsapp' ? ' Reminders go by text from now on.' : ` I no longer answer your ${NAMES[ch]} messages.`) };
      }
      case 'whatsapp_status': {
        const wa = await import('../whatsapp-setup.js');
        const s = await wa.whatsappStatus(c, tenant);
        return { ok: true, say: s.say, data: { on: s.on, state: s.state, reminders_on_whatsapp: !!s.reminders_on_whatsapp }, ...(s.on ? {} : { suggestions: s.state === 'off' ? ['Turn on WhatsApp'] : [] }) };
      }
      case 'turn_on_whatsapp': {
        const wa = await import('../whatsapp-setup.js');
        const r = await wa.requestWhatsApp(c, tenant);
        return { ok: !!r.ok, say: r.say, data: { state: r.state } };
      }
      default:
        return { ok: false, say: 'I can’t do that one yet.' };
    }
  } catch (e) {
    console.warn('[channel-tools]', name, String(e?.message || e).slice(0, 160));
    return { ok: false, say: 'Something got in the way just now — try again in a moment, or open Settings → Lola on Instagram / Facebook.' };
  }
}
