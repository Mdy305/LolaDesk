/**
 * api/lib/doctor.js — LolaDesk checks itself, repairs what it can, and proves it.
 * ═════════════════════════════════════════════════════════════════════════════
 * Every 30 minutes (cron lola-heal) and on every live check (/api/status):
 *   1. CHECK each part the way it really is (Telnyx, Square, the database, the crons),
 *   2. REPAIR what can be repaired automatically,
 *   3. VERIFY by reading it back — "fixed" only when the second look is clean,
 *   4. KEEP THE EVIDENCE when it can't: exactly what was sent, what the provider answered, what it holds —
 *      so the next fix is aimed, never guessed,
 *   5. TELL the platform owner once per new problem (and once when it's fixed).
 * Report: platform_settings "doctor:last". Nothing here ever deletes data.
 */
import { db } from './db.js';

const clip = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const within = (ms, p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timed out')), ms))]);

async function check(key, label, fn) {
  const t0 = Date.now();
  try { const r = await within(25000, fn()); return { key, label, ms: Date.now() - t0, ...r }; }
  catch (e) { return { key, label, ok: false, detail: 'The check itself failed: ' + clip(e?.message || e, 200), ms: Date.now() - t0 }; }
}

// ── Telnyx: Lola's assistant and her tools ──
async function telnyxTools({ light = false } = {}) {
  if (!process.env.TELNYX_API_KEY) return { ok: false, detail: 'TELNYX_API_KEY is not set in Vercel.', fix: 'Vercel → Settings → Environment Variables → TELNYX_API_KEY, then Redeploy.' };
  const W = await import('./assistant-wiring.js');
  const { telnyxRequest, telnyxData } = await import('./telnyx-client.js');
  const id = (await W.resolveAssistant().catch(() => null))?.id;
  if (!id) return { ok: false, detail: 'Lola’s Telnyx assistant could not be found.', fix: 'Check TELNYX_LOLA_BRAIN_ID in Vercel (Telnyx → AI → Assistants → LolaBrain → its id).' };
  const look = async () => {
    const a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { timeoutMs: 9000 })) || {};
    const names = (a.tools || []).map((t) => ({ name: W.toolName ? W.toolName(t) : (t?.webhook?.name || t?.function?.name || ''), shared: t?.shared === true, id: t?.id || null }));
    const count = new Map(); for (const n of names) if (n.name) count.set(n.name, (count.get(n.name) || 0) + 1);
    return { a, names, dups: [...count].filter(([, c]) => c > 1).map(([n]) => n) };
  };
  const before = await look();
  let w = null;
  if (!light) { try { w = await W.wireAssistant({ heal: true }); } catch (e) { w = { error: clip(e?.message || e) }; } }
  else if (W.lastRefusal && Date.now() - Date.parse(W.lastRefusal.at) < 10 * 60e3) w = { error: W.lastRefusal.error };
  const after = await look();
  const healed = before.dups.length > 0 && after.dups.length === 0 && !w?.error;
  const evidence = (!w?.error && !after.dups.length) ? null : {
    telnyx_said: clip(w?.error || W.lastRefusal?.error || '', 300),
    holds: after.names.map((x) => (x.shared ? 'library:' : 'inline:') + x.name + (x.shared && x.id ? '#' + String(x.id).slice(-6) : '')).join(', '),
    tool_ids_in_get: Array.isArray(after.a.tool_ids) ? after.a.tool_ids.length + ' ids' : 'not in GET',
    we_sent: W.lastRefusal?.sent ? `tools: ${W.lastRefusal.sent.tools.length}, tool_ids: ${Array.isArray(W.lastRefusal.sent.tool_ids) ? W.lastRefusal.sent.tool_ids.length + ' ids' : W.lastRefusal.sent.tool_ids}` : null,
    duplicates: after.dups.join(', '),
  };
  if (!w?.error && !after.dups.length) return { ok: true, healed, detail: `Lola’s tools are clean (${after.names.length} tools, no duplicates).` };
  const said = String(w?.error || W.lastRefusal?.error || '');
  const named = after.dups.length ? after.dups : ((said.match(/not unique:\s*([^.]+)/i) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { ok: false, healed: false, detail: named.length ? `Telnyx says these tool names are used twice: ${named.join(', ')}.` : 'Telnyx refused Lola’s settings.',
    fix: named.length ? 'Telnyx → AI → Assistants → LolaBrain → Tools: remove the Tools-Library copy of ' + named.slice(0, 4).join(', ') + ' (keep the one pointing at loladesk.com), Save. Also check AI → MCP Servers attached to LolaBrain for tools with the same names.' : 'Send this evidence to support.', evidence };
}

// ── Square: the app's settings ──
function squareApp() {
  const id = String(process.env.SQUARE_APP_ID || '').trim(), env = String(process.env.SQUARE_ENV || '').trim().toLowerCase();
  const problems = [], notes = [];
  if (!id) problems.push('SQUARE_APP_ID is missing');
  if (!process.env.SQUARE_APP_SECRET) problems.push('SQUARE_APP_SECRET is missing');
  if (id && /^sq0idp-/.test(id) && env && env !== 'production') problems.push(`SQUARE_APP_ID is a production app but SQUARE_ENV is "${env}" (must be production, or remove it) — Connect goes to Square’s test site and fails`);
  if (id && /^sq0idp-/.test(id) && !env) notes.push('SQUARE_ENV not set — production read from the app id (fine)');
  if (id && /^sandbox-/.test(id) && env === 'production') problems.push('SQUARE_APP_ID is a sandbox app but SQUARE_ENV is production');
  if (/\s/.test(String(process.env.SQUARE_APP_ID || '')) || /\s$/.test(String(process.env.SQUARE_APP_SECRET || ''))) problems.push('a Square value in Vercel has a space or line break in it');
  const redirect = process.env.SQUARE_REDIRECT_URL || `${(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, '')}/api/oauth/callback`;
  if (!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) notes.push('instant updates are off (no SQUARE_WEBHOOK_SIGNATURE_KEY) — the 1-minute check still runs');
  if (problems.length) return { ok: false, detail: problems.join('; ') + '.', fix: 'Vercel → Settings → Environment Variables (Production): SQUARE_APP_ID = your Production Application ID (sq0idp-…), SQUARE_APP_SECRET = Production Application secret, SQUARE_ENV = production → Redeploy. Square Developer Console → OAuth → Production Redirect URL = ' + redirect };
  return { ok: true, detail: `Square app set (${env || 'production, from the app id'}). Redirect URL must be exactly ${redirect}.` + (notes.length ? ' Note: ' + notes.join('; ') + '.' : '') };
}

// ── Square: every salon's connection (renewed, permissions, data flowing) ──
async function squareConnections(c, { now = Date.now(), light = false } = {}) {
  const { squareRows } = await import('./square-care.js');
  const S = await import('./connectors/square.js');
  const rows = await squareRows(c);
  let lastOauth = null;
  try { const { data } = await c.from('platform_settings').select('value').eq('key', 'oauth:last_error').maybeSingle(); lastOauth = data?.value || null; } catch (_) {}
  const recentOauth = lastOauth && now - Date.parse(lastOauth.at) < 3 * 864e5 ? lastOauth : null;
  if (!rows.length) return { ok: !recentOauth, detail: recentOauth ? `No salon is connected to Square — the last attempt failed: ${clip(recentOauth.reason, 200)}` : 'No salon has connected Square yet.', fix: recentOauth ? fixForOauth(recentOauth.reason) : null, evidence: recentOauth };
  const out = [], healed = [];
  for (const row of rows) {
    const who = row.tenant_id.slice(0, 8);
    if (row.status !== 'connected') { out.push(`${who}: ${row.status} — the salon must reconnect (Settings → Square)`); continue; }
    if (!light) { try { const f = await S.keepFresh(row, { now }); if (f.refreshed) healed.push(`${who}: Square access renewed`); } catch (_) {} }
    const st = await S.tokenStatus(row);
    if (!st.ok) { if (st.status === 401 || /ACCESS_TOKEN/.test(String(st.code || ''))) { await S.authProblem(row, st.code || 'UNAUTHORIZED'); out.push(`${who}: Square no longer accepts LolaDesk’s access (${st.code || st.status}) — owner told to reconnect`); } else out.push(`${who}: Square didn’t answer the access check (${st.status || st.error})`); continue; }
    const missing = st.missing || [];
    if (JSON.stringify(row.metadata?.missing_scopes || []) !== JSON.stringify(missing)) { try { await c.from('integrations').update({ metadata: { ...(row.metadata || {}), scopes: st.scopes, missing_scopes: missing } }).eq('id', row.id); } catch (_) {} }
    if (missing.length) { out.push(`${who}: connected, but must reconnect once to allow ${missing.map((x) => x.toLowerCase().replace(/_/g, ' ')).join(', ')}`); continue; }
    // Data flowing? If the last sync is old, run it now.
    try {
      const sd = await import('./square-data.js');
      const led = await sd.loadLedger(c, row.tenant_id);
      const age = led.updated_at ? now - Date.parse(led.updated_at) : Infinity;
      if (age > 8 * 3600e3 && light) out.push(`${who}: Square data is ${age === Infinity ? 'not read yet' : Math.round(age / 3600e3) + 'h old'} — the next self-repair (every 30 min) syncs it`);
      else if (age > 8 * 3600e3) { const r = await sd.syncEverything(c, row, { now, budgetMs: 15000 }); if (r.ok) healed.push(`${who}: Square data was ${age === Infinity ? 'never read' : Math.round(age / 3600e3) + 'h old'} — synced now (${r.payments || 0} sales)`); else out.push(`${who}: sync failed — ${clip(r.error, 160)}`); }
    } catch (e) { out.push(`${who}: sync check failed — ${clip(e?.message || e, 160)}`); }
  }
  return { ok: !out.length, healed: healed.length ? healed.join('; ') : false, detail: out.length ? out.join(' · ') : `${rows.length} Square connection${rows.length > 1 ? 's' : ''} healthy${healed.length ? ' (' + healed.join('; ') + ')' : ''}.`, fix: out.length ? 'The salon owner: Settings → Square → Reconnect.' : null };
}
function fixForOauth(reason = '') {
  const r = String(reason).toLowerCase();
  if (/redirect/.test(r)) return 'Square Developer Console → OAuth (Production) → Redirect URL must be exactly https://www.loladesk.com/api/oauth/callback';
  if (/client|application|not found|invalid_client|unauthorized_client/.test(r)) return 'Vercel: SQUARE_APP_ID / SQUARE_APP_SECRET must be the Production values of the same Square app, SQUARE_ENV = production → Redeploy.';
  if (/expired|invalid_state|state/.test(r)) return 'The Connect link expired — sign in to LolaDesk again and press Connect within 10 minutes.';
  if (/access_denied|denied/.test(r)) return 'The Square account owner declined on Square’s screen — press Connect again and choose Allow.';
  return 'Press Connect again; if it fails the same way, this reason is what to fix.';
}

// ── Database tables the app relies on ──
async function tables(c) {
  const need = ['tenants', 'clients', 'bookings', 'integrations', 'platform_settings', 'lola_campaigns', 'lola_campaign_recipients', 'salon_sales', 'salon_sale_items', 'salon_payouts', 'salon_payout_entries'];
  try { const m = await import('./migrate.js'); await m.ensureMigrations(); await m.ensureSalesSchema(); await m.ensurePayoutsSchema(); } catch (_) {}
  const missing = [];
  for (const t of need) { const { error } = await c.from(t).select('*').limit(1); if (error) missing.push(t); }
  return missing.length ? { ok: false, detail: 'Missing in the database: ' + missing.join(', ') + '.', fix: 'Supabase → SQL Editor → run sql/square-sales.sql (and sql/lola-marketing.sql) from your LolaDesk folder.' } : { ok: true, detail: `All ${need.length} core tables present.` };
}

function crons() {
  const miss = ['CRON_SECRET', 'SUPABASE_URL'].filter((k) => !process.env[k]);
  if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) miss.push('SUPABASE_SERVICE_KEY');
  return miss.length ? { ok: false, detail: 'Missing in Vercel: ' + miss.join(', ') + ' — the self-repair and sync jobs can’t run.', fix: 'Vercel → Settings → Environment Variables → add them → Redeploy.' } : { ok: true, detail: 'Background jobs can run (sync every minute, Square every 15 min, self-repair every 30 min).' };
}

