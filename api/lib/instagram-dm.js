/**
 * api/lib/instagram-dm.js — Lola answers each salon's Instagram DMs.
 * ════════════════════════════════════════════════════════════════
 * Instagram API with Instagram Login (no Facebook Page needed):
 *   connect  → instagram.com/oauth/authorize (instagram_business_basic,
 *              instagram_business_manage_messages) → code → short token →
 *              60-day token (refreshed nightly) → subscribe to "messages".
 *   webhook  → Meta POSTs DMs here (signed with the app secret); we find the
 *              salon by its Instagram account id, and the same Lola answers
 *              with the same memory and booking tools as on the phone.
 * Meta is only the pipe — Lola's brain stays on Telnyx.
 *
 * Env: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_VERIFY_TOKEN.
 */
import crypto from 'node:crypto';
import { appUrl } from './telnyx-client.js';
import { encrypt, decrypt } from './crypto.js';
import { getOrStartConversation, getConversationHistory, logMessage, logUsage, setClientMemory } from './db.js';
import { answerClient } from './client-brain.js';

const GRAPH = 'https://graph.instagram.com/v21.0';
export const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';
export const igConfigured = () => !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
// No query string: Meta matches the redirect URI exactly.
export const redirectUri = () => appUrl() + '/api/instagram';
const secret = () => String(process.env.INSTAGRAM_APP_SECRET || '');

// Tokens are encrypted at rest when INTEGRATION_ENCRYPTION_KEY is set (as with every other integration).
const seal = (t) => { try { return encrypt(t); } catch (_) { return 'plain:' + t; } };
const open = (t) => { const s = String(t || ''); if (s.startsWith('plain:')) return s.slice(6); try { return decrypt(s); } catch (_) { return null; } };

export function signState(tenantId, now = Date.now()) {
  const body = `${tenantId}.${now}`;
  return body + '.' + crypto.createHmac('sha256', secret() || 'x').update(body).digest('hex').slice(0, 32);
}
export function readState(state, now = Date.now()) {
  const [id, ts, sig] = String(state || '').split('.');
  if (!id || !ts || !sig) return null;
  const want = crypto.createHmac('sha256', secret() || 'x').update(`${id}.${ts}`).digest('hex').slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  if (now - Number(ts) > 30 * 60e3) return null;
  return id;
}
export function authUrl(tenantId) {
  const q = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID || '', redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES, state: signState(tenantId), enable_fb_login: '0', force_authentication: '1' });
  return 'https://www.instagram.com/oauth/authorize?' + q;
}
export function verifySignature(raw, header) {
  if (!secret()) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret()).update(raw).digest('hex');
  const got = String(header || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function j(url, init) {
  const r = await fetch(url, init); const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d?.error?.message || d?.error_message || `Instagram ${r.status}`);
  return d;
}

