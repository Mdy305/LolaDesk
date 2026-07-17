/**
 * /api/health — one URL that tells you if the app is wired
 * ════════════════════════════════════════════════════════════════
 * Visit https://www.loladesk.com/api/health after setup. No secrets
 * ever leave this endpoint — env vars report PRESENT/missing only,
 * and the database check reports table existence, not contents.
 * This is how you verify Supabase + env wiring without a terminal.
 */
import { db } from './lib/db.js';

const REQUIRED_TABLES = [
  'tenants','clients','bookings','conversations','messages','calls',
  'usage_events','integrations','client_memories','jobs',
  'orchestrator_audit','tenant_users','deposits','waitlist_entries',
  'satisfaction_surveys','callback_requests','demo_requests'
];
const ENV_KEYS = [
  'SUPABASE_URL','SUPABASE_SERVICE_KEY','APP_URL','TELNYX_API_KEY',
  'ANTHROPIC_API_KEY','ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID',
  'OPERATOR_TOOLS_SECRET','STRIPE_SECRET_KEY','ADMIN_EMAILS'
];

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  const env = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k] ? 'present' : 'MISSING']));

  let dbOk = false, present = [], missing = [...REQUIRED_TABLES];
  const c = db();
  if(c){
    // .select(*).limit(1) works on every table shape (some, like
    // tenant_users, have composite keys and no id column); only
    // r.error is inspected — no row contents ever leave this endpoint.
    const checks = await Promise.all(REQUIRED_TABLES.map(t =>
      c.from(t).select('*').limit(1)
        .then(r => ({ t, ok: !r.error }))
        .catch(() => ({ t, ok:false }))
    ));
    present = checks.filter(x => x.ok).map(x => x.t);
    missing = checks.filter(x => !x.ok).map(x => x.t);
    dbOk = present.length > 0;
  }

  const ready = dbOk && missing.length === 0 &&
    env.SUPABASE_URL === 'present' && env.SUPABASE_SERVICE_KEY === 'present';

  return res.status(200).json({
    ok: ready,
    verdict: ready
      ? 'FULLY WIRED — Lola has her memory and all systems report.'
      : (!dbOk ? 'Database unreachable — check SUPABASE_URL + SUPABASE_SERVICE_KEY in Vercel env vars.'
               : `Database connected, but ${missing.length} table(s) missing — run the ALL-IN-ONE SQL in the Supabase SQL editor.`),
    database: { connected: dbOk, tables_present: present.length, tables_expected: REQUIRED_TABLES.length, missing },
    env
  });
}
