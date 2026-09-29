import { getConnector } from '../lib/aggregator.js';
import { authenticatedTenant } from '../lib/tenant-context.js';
import { sealState } from '../lib/oauth-state.js';

// GET /api/oauth/connect?provider=…&format=json   (Authorization: Bearer …)
// → { ok, url } — the page then navigates to the provider. Only the signed-in
// owner can start a connection, and only for their own salon.
export default async function handler(req, res){
  try{
    const url = new URL(req.url, `https://${req.headers.host}`);
    const provider = url.searchParams.get('provider');
    const shop = url.searchParams.get('shop') || undefined;
    // Mindbody scopes every API call to a studio via SiteId — capture it at
    // connect time (?siteId=) so the callback can persist it in metadata.
    const siteId = url.searchParams.get('siteId') || undefined;
    const wantsJson = url.searchParams.get('format') === 'json';
    if(!provider) return res.status(400).json({ ok:false, error:'provider required' });

    const tenant = await authenticatedTenant(req);
    if(!tenant?.id){
      if(wantsJson) return res.status(401).json({ ok:false, error:'sign_in_required' });
      res.writeHead(302, { Location: `/settings.html?connect=error&provider=${encodeURIComponent(provider)}&reason=sign_in_required` });
      return res.end();
    }
    const connector = getConnector(provider);
    const state = sealState({ tid: tenant.id, provider, siteId });
    const authUrl = provider === 'shopify' ? connector.getAuthUrl(state, { shop }) : connector.getAuthUrl(state);
    if(wantsJson) return res.status(200).json({ ok:true, url: authUrl });
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }catch(e){ return res.status(500).json({ ok:false, error:String(e?.message || e) }); }
}
