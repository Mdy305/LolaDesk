/**
 * api/lib/channel-store.js — one place that saves a salon's social/messaging
 * connection (tenant_channels) safely.
 *   · tokens are sealed with AES-256-GCM (api/lib/crypto.js) before they touch the DB
 *   · an account (a Facebook Page, an Instagram account, a WhatsApp number) that is
 *     ALREADY live for one salon can never be taken over by another salon
 *   · self-heals the schema once if a column/table is missing
 */
import { encrypt, decrypt } from './crypto.js';

export const TAKEN_SAY = 'That account is already connected to another salon on LolaDesk. If it’s yours, contact LolaDesk support and we’ll sort it out.';

/** Seal a token. Throws when the encryption key is missing — we never store tokens in plaintext. */
export function sealToken(t) {
  if (t == null || t === '') return null;
  return encrypt(String(t));
}
/** Open a sealed token (also reads Instagram's legacy 'plain:' rows). Never throws. */
export function openToken(t) {
  const s = String(t || '');
  if (!s) return null;
  if (s.startsWith('plain:')) return s.slice(6);
  try { return decrypt(s); } catch (_) { return null; }
}
export const canSeal = () => { try { return !!encrypt('x'); } catch (_) { return false; } };

/** Who holds this account right now (any status). */
export async function holderOf(c, channel, accountId) {
  try {
    const { data } = await c.from('tenant_channels').select('tenant_id,status').eq('channel', channel).eq('account_id', String(accountId)).maybeSingle();
    return data || null;
  } catch (_) { return null; }
}

/**
 * Save (insert or update) a connection. Returns { ok:true } or
 * { ok:false, taken:true, say } when another salon has it live.
 */
export async function saveChannelRow(c, row) {
  const held = await holderOf(c, row.channel, row.account_id);
  if (held && held.tenant_id && String(held.tenant_id) !== String(row.tenant_id) && held.status === 'active') {
    return { ok: false, taken: true, say: TAKEN_SAY };
  }
  const up = async (r) => { const { error } = await c.from('tenant_channels').upsert(r, { onConflict: 'channel,account_id' }); return error; };
  let e = await up(row);
  if (e) {
    try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {}
    e = await up(row);
  }
  if (e && /meta|last_error/i.test(String(e.message || e))) { const { meta, last_error, ...rest } = row; e = await up(rest); }
  if (e) throw new Error('Could not save the connection: ' + (e.message || e));
  return { ok: true };
}

/** Record an error on a connection (admin-only detail). */
export async function noteChannelError(c, channel, accountId, message, extra = {}) {
  try {
    await c.from('tenant_channels').update({ last_error: message ? String(message).slice(0, 300) : null, updated_at: new Date().toISOString(), ...extra })
      .eq('channel', channel).eq('account_id', String(accountId));
  } catch (_) {}
}