/** One full pass. heal=false only reads. */
export async function runDoctor({ c = db(), now = Date.now(), notify = true, light = false } = {}) {
  if (!c) return { ok: false, at: new Date(now).toISOString(), checks: [{ key: 'database', label: 'Database', ok: false, detail: 'Supabase is not configured in Vercel.', fix: 'Vercel → SUPABASE_URL and SUPABASE_SERVICE_KEY → Redeploy.' }] };
  const checks = [];
  checks.push(await check('crons', 'Background jobs', async () => crons()));
  checks.push(await check('tables', 'Database tables', () => tables(c)));
  checks.push(await check('telnyx_tools', 'Lola on Telnyx (tools)', () => telnyxTools({ light })));
  checks.push(await check('square_app', 'Square app settings', async () => squareApp()));
  checks.push(await check('square_connections', 'Square connections & data', () => squareConnections(c, { now, light })));
  const report = { at: new Date(now).toISOString(), ok: checks.every((x) => x.ok), checks };
  // Remember it; tell the platform owner about new problems (and fixes) once.
  let prev = null;
  try { const { data } = await c.from('platform_settings').select('value').eq('key', 'doctor:last').maybeSingle(); prev = data?.value || null; } catch (_) {}
  try { await c.from('platform_settings').upsert({ key: 'doctor:last', value: report, updated_at: report.at }, { onConflict: 'key' }); } catch (_) {}
  if (notify) {
    const was = new Map((prev?.checks || []).map((x) => [x.key, x.ok]));
    const broke = checks.filter((x) => !x.ok && was.get(x.key) !== false);
    const fixed = checks.filter((x) => x.ok && was.get(x.key) === false);
    if (broke.length || fixed.length) {
      try {
        const { alertAdmin } = await import('./billing-enforce.js');
        await alertAdmin(broke.length ? `LolaDesk doctor: ${broke.length} problem${broke.length > 1 ? 's' : ''}` : 'LolaDesk doctor: fixed',
          [...broke.map((x) => `✗ ${x.label}: ${x.detail}${x.fix ? ' → ' + x.fix : ''}`), ...fixed.map((x) => `✓ ${x.label}: fixed — ${x.detail}`)].join('\n'));
      } catch (_) {}
    }
  }
  return report;
}

/** One line per check for the live check / installer. */
export function doctorLines(report) {
  return (report?.checks || []).map((x) => `${x.ok ? '✓' : '✗'} ${x.label}: ${x.detail}${x.healed ? ' (repaired: ' + (typeof x.healed === 'string' ? x.healed : 'yes') + ')' : ''}${!x.ok && x.fix ? ' → ' + x.fix : ''}${!x.ok && x.evidence ? ' [evidence: ' + Object.entries(x.evidence).filter(([, v]) => v).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' | ') + ']' : ''}`);
}
