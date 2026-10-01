/**
 * api/lib/legal.js — the paper trail that makes the legal pages enforceable.
 * ════════════════════════════════════════════════════════════════
 * A Terms of Service only protects LolaDesk if we can PROVE the customer
 * agreed to it. Every signup carries an affirmative checkbox; this records
 * which version, when, from which IP and browser — in the user's auth
 * metadata (always) and in legal_acceptances (when the table exists).
 *
 * The other half is what clients hear and read: every Lola call opens with
 * the AI + recording disclosure (Florida is an all-party-consent state), and
 * every automated text carries opt-out language (TCPA / CTIA).
 */
export const TERMS_VERSION = '2026-10-01';
export const LEGAL_DOCS = ['terms', 'privacy', 'acceptable-use', 'sms-terms', 'dpa', 'ai'];

// What a caller hears first on every call Lola answers.
export const CALL_DISCLOSURE = 'this call may be recorded, and I’m an AI assistant';
export const STOP_LINE = 'Reply STOP to opt out.';

function ipOf(req) {
  const h = (req && req.headers) || {};
  const f = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  return f || null;
}

export function acceptanceFrom(req, { email, version } = {}) {
  const h = (req && req.headers) || {};
  return {
    email: String(email || '').trim().toLowerCase() || null,
    terms_version: TERMS_VERSION,
    client_version: version ? String(version).slice(0, 40) : null,
    documents: LEGAL_DOCS,
    accepted_at: new Date().toISOString(),
    ip: ipOf(req),
    user_agent: String(h['user-agent'] || '').slice(0, 400) || null,
  };
}

/** Best-effort: a missing table never blocks a signup (metadata already holds the record). */
export async function recordAcceptance(c, a) {
  if (!c) return { ok: false, reason: 'no_db' };
  const row = {
    user_id: a.user_id || null, tenant_id: a.tenant_id || null, email: a.email,
    terms_version: a.terms_version, documents: a.documents, accepted_at: a.accepted_at,
    ip: a.ip, user_agent: a.user_agent,
  };
  return insertHealing(c, 'legal_acceptances', row);
}

/** Insert; if the table doesn't exist yet, let the self-healing migrations create it and retry once. */
export async function insertHealing(c, table, row) {
  const attempt = async () => { const { error } = await c.from(table).insert(row); return error ? { ok: false, reason: error.message || String(error) } : { ok: true }; };
  try {
    let r = await attempt();
    if (!r.ok && /relation|does not exist|schema cache|PGRST205|42P01/i.test(r.reason || '')) {
      try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {}
      r = await attempt();
    }
    return r;
  } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
}

/** Ensure an outbound automated text carries opt-out language. */
export function withStopLine(text) {
  const t = String(text || '').trim();
  if (!t || /\bSTOP\b/.test(t)) return t;
  return `${t} ${STOP_LINE}`;
}

/** Does a greeting already disclose recording and AI? */
export function greetingDiscloses(g) {
  const s = String(g || '');
  return /record/i.test(s) && /\b(AI|artificial|virtual assistant|automated)\b/i.test(s);
}

/** Add the disclosure to a greeting that lacks it, keeping the salon's words and {{variables}}. */
export function discloseGreeting(g) {
  const s = String(g || '').trim();
  if (greetingDiscloses(s)) return s;
  if (!s) return `Hi, thanks for calling {{salon_name}}! I’m Lola, the salon’s AI assistant — this call may be recorded. How can I help you today?`;
  const m = s.match(/^(.*?[.!?])(\s+.*)?$/s);
  const head = m ? m[1] : s, tail = m && m[2] ? m[2] : '';
  return `${head} Just so you know, ${CALL_DISCLOSURE}.${tail}`;
}
