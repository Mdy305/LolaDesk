import * as square     from './connectors/square.js';
import * as boulevard  from './connectors/boulevard.js';
import * as shopify    from './connectors/shopify.js';
import * as gcal       from './connectors/google-calendar.js';
import * as vagaro     from './connectors/vagaro.js';
import * as mindbody   from './connectors/mindbody.js';
import * as fresha     from './connectors/fresha.js';
import * as booksy     from './connectors/booksy.js';
import * as gmb        from './connectors/google-gmb.js';
import * as cal        from './connectors/cal-platform.js';
import * as ical       from './connectors/ical.js';
import * as boulevardLive from './connectors/boulevard-client.js';

const CONNECTORS = { square, boulevard, boulevard_client: boulevardLive, vagaro, mindbody, fresha, booksy, shopify, google_calendar: gcal, google_gmb: gmb, cal_platform: cal, ical };

export function getConnector(provider){
  const c = CONNECTORS[provider];
  if(!c) throw new Error(`Unknown provider: ${provider}`);
  return c;
}
export function listProviders(){
  // Calendar links are added by pasting a URL (Settings → Booking platforms), not by an OAuth button.
  return Object.keys(CONNECTORS).filter(p => p !== 'ical' && p !== 'boulevard_client').map(p => ({ id:p, name:CONNECTORS[p].META?.name||p, description:CONNECTORS[p].META?.description||'', status:CONNECTORS[p].META?.status||'available', docs:CONNECTORS[p].META?.docs||null }));
}
export async function listAllAppointments(tenantIntegrations, range){
  const all = [];
  for(const integration of tenantIntegrations){
    try{ const c = getConnector(integration.provider); const apps = await c.listAppointments(integration, range); all.push(...apps.map(a => ({ ...a, provider: integration.provider }))); }
    catch(e){ console.error(`[aggregator] ${integration.provider} failed:`, e); }
  }
  return all.sort((a,b) => new Date(a.starts_at) - new Date(b.starts_at));
}
// Providers the mesh can WRITE appointments to. cal_platform joins the
// traditional salon systems as a first-class write target — when a tenant
// selects it as booking_provider, writes route to Cal.com.
const WRITE_PROVIDERS = ['boulevard_client','square','boulevard','vagaro','mindbody','fresha','booksy','cal_platform'];
export async function writeAppointment(tenantIntegrations, appointment, { provider } = {}){
  let target = provider ? tenantIntegrations.find(i => i.provider === provider) : null;
  // Explicit provider that isn't connected falls back to any write-eligible
  // provider rather than failing the booking (tenant pref is honored when it
  // exists and is connected).
  // Never "any connected integration": a calendar feed or Shopify can't take an appointment.
  if(!target) target = tenantIntegrations.find(i => WRITE_PROVIDERS.includes(i.provider));
  if(!target) throw new Error('No booking provider connected');
  const c = getConnector(target.provider);
  return c.createAppointment(target, appointment);
}

// Cancels / moves upstream (booking-outbox 'cancel' | 'update'). Connectors
// without an API for it throw an "unsupported: …" error the outbox records.
export async function changeAppointment(integration, op, args){
  const c = getConnector(integration.provider);
  const fn = op === 'cancel' ? c.cancelAppointment : c.updateAppointment;
  if(typeof fn !== 'function') throw new Error(`unsupported: ${integration.provider} ${op} is not available through its API`);
  return fn(integration, args);
}
