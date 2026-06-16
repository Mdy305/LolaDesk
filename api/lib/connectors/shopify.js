export const META = { name:'Shopify', description:'Retail product orders for salons that sell products.', status:process.env.SHOPIFY_API_KEY?'available':'needs_credentials', docs:'https://shopify.dev/docs/api' };
const SCOPES = 'read_orders,read_products,read_customers';
export function getAuthUrl(state, { shop } = {}){
  if(!shop) throw new Error('Shopify requires shop domain');
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=shopify`;
  const params = new URLSearchParams({ client_id:process.env.SHOPIFY_API_KEY, scope:SCOPES, redirect_uri:redirect, state });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}
export async function exchangeCode(code, { shop } = {}){
  if(!shop) throw new Error('Shopify exchange requires shop domain');
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client_id:process.env.SHOPIFY_API_KEY, client_secret:process.env.SHOPIFY_API_SECRET, code }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Shopify OAuth failed');
  return { access_token:data.access_token, shop, scope:data.scope, raw:data };
}
export async function refreshToken(){ return null; }
export async function listAppointments(integration, { from } = {}){
  if(!integration.access_token || !integration.shop) return [];
  const since = from || new Date(Date.now()-30*864e5).toISOString();
  const r = await fetch(`https://${integration.shop}/admin/api/2024-10/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=50`, { headers:{'X-Shopify-Access-Token':integration.access_token} });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.orders||[]).map(o => ({ id:`shopify-${o.id}`, starts_at:o.created_at, ends_at:o.created_at, duration_min:0, client:{name:`${o.customer?.first_name||''} ${o.customer?.last_name||''}`.trim()||'Customer', email:o.email}, service:`Order #${o.order_number} — $${o.total_price}`, stylist:null, status:o.financial_status||'paid', kind:'retail_order', raw:o }));
}
export async function createAppointment(){ throw new Error('Shopify is retail only — no appointments.'); }
export async function listClients(integration, { limit=100 } = {}){
  if(!integration.access_token || !integration.shop) return [];
  const r = await fetch(`https://${integration.shop}/admin/api/2024-10/customers.json?limit=${limit}`, { headers:{'X-Shopify-Access-Token':integration.access_token} });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.customers||[]).map(c => ({ id:`shopify-${c.id}`, name:`${c.first_name||''} ${c.last_name||''}`.trim()||'Customer', phone:c.phone||null, email:c.email||null, raw:c }));
}
