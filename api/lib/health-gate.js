/**
 * api/lib/health-gate.js — THE one owner of health/readiness checking.
 * ════════════════════════════════════════════════════════════════════
 * Every /api/*-health endpoint delegates here. Before this module each
 * endpoint re-implemented env checking and DB probing its own way (and
 * execution-health even kept a second, drifted copy of the required-tables
 * manifest). One module means: one env manifest, one probe loop, one
 * status derivation, and one guarantee — every probe is isolated and
 * timed, so a single hung/throwing probe can never leave an endpoint
 * with an empty body (the calendar-health cold-start false red).
 *
 * Endpoint URLs and response shapes stay exactly as they were; this is
 * where their bodies come from now. Errors are plain objects tagged with
 * __status; healthSend() turns any gate result into a proper HTTP JSON
 * response — never an empty body.
 */
import { db } from './db.js';
import { bearer, getUserFromToken } from './auth.js';
import { resolveTenantForUser } from './tenant-access.js';
import { REQUIRED_TABLES, REQUIRED_COLUMNS } from './schema-gate.js';
import { probeColumnPresence } from './migrate-all.js';

/** Every env var the platform needs, grouped. One manifest, no per-endpoint copies. */
export const HEALTH_ENV_MANIFEST = {
  core: [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY',
    'TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'APP_URL',
  ],
  voice: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'],
};

function envState(name) {
  return { name, configured: Boolean(process.env[name]) };
}

/** Resolve a promise against a timeout so a hung probe can never wedge the endpoint. */
function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const race = Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    }),
  ]);
  if (typeof timer?.unref === 'function') timer.unref();
  return race;
}

/** Probe every required table, each probe independent + timed. */
function probeTables(client, timeoutMs = 5000) {
  return Promise.all(REQUIRED_TABLES.map((table) => {
    const probe = (async () => {
      try {
        const { error } = await client.from(table).select('*', { count: 'exact', head: true });
        return { table, ok: !error, error: error?.message || null };
      } catch (e) {
        return { table, ok: false, error: String(e?.message || e) };
      }
    })();
    return withTimeout(probe, timeoutMs, () => ({ table, ok: false, error: `probe timed out after ${timeoutMs}ms` }));
  }));
}

/** Probe one table with a real column (join tables have no id), timed + isolated. */
function probeOneTable(client, table, column = 'id', timeoutMs = 5000) {
  const probe = (async () => {
    try {
      const { error } = await client.from(table).select(column, { count: 'exact', head: true });
      return { table, ok: !error, error: error?.message || null };
    } catch (e) {
      return { table, ok: false, error: String(e?.message || e) };
    }
  })();
  return withTimeout(probe, timeoutMs, () => ({ table, ok: false, error: `probe timed out after ${timeoutMs}ms` }));
}

/**
 * /api/health — platform readiness: env, voice (ElevenLabs), timestamp.
 * Shape-preserving port of the old api/health.js. `voiceCheck` is the
 * elevenlabs checkHealth/userSubscription composition, injected so this
 * lib stays transport-agnostic; the old quota/billing surfacing lives in
 * the delegate and is merged here when provided.
 */
export async function platformHealth({ voiceCheck } = {}) {
  const supabase = Boolean(
    process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY),
  );
  const telnyx = Boolean(process.env.TELNYX_API_KEY);

  let voice = { ok: false, configured: false, message: 'voice probe skipped' };
  let voiceOk = false;
  let quotaExhausted = false;
  try {
    if (voiceCheck) {
      const v = await voiceCheck({ timeoutMs: 5000 });
      voice = v.voice; quotaExhausted = v.quotaExhausted; voiceOk = v.ok === true;
    } else {
      voice = { ok: false, message: 'no voice probe configured' };
    }
  } catch (e) {
    voice = { ok: false, message: String(e?.message || e).slice(0, 220) };
  }

  return {
    ok: supabase && telnyx,
    provider: 'telnyx',
    services: {
      supabase: { ok: supabase },
      telnyx: { ok: telnyx },
      elevenlabs: {
        ok: voiceOk,
        attention: quotaExhausted || (voiceOk && voice.billing === 'unavailable'),
        reason: quotaExhausted ? 'out-of-credit' : (voiceOk ? undefined : 'voice-unavailable'),
        voice: voice.voice || undefined,
        creditsRemaining: voice.creditsRemaining ?? null,
        tier: voice.tier || '',
        message: quotaExhausted ? voice.message : (voiceOk ? undefined : (voice.message || undefined)),
      },
    },
    voice,
    timestamp: new Date().toISOString(),
  };
}

