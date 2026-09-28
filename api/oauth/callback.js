import { getConnector } from '../lib/aggregator.js';
import { db, upsertIntegration } from '../lib/db.js';
import { openState } from '../lib/oauth-state.js';

export default async function handler(req, res){
  try{
    const url = new URL(req.url, `https://${req.headers.host}`);
    const provider = url.searchParams.get('provider');
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const shop = url.searchParams.get('shop') || undefined;
    const error = url.searchParams.get('error');
    if(error){ res.writeHead(302, { Location: `/settings.html?connect=error&provider=${provider}` }); return res.end(); }
    if(!provider || !code){ res.writeHead(302, { Location: `/settings.html?connect=error&reason=missing_params` }); return res.end(); }
    // Only a state sealed by /api/oauth/connect for a signed-in owner counts.
    const state = openState(stateRaw);
    if(!state){
      res.writeHead(302, { Location: `/settings.html?connect=error&provider=${encodeURIComponent(provider)}&reason=expired_or_invalid` }); return res.end();
    }
    const connector = getConnector(provider);
    const tokens = provider === 'shopify' ? await connector.exchangeCode(code, { shop }) : await connector.exchangeCode(code);
    const { data: tenant } = await db().from('tenants').select('id,slug').eq('id', state.tid).maybeSingle();
    if(tenant?.id){
      // Tokens are encrypted at rest inside upsertIntegration — never
      // write access_token/refresh_token to the DB any other way.
      await upsertIntegration(tenant.id, {
        provider,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_at || null,
        metadata: { shop: tokens.shop || shop || null, merchant_id: tokens.merchant_id || null, site_id: state.siteId || null }
      });
    }
    res.writeHead(302, { Location: `/settings.html?connect=success&provider=${provider}` });
    return res.end();
  }catch(e){ res.writeHead(302, { Location: `/settings.html?connect=error&reason=${encodeURIComponent(String(e).slice(0,120))}` }); return res.end(); }
}
