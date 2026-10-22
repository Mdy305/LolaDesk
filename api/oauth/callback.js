import { getConnector } from '../lib/aggregator.js';
import { db, upsertIntegration } from '../lib/db.js';
import { openState } from '../lib/oauth-state.js';

export async function finishSquare(saved, tokens){
  const sqc = getConnector('square');
  const integ = { ...saved, access_token: tokens.access_token, refresh_token: tokens.refresh_token || null };
  const [acct, st] = await Promise.all([sqc.describeAccount(integ).catch(() => ({})), sqc.tokenStatus(integ).catch(() => ({}))]);
  const metadata = { ...(saved.metadata || {}), ...Object.fromEntries(Object.entries(acct || {}).filter(([, v]) => v != null)),
    scopes: st?.scopes || null, missing_scopes: st?.missing || [], connected_at: new Date().toISOString() };
  await db().from('integrations').update({ metadata }).eq('id', saved.id);
  integ.metadata = metadata;
  const map = await sqc.autoMap(integ).catch(() => null);
  if(map) await db().from('integrations').update({ metadata: { ...metadata, mapped: { staff: map.staff?.mapped || 0, services: map.services?.mapped || 0, unmatched_staff: map.staff?.unmatched || [], unmatched_services: (map.services?.unmatched || []).slice(0, 20) } } }).eq('id', saved.id);
  try{ const { ensureJobs } = await import('../lib/calendar-outbox.js'); await ensureJobs(db(), saved.tenant_id); }catch(_){}
  // Their Square sales history starts flowing into LolaBrain now (the 15-minute cron finishes the rest).
  try{ const { importSquareSales } = await import('../lib/square-data.js'); await importSquareSales(db(), integ, { budgetMs: 8000 }); }catch(_){}
  return { metadata, map };
}

export default async function handler(req, res){
  try{
    const url = new URL(req.url, `https://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    // The provider is in the URL (older connections) or in the sealed state (Square: an exact redirect URL with no query).
    const provider = url.searchParams.get('provider') || openState(stateRaw)?.provider || null;
    const shop = url.searchParams.get('shop') || undefined;
    const error = url.searchParams.get('error');
    if(error){ res.writeHead(302, { Location: `/settings.html?connect=error&provider=${provider}` }); return res.end(); }
    if(!provider || !code){ res.writeHead(302, { Location: `/settings.html?connect=error&reason=missing_params` }); return res.end(); }
    // Only a state sealed by /api/oauth/connect for a signed-in owner counts.
    const state = openState(stateRaw);
    if(!state){
      res.writeHead(302, { Location: `/settings.html?connect=error&provider=${encodeURIComponent(provider)}&reason=expired_or_invalid` }); return res.end();
    }
    // The state names the provider it was sealed for: a code can't be replayed into another connection.
    if(state.provider && state.provider !== provider){
      res.writeHead(302, { Location: `/settings.html?connect=error&provider=${encodeURIComponent(provider)}&reason=expired_or_invalid` }); return res.end();
    }
    const connector = getConnector(provider);
    const tokens = provider === 'shopify' ? await connector.exchangeCode(code, { shop }) : await connector.exchangeCode(code);
    const { data: tenant } = await db().from('tenants').select('id,slug').eq('id', state.tid).maybeSingle();
    if(tenant?.id){
      // Tokens are encrypted at rest inside upsertIntegration — never
      // write access_token/refresh_token to the DB any other way.
      const saved = await upsertIntegration(tenant.id, {
        provider,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_at || null,
        metadata: { shop: tokens.shop || shop || null, merchant_id: tokens.merchant_id || null, site_id: state.siteId || null }
      });
      if(provider === 'square' && saved?.id){
        // Square: remember the location, time zone and what the salon allowed; match stylists + services by name.
        try{ await finishSquare(saved, tokens); }catch(_){ /* connected either way — the daily check finishes it */ }
      }
    }
    res.writeHead(302, { Location: `/settings.html?connect=success&provider=${provider}` });
    return res.end();
  }catch(e){ res.writeHead(302, { Location: `/settings.html?connect=error&reason=${encodeURIComponent(String(e).slice(0,120))}` }); return res.end(); }
}