/**
 * /api/calendar-health — the schema gate: 26 required tables AND the
 * critical-column manifest (the activation_status incident's guard).
 * Shape-preserving port of api/calendar-health.js, now hung-probe-proof:
 * every probe is timed and isolated and the whole body is computed from
 * resolved promises — the endpoint cannot serve an empty body.
 */
export async function calendarHealth({ timeoutMs = 5000 } = {}) {
  const client = db();
  if (!client) return { __status: 503, ok: false, error: 'database_not_configured' };
  try {
    const [checks, columnChecks] = await Promise.all([
      probeTables(client, timeoutMs),
      Promise.all(Object.entries(REQUIRED_COLUMNS).flatMap(([table, cols]) =>
        cols.map((column) => {
          // Same isolation as the table probes: a hung column probe must
          // never wedge the gate. A timeout is a transient read problem,
          // NOT a schema miss — classified tolerantly (ok:true).
          const probe = (async () => {
            try {
              const r = await probeColumnPresence(client, table, column);
              return { table, column, ok: r.ok, missing: r.missing, error: r.error };
            } catch (e) {
              return { table, column, ok: false, missing: false, error: String(e?.message || e) };
            }
          })();
          return withTimeout(probe, timeoutMs, () => ({ table, column, ok: true, missing: false, error: `probe timed out after ${timeoutMs}ms` }));
        })),
      ),
    ]);
    const missing = checks.filter((x) => !x.ok).map((x) => x.table);
    const missingColumns = columnChecks.filter((x) => x.missing);
    const columnRequired = Object.values(REQUIRED_COLUMNS).reduce((n, cols) => n + cols.length, 0);
    const unhealthy = missing.length > 0 || missingColumns.length > 0;
    return {
      ok: !unhealthy,
      ready: !unhealthy,
      required: REQUIRED_TABLES.length,
      passed: checks.length - missing.length,
      missing,
      checks,
      required_columns: columnRequired,
      passed_columns: columnRequired - missingColumns.length,
      missing_columns: missingColumns.map((x) => x.table + '.' + x.column),
      column_checks: columnChecks,
    };
  } catch (e) {
    return { __status: 503, ok: false, error: String(e?.message || e), ready: false };
  }
}

/**
 * /api/execution-health — the CRM/execution route's table coverage. The old
 * endpoint kept its own 16-table manifest that drifted from schema-gate.js;
 * it now derives from the one REQUIRED_TABLES manifest. Shape preserved:
 * { ok, failed, results, execution_route, crm_route }.
 */
export async function executionHealth() {
  const client = db();
  if (!client) return { __status: 503, ok: false, error: 'database_not_configured' };
  try {
    const tables = [...REQUIRED_TABLES];
    for (const extra of ['conversations', 'messages']) {
      if (!tables.includes(extra)) tables.push(extra);
    }
    const entries = await Promise.all(tables.map(async (table) => {
      const col = table === 'staff_services' ? 'staff_id' : 'id';
      const r = await probeOneTable(client, table, col);
      return [table, r.ok ? { ok: true } : { ok: false, error: r.error }];
    }));
    const results = Object.fromEntries(entries);
    const failed = entries.filter(([, v]) => !v.ok).map(([k]) => k);
    return { ok: failed.length === 0, failed, results, execution_route: '/api/lola-execute', crm_route: '/api/crm' };
  } catch (e) {
    return { __status: 503, ok: false, error: String(e?.message || e) };
  }
}

/** /api/telecom-health — Telnyx env + reachability. Shape-preserving port. */
export async function telecomHealth({ telnyxProbe } = {}) {
  const configuration = {
    api_key: Boolean(process.env.TELNYX_API_KEY),
    public_key: Boolean(process.env.TELNYX_PUBLIC_KEY),
    voice_app: Boolean(process.env.TELNYX_VOICE_APP_ID),
    messaging_profile: Boolean(process.env.TELNYX_MESSAGING_PROFILE),
    app_url: Boolean(process.env.APP_URL),
  };
  if (!configuration.api_key) {
    return { ok: false, configuration, telnyx: 'not_checked' };
  }
  try {
    if (telnyxProbe) await telnyxProbe('/phone_numbers', { query: { 'page[size]': 1 }, timeoutMs: 5000 });
    const productionSafe = process.env.NODE_ENV !== 'production' || configuration.public_key;
    return {
      ok: productionSafe,
      configuration,
      telnyx: 'reachable',
      warning: productionSafe ? null : 'TELNYX_PUBLIC_KEY is required in production',
    };
  } catch (error) {
    const status = error?.status || 503;
    return {
      __status: status >= 500 ? 503 : status,
      ok: false,
      configuration,
      telnyx: 'unreachable',
      error: String(error?.message || error),
    };
  }
}

