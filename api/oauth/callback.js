import { getConnector } from '../lib/aggregator.js';
import { getTenantBySlug, upsertIntegration } from '../lib/db.js';

export default async function handler(req, res){
  try{
    const url = new URL(req.url, `https://${req.headers.host}`);
    const provider = url.searchParams.get('provider');
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const shop = url.searchParams.get('shop') || undefined;
    const error = url.searchParams.get('error');
    if(error){ res.writeHead(302, { Location: `/settings?connect=error&provider=${provider}` }); return res.end(); }
    if(!provider || !code){ res.writeHead(302, { Location: `/settings?connect=error&reason=missing_params` }); return res.end(); }
    let state = {};
    try{ state = JSON.parse(Buffer.from(stateRaw||'', 'base64url').toString('utf8')); }catch{}
    const tenantSlug = state.tenant || 'demo';
    const connector = getConnector(provider);
    const tokens = provider === 'shopify' ? await connector.exchangeCode(code, { shop }) : await connector.exchangeCode(code);
    const tenant = await getTenantBySlug(tenantSlug);
    if(tenant?.id){
      // Tokens are encrypted at rest inside upsertIntegration — never
      // write access_token/refresh_token to the DB any other way.
      await upsertIntegration(tenant.id, {
        provider,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_at || null,
        metadata: { shop: tokens.shop || shop || null, merchant_id: tokens.merchant_id || null }
      });
    }
    res.writeHead(302, { Location: `/settings?connect=success&provider=${provider}` });
    return res.end();
  }catch(e){ res.writeHead(302, { Location: `/settings?connect=error&reason=${encodeURIComponent(String(e).slice(0,120))}` }); return res.end(); }
}
