/**
 * /api/widget-embed — the owner's copy-paste snippet for their site
 * ════════════════════════════════════════════════════════════════
 * Bearer-authed (same session as the dashboard). Returns the slug,
 * the per-tenant HMAC widget key, and a ready-to-paste snippet used
 * by the onboarding go-live screen and Settings. The key is derived,
 * not stored — rotating WIDGET_EMBED_SECRET rotates every key.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { widgetKeyFor } from './widget-chat.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ ok:false });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  const tenant = await resolveTenantForUser(user);
  if(!tenant?.id) return res.status(403).json({ ok:false, error:'No salon linked to this account' });

  const app = (process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/,'');
  const key = widgetKeyFor(tenant.slug);
  const snippet = `<script src="${app}/widget.js" data-lola="${tenant.slug}" data-key="${key}" async></script>`;
  return res.status(200).json({ ok:true, slug: tenant.slug, key, snippet });
}