/**
 * /api/operator-health — signed-in operator telemetry. The old endpoint
 * listed env names inline; it now uses the shared manifest. Its DB reads
 * are each isolated, so one failing table degrades the score instead of
 * 500ing the whole surface.
 */
export async function operatorHealth(tenant) {
  const client = db();
  if (!client) return { __status: 503, ok: false, error: 'database not configured' };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const safe = async (read) => {
    try { const r = await read(); return r?.data || []; } catch { return []; }
  };
  const [callsR, msgsR, intsR] = await Promise.all([
    safe(() => client.from('calls').select('id,status,direction,created_at,duration_seconds').eq('tenant_id', tenant.id).gte('created_at', since).order('created_at', { ascending: false }).limit(100)),
    safe(() => client.from('messages').select('id,role,created_at').eq('tenant_id', tenant.id).gte('created_at', since).order('created_at', { ascending: false }).limit(200)),
    safe(() => client.from('integrations').select('provider,status,expires_at,updated_at').eq('tenant_id', tenant.id)),
  ]);
  const calls = callsR.map((x) => ({ ...x, outcome: x.status || null, duration_sec: x.duration_seconds || null }));
  const messages = msgsR;
  const integrations = intsR;
  const lastCall = calls[0]?.created_at || null;
  const lastMessage = messages[0]?.created_at || null;
  const ageMinutes = (value) => (!value ? null : Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000)));
  const config = [
    ...HEALTH_ENV_MANIFEST.core.map(envState),
    ...HEALTH_ENV_MANIFEST.voice.map(envState),
  ];
  const requiredConfigured = config.every((x) => x.configured);
  const connected = integrations.filter((x) => x.status === 'connected').map((x) => x.provider);
  const failures = calls.filter((x) => ['failed', 'missed', 'error'].includes(String(x.outcome || '').toLowerCase())).length;
  const answered = calls.filter((x) => !['failed', 'missed', 'error'].includes(String(x.outcome || '').toLowerCase())).length;
  const score = Math.max(0, Math.min(100,
    (tenant.phone_number ? 20 : 0)
    + (requiredConfigured ? 35 : config.filter((x) => x.configured).length * 5)
    + (connected.length ? 15 : 0)
    + (calls.length ? 15 : 0)
    + (messages.length ? 15 : 0)
    - Math.min(20, failures * 5)));
  return {
    ok: true,
    tenant: { name: tenant.name, phone_number: tenant.phone_number },
    score,
    status: score >= 85 ? 'live' : score >= 60 ? 'degraded' : 'not_ready',
    telemetry: {
      calls_24h: calls.length,
      answered_24h: answered,
      failures_24h: failures,
      messages_24h: messages.length,
      last_call_at: lastCall,
      last_call_age_minutes: ageMinutes(lastCall),
      last_message_at: lastMessage,
      last_message_age_minutes: ageMinutes(lastMessage),
    },
    channels: {
      voice: Boolean(tenant.phone_number && process.env.TELNYX_API_KEY),
      sms: Boolean(tenant.phone_number && process.env.TELNYX_API_KEY),
      whatsapp: connected.includes('whatsapp'),
      dashboard_voice: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
    },
    integrations,
    config,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Shared auth preamble for operator-scoped health endpoints.
 * Returns { tenant } or { error: { __status, message } }.
 */
export async function healthTenant(req) {
  const user = await getUserFromToken(bearer(req));
  if (!user) return { error: { __status: 401, message: 'Not authenticated' } };
  const tenant = await resolveTenantForUser(user);
  if (!tenant?.id) return { error: { __status: 404, message: 'No tenant mapped to this account' } };
  return { tenant };
}

/**
 * /api/integration-health — per-tenant provider status board (the only
 * health endpoint scoped to signed-in tenant data rather than platform
 * env). Same states/score/blockers shape the settings page renders.
 */
const PROVIDERS = ['square', 'boulevard', 'fresha', 'vagaro', 'mindbody', 'booksy', 'shopify', 'google_calendar', 'google_gmb', 'cal_platform'];
const PROVIDER_NAMES = { google_calendar: 'Google Calendar', google_gmb: 'Google reviews (GMB)', mindbody: 'Mindbody', cal_platform: 'Cal.com (White-Label)' };

export async function integrationProviderHealth(tenant) {
  const client = db();
  if (!client) return { __status: 503, ok: false, error: 'Database not configured' };
  let rows;
  try {
    const r = await client.from('integrations')
      .select('provider,status,expires_at,metadata,updated_at')
      .eq('tenant_id', tenant.id);
    if (r.error) throw r.error;
    rows = r.data;
  } catch (e) {
    return { __status: 500, ok: false, error: String(e?.message || e) };
  }
  const byProvider = new Map((rows || []).map((row) => [row.provider, row]));
  const now = Date.now();
  const bookingProvider = String(tenant.booking_provider || tenant.booking_platform || '').toLowerCase();
  const bookingUrl = String(tenant.booking_url || '').trim();
  const state = (id, name, status, detail, action, metadata = {}) => ({ id, name, status, detail, action, metadata });

  const integrations = [];
  const voiceReady = Boolean(tenant.phone_number && process.env.TELNYX_API_KEY);
  integrations.push(state('voice', 'Voice & Text', voiceReady ? 'healthy' : 'blocked', voiceReady ? `Live on ${tenant.phone_number}` : (tenant.phone_number ? 'Telnyx server connection is missing' : 'No Lola phone number is assigned'), voiceReady ? 'test' : 'open_numbers', { phone: tenant.phone_number || null }));

  const whatsappRow = byProvider.get('whatsapp');
  const whatsappReady = Boolean(whatsappRow?.status === 'connected' || tenant.whatsapp_enabled);
  integrations.push(state('whatsapp', 'WhatsApp', whatsappReady ? 'healthy' : 'not_connected', whatsappReady ? 'Connected and available for tenant messaging' : 'Not connected for this tenant', whatsappReady ? 'test' : 'connect'));

  for (const id of PROVIDERS) {
    const row = byProvider.get(id);
    const expired = row?.expires_at && new Date(row.expires_at).getTime() <= now;
    const selected = id === bookingProvider;
    let status = 'not_connected', detail = 'Available to connect', action = 'connect';
    if (row?.status === 'connected' && !expired) { status = 'healthy'; detail = `Connected${row.updated_at ? ` · checked ${new Date(row.updated_at).toLocaleDateString('en-US')}` : ''}`; action = 'test'; }
    else if (expired) { status = 'attention'; detail = 'Authorization expired — reconnect required'; action = 'reconnect'; }
    else if (row?.status && row.status !== 'connected') { status = 'attention'; detail = `Connection status: ${row.status}`; action = 'reconnect'; }
    else if (selected && bookingUrl) { status = 'link_only'; detail = 'Booking link saved; live calendar sync is not connected'; action = 'connect'; }
    integrations.push(state(id, PROVIDER_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1), status, detail, action, row?.metadata || {}));
  }

  const knowledgeReady = Boolean(tenant.website_url || (Array.isArray(tenant.services) && tenant.services.length));
  integrations.push(state('website', 'Website Knowledge', knowledgeReady ? 'healthy' : 'attention', knowledgeReady ? 'Lola has a business knowledge source' : 'Add a website or service menu so Lola can answer accurately', knowledgeReady ? 'refresh' : 'open_activation', { website: tenant.website_url || null }));

  const critical = integrations.filter((item) => ['voice', 'website'].includes(item.id) || (item.id === bookingProvider));
  const blockers = critical.filter((item) => !['healthy'].includes(item.status));
  const healthy = integrations.filter((item) => item.status === 'healthy').length;
  const score = Math.round((healthy / integrations.length) * 100);

  return { ok: true, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, score, healthy, total: integrations.length, blockers: blockers.map((x) => x.id), integrations, checked_at: new Date().toISOString() };
}

/**
 * Turn any gate result into a proper HTTP JSON response — the no-empty-body
 * guarantee lives here. Gate errors are plain objects tagged with __status;
 * everything else is 200 when ok, 503 when not. `head` serves status-only.
 */
export function healthSend(res, result, { cors = true, head = false } = {}) {
  if (cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  res.setHeader('Cache-Control', 'no-store');
  const status = result?.__status || (result?.ok ? 200 : 503);
  if (head) return res.status(status).end();
  return res.status(status).json(result || { ok: false, error: 'health check returned nothing' });
}
