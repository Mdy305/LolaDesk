export const META = { name:'Boulevard', description:'Luxury salons & med spas. Requires partner approval before activation.', status:process.env.BOULEVARD_CLIENT_ID?'available':'pending_partner_approval', docs:'https://developers.joinblvd.com' };
const ENV = (process.env.BOULEVARD_ENV || 'staging').toLowerCase();
const OAUTH_BASE = ENV === 'production' ? 'https://dashboard.boulevard.io/oauth' : 'https://dashboard.sandbox.joinblvd.com/oauth';
const API_BASE = ENV === 'production' ? 'https://dashboard.boulevard.io/api/2020-01/admin' : 'https://dashboard.sandbox.joinblvd.com/api/2020-01/admin';
export function getAuthUrl(state){
  if(!process.env.BOULEVARD_CLIENT_ID) throw new Error('Boulevard partner credentials not configured');
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=boulevard`;
  const params = new URLSearchParams({ client_id:process.env.BOULEVARD_CLIENT_ID, redirect_uri:redirect, response_type:'code', scope:'admin', state });
  return `${OAUTH_BASE}/authorize?${params}`;
}
export async function exchangeCode(code){
  if(!process.env.BOULEVARD_CLIENT_ID) return { ok:false, error:'Boulevard requires partner approval', _stub:true };
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=boulevard`;
  const r = await fetch(`${OAUTH_BASE}/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, client_id:process.env.BOULEVARD_CLIENT_ID, client_secret:process.env.BOULEVARD_CLIENT_SECRET, redirect_uri:redirect }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Boulevard OAuth failed');
  return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString(), raw:data };
}
export async function refreshToken(refresh_token){
  if(!process.env.BOULEVARD_CLIENT_ID) return null;
  const r = await fetch(`${OAUTH_BASE}/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'refresh_token', refresh_token, client_id:process.env.BOULEVARD_CLIENT_ID, client_secret:process.env.BOULEVARD_CLIENT_SECRET }) });
  return r.json();
}
async function gql(integration, query, variables = {}){
  const r = await fetch(API_BASE, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${integration.access_token}`,'Accept':'application/json'}, body: JSON.stringify({ query, variables }) });
  const data = await r.json();
  if(data.errors) throw new Error(data.errors[0]?.message || 'Boulevard GraphQL error');
  return data.data;
}
export async function listAppointments(integration, { from, to } = {}){
  if(!process.env.BOULEVARD_CLIENT_ID) return [];
  const startAt = from || new Date(Date.now()-7*864e5).toISOString();
  const endAt = to || new Date(Date.now()+30*864e5).toISOString();
  const query = `query L($startAt:DateTime!,$endAt:DateTime!){appointments(first:200,filter:{startAtRange:{from:$startAt,to:$endAt}}){edges{node{id startAt endAt state client{firstName lastName phoneNumber email} appointmentServices{service{name}} staff{firstName lastName}}}}}`;
  const data = await gql(integration, query, { startAt, endAt });
  return (data?.appointments?.edges||[]).map(({node}) => ({ id:node.id, starts_at:node.startAt, ends_at:node.endAt, duration_min:Math.round((new Date(node.endAt)-new Date(node.startAt))/60000), client:{name:[node.client?.firstName,node.client?.lastName].filter(Boolean).join(' ')||'Client', phone:node.client?.phoneNumber, email:node.client?.email}, service:node.appointmentServices?.[0]?.service?.name||'Service', stylist:[node.staff?.firstName,node.staff?.lastName].filter(Boolean).join(' ')||null, status:(node.state||'confirmed').toLowerCase(), raw:node }));
}
export async function createAppointment(integration){
  if(!process.env.BOULEVARD_CLIENT_ID) return { ok:false, error:'Boulevard requires partner approval', _stub:true };
  throw new Error('Boulevard createAppointment: requires live partner sandbox to verify.');
}
export async function listClients(integration, { limit=100 } = {}){
  if(!process.env.BOULEVARD_CLIENT_ID) return [];
  const query = `query C($first:Int!){clients(first:$first){edges{node{id firstName lastName phoneNumber email}}}}`;
  const data = await gql(integration, query, { first:limit });
  return (data?.clients?.edges||[]).map(({node}) => ({ id:node.id, name:[node.firstName,node.lastName].filter(Boolean).join(' ')||'Client', phone:node.phoneNumber||null, email:node.email||null, raw:node }));
}