/** code → long-lived token → account → subscribed → saved. */
export async function connectInstagram(c, tenantId, code) {
  const form = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID, client_secret: secret(), grant_type: 'authorization_code', redirect_uri: redirectUri(), code: String(code).replace(/#_$/, '') });
  const short = await j('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const shortTok = short.access_token || short.data?.[0]?.access_token;
  const long = await j(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secret())}&access_token=${encodeURIComponent(shortTok)}`);
  const token = long.access_token || shortTok;
  const me = await j(`${GRAPH}/me?fields=user_id,username,name&access_token=${encodeURIComponent(token)}`);
  const accountId = String(me.user_id || me.id || short.user_id || '');
  if (!accountId) throw new Error('Instagram did not return the account');
  try { await j(`${GRAPH}/me/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch (_) {}
  const row = { tenant_id: tenantId, channel: 'instagram', account_id: accountId, username: me.username || null, access_token: seal(token),
    expires_at: new Date(Date.now() + Number(long.expires_in || 5184000) * 1000).toISOString(), status: 'active', updated_at: new Date().toISOString() };
  await saveChannel(c, row);
  return { ok: true, username: me.username || null, account_id: accountId };
}

async function saveChannel(c, row) {
  const up = async () => { const { error } = await c.from('tenant_channels').upsert(row, { onConflict: 'channel,account_id' }); return error; };
  let e = await up();
  if (e) { try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {} e = await up(); }
  if (e) throw new Error('Could not save the Instagram connection: ' + (e.message || e));
}

export async function channelFor(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('account_id,username,status,expires_at,updated_at').eq('tenant_id', tenantId).eq('channel', 'instagram').maybeSingle(); return data || null; } catch (_) { return null; }
}
export async function disconnect(c, tenantId) {
  try { await c.from('tenant_channels').update({ status: 'disconnected', access_token: null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('channel', 'instagram'); } catch (_) {}
  return { ok: true };
}

export async function sendDM(token, recipientId, text) {
  return j(`${GRAPH}/me/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ recipient: { id: recipientId }, message: { text: String(text).slice(0, 990) } }) });
}

/** The person writing in: an Instagram-keyed client (merged with their phone client once they give it). */
async function igClient(c, tenantId, igsid, token) {
  const key = 'ig:' + String(igsid).slice(0, 60);
  let { data: client } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', key).maybeSingle();
  // A linked phone client wins: same person, one memory.
  if (client?.notes && /^linked:\+\d+$/.test(client.notes)) {
    const { data: real } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', client.notes.slice(7)).maybeSingle();
    if (real) return { client: real, key: real.phone, phone: real.phone };
  }
  if (!client) {
    let name = 'Instagram', handle = null;
    try { const p = await j(`${GRAPH}/${encodeURIComponent(igsid)}?fields=name,username&access_token=${encodeURIComponent(token)}`); name = p.name || p.username || name; handle = p.username || null; } catch (_) {}
    const parts = String(name).trim().split(/\s+/);
    const { data } = await c.from('clients').insert({ tenant_id: tenantId, phone: key, first_name: parts.shift() || 'Instagram', last_name: parts.join(' ') || null, updated_at: new Date().toISOString() }).select().maybeSingle();
    client = data;
    if (handle) { try { await setClientMemory(tenantId, key, 'instagram', { handle }); } catch (_) {} }
  }
  return { client, key, phone: null };
}

/** One webhook delivery from Meta. send/answer are injectable for tests. */
export async function handleInstagramEvent(c, event, { answer = answerClient, send = sendDM } = {}) {
  const done = [];
  if (!event || event.object !== 'instagram') return done;
  for (const entry of event.entry || []) {
    for (const m of entry.messaging || []) {
      const text = m?.message?.text;
      if (!text || m.message.is_echo || m.message.is_deleted) continue;
      const accountId = String(m.recipient?.id || entry.id || '');
      const { data: ch } = await c.from('tenant_channels').select('*').eq('channel', 'instagram').eq('account_id', accountId).eq('status', 'active').maybeSingle();
      if (!ch) { done.push({ skipped: 'unknown_account', accountId }); continue; }
      const token = open(ch.access_token); if (!token) { done.push({ skipped: 'no_token' }); continue; }
      const { data: tenant } = await c.from('tenants').select('*').eq('id', ch.tenant_id).maybeSingle();
      if (!tenant) continue;
      const who = await igClient(c, tenant.id, m.sender.id, token);
      // They gave their number in the DM → link Instagram to their phone client (one person, one memory).
      const ph = String(text).match(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/);
      if (ph && !who.phone) {
        const e = `+1${ph[1]}${ph[2]}${ph[3]}`;
        try {
          const { data: real } = await c.from('clients').select('*').eq('tenant_id', tenant.id).eq('phone', e).maybeSingle();
          if (real) { await c.from('clients').update({ notes: 'linked:' + e }).eq('id', who.client.id); who.client = real; who.key = e; }
          who.phone = e;
        } catch (_) {}
      }
      let conv = null, history = [];
      try { conv = await getOrStartConversation(tenant.id, { clientId: who.client?.id, channel: 'instagram', agent: 'lola' }); if (conv?.id) history = (await getConversationHistory(conv.id, 10)) || []; } catch (_) {}
      const tz = (await c.from('booking_settings').select('timezone').eq('tenant_id', tenant.id).maybeSingle().then((r) => r.data?.timezone).catch(() => null)) || 'America/New_York';
      const ans = await answer({ tenant, client: who.client, channel: 'instagram', text, history: history.filter((h) => typeof h.content === 'string'), phone: who.phone, memoryKey: who.key, tz });
      try { await send(token, m.sender.id, ans.reply); } catch (e) { done.push({ error: String(e?.message || e) }); continue; }
      try {
        if (conv?.id) { await logMessage({ conversationId: conv.id, tenantId: tenant.id, role: 'user', agent: 'lola', content: text }); await logMessage({ conversationId: conv.id, tenantId: tenant.id, role: 'assistant', agent: 'lola', content: ans.reply }); }
        await logUsage(tenant.id, 'instagram_received', 1);
      } catch (_) {}
      done.push({ tenant: tenant.id, reply: ans.reply, actions: (ans.actions || []).map((a) => a.tool) });
    }
  }
  return done;
}

/** Nightly: keep every 60-day token alive. */
export async function refreshInstagramTokens(c, { now = Date.now() } = {}) {
  const out = { refreshed: 0, failed: 0 };
  let rows = [];
  try { const { data } = await c.from('tenant_channels').select('*').eq('channel', 'instagram').eq('status', 'active'); rows = data || []; } catch (_) { return out; }
  for (const r of rows) {
    if (r.expires_at && new Date(r.expires_at).getTime() - now > 20 * 86400e3) continue;
    try {
      const d = await j(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(open(r.access_token))}`);
      await c.from('tenant_channels').update({ access_token: seal(d.access_token), expires_at: new Date(now + Number(d.expires_in || 5184000) * 1000).toISOString(), updated_at: new Date(now).toISOString() }).eq('account_id', r.account_id).eq('channel', 'instagram');
      out.refreshed++;
    } catch (_) { out.failed++; }
  }
  return out;
}

/** The owner replies to an Instagram thread from the LolaDesk inbox. */
export async function replyAsSalon(c, tenantId, clientId, text) {
  const { data: cl } = await c.from('clients').select('id,phone').eq('id', clientId).eq('tenant_id', tenantId).maybeSingle();
  let key = cl && String(cl.phone || '').startsWith('ig:') ? cl.phone : null;
  if (!key && cl?.phone) { const { data: l } = await c.from('clients').select('phone').eq('tenant_id', tenantId).eq('notes', 'linked:' + cl.phone).maybeSingle(); key = l?.phone || null; }
  if (!key) return { ok: false, error: 'This client hasn’t messaged you on Instagram.' };
  const { data: ch } = await c.from('tenant_channels').select('access_token,status').eq('tenant_id', tenantId).eq('channel', 'instagram').maybeSingle();
  const token = ch && ch.status === 'active' ? open(ch.access_token) : null;
  if (!token) return { ok: false, error: 'Instagram isn’t connected — Settings → Lola on Instagram.' };
  try { await sendDM(token, key.slice(3), text); return { ok: true }; }
  catch (e) { return { ok: false, error: /window|24|outside/i.test(String(e?.message)) ? 'Instagram only allows replies within 24 hours of their last message.' : String(e?.message || e) }; }
}
