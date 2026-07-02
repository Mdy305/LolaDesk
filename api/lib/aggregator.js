import * as square     from './connectors/square.js';
import * as boulevard  from './connectors/boulevard.js';
import * as shopify    from './connectors/shopify.js';
import * as gcal       from './connectors/google-calendar.js';
import * as vagaro     from './connectors/vagaro.js';
import * as mindbody   from './connectors/mindbody.js';
import * as fresha     from './connectors/fresha.js';

const CONNECTORS = { square, boulevard, vagaro, mindbody, fresha, shopify, google_calendar: gcal };

export function getConnector(provider){
  const c = CONNECTORS[provider];
  if(!c) throw new Error(`Unknown provider: ${provider}`);
  return c;
}
export function listProviders(){
  return Object.keys(CONNECTORS).map(p => ({ id:p, name:CONNECTORS[p].META?.name||p, description:CONNECTORS[p].META?.description||'', status:CONNECTORS[p].META?.status||'available', docs:CONNECTORS[p].META?.docs||null }));
}
export async function listAllAppointments(tenantIntegrations, range){
  const all = [];
  for(const integration of tenantIntegrations){
    try{ const c = getConnector(integration.provider); const apps = await c.listAppointments(integration, range); all.push(...apps.map(a => ({ ...a, provider: integration.provider }))); }
    catch(e){ console.error(`[aggregator] ${integration.provider} failed:`, e); }
  }
  return all.sort((a,b) => new Date(a.starts_at) - new Date(b.starts_at));
}
export async function writeAppointment(tenantIntegrations, appointment, { provider } = {}){
  const target = provider ? tenantIntegrations.find(i => i.provider === provider) : tenantIntegrations.find(i => ['square','boulevard','vagaro','mindbody','fresha'].includes(i.provider)) || tenantIntegrations[0];
  if(!target) throw new Error('No booking provider connected');
  const c = getConnector(target.provider);
  return c.createAppointment(target, appointment);
}
