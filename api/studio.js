/**
 * POST /api/studio — MMA Studio (website try-on boutique) → LolaDesk.
 *
 * body: { salon: '+1305…' (the salon's Lola line), event: 'lead'|'order'|'booking',
 *         name, phone, look: { method, shade, code, inches, fullness, balayage, match },
 *         install: { startsAt, artist, label } }
 *
 * lead    → client saved, thread in the Lola inbox, owner texted (8am–9pm; at night it waits in the inbox)
 * order   → same + a $500 Stripe Checkout on the salon's connected account → { checkoutUrl }
 *           (the "paid" text to the owner comes from the Stripe webhook)
 * booking → install booked (2 hours) + owner texted
 */
import { cors, jsonBody } from './lib/cors.js';
import { getTenantByPhoneStrict } from './lib/db.js';
import { parseStudio, ownerText } from './lib/studio.js';
import { recordStudio, textOwner, leadAlertedRecently, createDepositCheckout, bookInstall, saveStudioPhotos, textClient } from './lib/studio-server.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };   // the order carries the color reference photos

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const p = parseStudio(jsonBody(req));
  if (!p.ok) return res.status(400).json({ ok: false, error: p.error });
  const v = p.value;
  const tenant = await getTenantByPhoneStrict(v.salon || process.env.STUDIO_DEFAULT_SALON || '').catch(() => null);
  if (!tenant?.id) return res.status(404).json({ ok: false, error: 'unknown_salon' });
  try {
    // The color reference (order card, her photo, the try-on) is saved first, so every message carries it.
    const ref = v.event === 'order' ? await saveStudioPhotos(tenant, v).catch((e) => { console.error('[studio] photos', e.message); return { paths: {}, urls: {}, links: '' }; })
      : { paths: {}, urls: {}, links: '' };
    const { client, conv } = await recordStudio(tenant, v, { links: ref.links, paths: ref.paths });
    if (v.event === 'lead') {
      const repeat = await leadAlertedRecently(tenant, v.phone);
      const sms = repeat ? { texted: false, reason: 'recently_alerted' } : await textOwner(tenant, ownerText(v), { quietHours: true });
      if (!repeat) await textClient(tenant, v, 'welcome');                 // she hears from Lola within seconds
      return res.status(200).json({ ok: true, texted: sms.texted });
    }
    if (v.event === 'order') {
      let checkout = { url: null, reason: 'payments_not_connected' };
      try { checkout = await createDepositCheckout(tenant, v, { clientId: client?.id, conversationId: conv?.id, cardPath: ref.paths.card }); }
      catch (e) { console.error('[studio] checkout', e.message); checkout = { url: null, reason: 'checkout_failed' }; }
      const media = ref.urls.card ? [ref.urls.card] : null;   // the order card arrives as a picture text
      await textOwner(tenant, ownerText(v, { links: ref.links }), { mediaUrls: media });
      return res.status(200).json({ ok: true, checkoutUrl: checkout.url, reason: checkout.reason || null });
    }
    const booking = await bookInstall(tenant, v, { clientId: client?.id, conversationId: conv?.id }).catch((e) => { console.error('[studio] booking', e.message); return null; });
    await textOwner(tenant, ownerText(v));
    return res.status(200).json({ ok: true, bookingId: booking?.id || null });
  } catch (e) {
    console.error('[studio]', e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
