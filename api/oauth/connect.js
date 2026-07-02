import { getConnector } from '../lib/aggregator.js';

export default async function handler(req, res){
  try{
    const url = new URL(req.url, `https://${req.headers.host}`);
    const provider = url.searchParams.get('provider');
    const tenant = url.searchParams.get('tenant') || 'demo';
    const shop = url.searchParams.get('shop') || undefined;
    // Mindbody scopes every API call to a studio via SiteId — capture it at
    // connect time (?siteId=) so the callback can persist it in metadata.
    const siteId = url.searchParams.get('siteId') || undefined;
    if(!provider) return res.status(400).json({ ok:false, error:'provider required' });
    const connector = getConnector(provider);
    const state = Buffer.from(JSON.stringify({ tenant, provider, siteId, t: Date.now() })).toString('base64url');
    const authUrl = provider === 'shopify' ? connector.getAuthUrl(state, { shop }) : connector.getAuthUrl(state);
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }catch(e){ return res.status(500).json({ ok:false, error:String(e) }); }
}
