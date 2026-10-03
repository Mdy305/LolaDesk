/**
 * api/lib/messenger-dm.js — Lola answers each salon's Facebook Messenger.
 * ════════════════════════════════════════════════════════════════
 * Messenger Platform on the Graph API (same Meta app as Instagram):
 *   connect  → facebook.com/<v>/dialog/oauth (pages_show_list, pages_messaging,
 *              pages_manage_metadata; or a Facebook Login for Business
 *              configuration via FACEBOOK_CONFIG_ID) → code → user token →
 *              long-lived user token → /me/accounts (the owner's Pages with
 *              their Page tokens) → one Page: connected; several: the owner
 *              picks → POST /{page-id}/subscribed_apps (messages,
 *              messaging_postbacks) → Page token sealed in tenant_channels.
 *   webhook  → Meta POSTs object 'page' events (X-Hub-Signature-256 with the
 *              app secret); we route by Page id to the ONE salon that owns it;
 *              the same Lola (client-brain answerClient) answers with the same
 *              memory and booking hands, memory key fb:<PSID>; reply via the
 *              Send API (messaging_type RESPONSE); logged to the salon inbox.
 *   24 hours → Meta only allows a standard reply within 24h of the person's
 *              last message. Lola replies to an incoming message (always in
 *              the window). An owner reply outside the window is NOT sent
 *              (no promotional/out-of-window sends) — it is logged with a note.
 *
 * Env: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET (or FACEBOOK_APP_ID /
 *      FACEBOOK_APP_SECRET overrides), META_VERIFY_TOKEN or INSTAGRAM_VERIFY_TOKEN,
 *      optional FACEBOOK_CONFIG_ID (Facebook Login for Business configuration),
 *      INTEGRATION_ENCRYPTION_KEY (Page tokens are never stored in plaintext).
 */
import crypto from 'node:crypto';
import { appUrl } from './telnyx-client.js';
import { getOrStartConversation, getConversationHistory, logMessage, logUsage, setClientMemory, getClientMemory } from './db.js';
import { answerClient } from './client-brain.js';
import { sealToken, openToken, canSeal, saveChannelRow, holderOf, noteChannelError, TAKEN_SAY } from './channel-store.js';

/** The ONE Graph API version LolaDesk uses for Facebook. */
export const GRAPH_VERSION = 'v21.0';
export const FB_GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const FB_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
export const SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata';
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks';
const WINDOW_MS = 24 * 3600e3;
const PENDING_MS = 30 * 60e3;

export const fbAppId = () => String(process.env.FACEBOOK_APP_ID || process.env.INSTAGRAM_APP_ID || '');
const secret = () => String(process.env.FACEBOOK_APP_SECRET || process.env.INSTAGRAM_APP_SECRET || '');
export const verifyToken = () => String(process.env.META_VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN || '');
export const fbConfigured = () => !!(fbAppId() && secret());
// No query string: Meta matches the redirect URI exactly.
export const redirectUri = () => appUrl() + '/api/messenger';

// ── Signed state: which salon started the connect (30 minutes, can't be forged or reused for Instagram) ──
const stateSig = (body) => crypto.createHmac('sha256', secret() || 'x').update('fb:' + body).digest('hex').slice(0, 32);
export function signState(tenantId, now = Date.now()) {
  const body = `${tenantId}.${now}.${crypto.randomBytes(4).toString('hex')}`;
  return body + '.' + stateSig(body);
}
export function readState(state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return null;
  const [id, ts, nonce, sig] = parts;
  if (!id || !ts || !nonce || !sig || !secret()) return null;
  const want = stateSig(`${id}.${ts}.${nonce}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const age = now - Number(ts);
  if (!Number.isFinite(age) || age < -60e3 || age > PENDING_MS) return null;
  return id;
}
export function authUrl(tenantId) {
  const q = new URLSearchParams({ client_id: fbAppId(), redirect_uri: redirectUri(), state: signState(tenantId), response_type: 'code' });
  // Facebook Login for Business: a configuration carries the permissions; otherwise ask for them directly.
  if (process.env.FACEBOOK_CONFIG_ID) q.set('config_id', process.env.FACEBOOK_CONFIG_ID);
  else q.set('scope', SCOPES);
  return FB_DIALOG + '?' + q;
}
export function verifySignature(raw, header) {
  if (!secret()) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret()).update(raw).digest('hex');
  const got = String(header || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
// appsecret_proof on every token call (works whether or not "Require App Secret" is on).
const proof = (token) => crypto.createHmac('sha256', secret()).update(String(token)).digest('hex');
const withToken = (url, token) => url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token) + '&appsecret_proof=' + proof(token);

async function g(url, init) {
  const r = await fetch(url, init); const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) { const e = new Error(d?.error?.message || `Facebook ${r.status}`); e.code = d?.error?.code; e.subcode = d?.error?.error_subcode; throw e; }
  return d;
}

// ── Connect ─────────────────────────────────────────────────────
/** code → user token → long-lived user token → the owner's Pages. */
export async function pagesFromCode(code) {
  const q = new URLSearchParams({ client_id: fbAppId(), redirect_uri: redirectUri(), client_secret: secret(), code: String(code).replace(/#_=_$/, '') });
  const short = await g(`${FB_GRAPH}/oauth/access_token?${q}`);
  let userToken = short.access_token;
  try {
    const l = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: fbAppId(), client_secret: secret(), fb_exchange_token: userToken });
    const long = await g(`${FB_GRAPH}/oauth/access_token?${l}`);
    if (long.access_token) userToken = long.access_token;
  } catch (_) { /* the short token still lists the Pages */ }
  const pages = await listPages(userToken);
  return { userToken, pages };
}
export async function listPages(userToken) {
  const d = await g(withToken(`${FB_GRAPH}/me/accounts?fields=id,name,access_token,tasks&limit=100`, userToken));
  return (d.data || []).filter((p) => p && p.id && p.access_token);
}

/** Connect ONE Page to this salon: guard → subscribe → seal → save. */
export async function connectPage(c, tenantId, page) {
  if (!canSeal()) return { ok: false, reason: 'no_key', say: 'LolaDesk can’t store Facebook connections securely yet — the LolaDesk team has been told.' };
  const held = await holderOf(c, 'messenger', page.id);
  if (held && String(held.tenant_id) !== String(tenantId) && held.status === 'active') return { ok: false, reason: 'taken', taken: true, say: TAKEN_SAY };
  try {
    await g(withToken(`${FB_GRAPH}/${encodeURIComponent(page.id)}/subscribed_apps?subscribed_fields=${SUBSCRIBED_FIELDS}`, page.access_token), { method: 'POST' });
  } catch (e) {
    return { ok: false, reason: 'subscribe_failed', error: String(e?.message || e), say: 'Facebook didn’t let LolaDesk receive messages for that Page. Make sure you’re an admin of the Page, then try again.' };
  }
  const now = new Date().toISOString();
  const saved = await saveChannelRow(c, {
    tenant_id: tenantId, channel: 'messenger', account_id: String(page.id), username: page.name || null,
    access_token: sealToken(page.access_token), expires_at: null, status: 'active', updated_at: now, last_error: null,
    meta: { page_name: page.name || null, tasks: page.tasks || [], subscribed: true, subscribed_fields: SUBSCRIBED_FIELDS.split(','), connected_at: now }
  });
  if (!saved.ok) return { ok: false, reason: 'taken', taken: true, say: saved.say };
  // One Page per salon: any other Page this salon had live is switched off.
  try {
    const { data: rows } = await c.from('tenant_channels').select('account_id,status').eq('tenant_id', tenantId).eq('channel', 'messenger');
    for (const r of rows || []) if (String(r.account_id) !== String(page.id) && r.status === 'active') await c.from('tenant_channels').update({ status: 'disconnected', access_token: null, updated_at: now }).eq('channel', 'messenger').eq('account_id', r.account_id);
  } catch (_) {}
  await clearPending(c, tenantId);
  return { ok: true, page_id: String(page.id), name: page.name || null, say: `Facebook Messenger is connected for ${page.name || 'your Page'} — Lola is answering your messages now.` };
}

async function clearPending(c, tenantId) {
  try { await c.from('tenant_channels').delete().eq('channel', 'messenger_pending').eq('account_id', String(tenantId)); } catch (_) {}
}

/** The callback: one Page → connected; several → saved for the owner to pick (sealed user token, 30 min). */
export async function connectMessengerFromCode(c, tenantId, code) {
  if (!canSeal()) return { ok: false, reason: 'no_key', say: 'LolaDesk can’t store Facebook connections securely yet — the LolaDesk team has been told.' };
  const { userToken, pages } = await pagesFromCode(code);
  if (!pages.length) return { ok: false, reason: 'no_pages', say: 'I didn’t find a Facebook Page you manage. Create a Page for your salon (or ask its admin to add you), then connect again.' };
  if (pages.length === 1) return connectPage(c, tenantId, pages[0]);
  await saveChannelRow(c, {
    tenant_id: tenantId, channel: 'messenger_pending', account_id: String(tenantId), username: null,
    access_token: sealToken(userToken), expires_at: new Date(Date.now() + PENDING_MS).toISOString(), status: 'pending', updated_at: new Date().toISOString(),
    meta: { pages: pages.map((p) => ({ id: String(p.id), name: p.name || 'Page' })) }
  });
  return { ok: true, choose: true, pages: pages.map((p) => ({ id: String(p.id), name: p.name || 'Page' })), say: 'You manage a few Facebook Pages — which one is your salon?' };
}

/** The Pages waiting for the owner to pick (empty when none / expired). */
export async function pendingPages(c, tenantId, now = Date.now()) {
  try {
    const { data } = await c.from('tenant_channels').select('*').eq('channel', 'messenger_pending').eq('account_id', String(tenantId)).maybeSingle();
    if (!data || String(data.tenant_id) !== String(tenantId)) return [];
    if (data.expires_at && new Date(data.expires_at).getTime() < now) return [];
    return (data.meta && data.meta.pages) || [];
  } catch (_) { return []; }
}

/** The owner picked a Page (by id or by name). */
export async function choosePage(c, tenantId, { pageId = null, pageName = null } = {}, now = Date.now()) {
  let row = null;
  try { const { data } = await c.from('tenant_channels').select('*').eq('channel', 'messenger_pending').eq('account_id', String(tenantId)).maybeSingle(); row = data; } catch (_) {}
  if (!row || String(row.tenant_id) !== String(tenantId) || (row.expires_at && new Date(row.expires_at).getTime() < now)) {
    return { ok: false, reason: 'expired', say: 'That Facebook sign-in timed out. Let’s connect Facebook again — it takes a few seconds.' };
  }
  const list = (row.meta && row.meta.pages) || [];
  const want = list.find((p) => pageId && String(p.id) === String(pageId))
    || list.find((p) => pageName && String(p.name).toLowerCase() === String(pageName).toLowerCase())
    || list.find((p) => pageName && String(p.name).toLowerCase().includes(String(pageName).toLowerCase()));
  if (!want) return { ok: false, reason: 'unknown_page', pages: list, say: 'I don’t see that Page. Your Pages are: ' + list.map((p) => p.name).join(', ') + '.' };
  const userToken = openToken(row.access_token);
  if (!userToken) return { ok: false, reason: 'expired', say: 'That Facebook sign-in timed out. Let’s connect Facebook again.' };
  let pages = [];
  try { pages = await listPages(userToken); } catch (e) { return { ok: false, reason: 'expired', error: String(e?.message || e), say: 'Facebook asked to sign in again. Let’s connect Facebook again.' }; }
  const page = pages.find((p) => String(p.id) === String(want.id));
  if (!page) return { ok: false, reason: 'unknown_page', say: 'Facebook no longer lists that Page for you. Let’s connect Facebook again.' };
  return connectPage(c, tenantId, page);
}

export async function channelFor(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('account_id,username,status,expires_at,updated_at,last_error').eq('tenant_id', tenantId).eq('channel', 'messenger').eq('status', 'active').maybeSingle(); if (data) return data; } catch (_) {}
  try { const { data } = await c.from('tenant_channels').select('account_id,username,status,expires_at,updated_at,last_error').eq('tenant_id', tenantId).eq('channel', 'messenger').order('updated_at', { ascending: false }).limit(1).maybeSingle(); return data || null; } catch (_) { return null; }
}

export async function disconnect(c, tenantId) {
  try {
    const { data: rows } = await c.from('tenant_channels').select('*').eq('tenant_id', tenantId).eq('channel', 'messenger');
    for (const r of rows || []) {
      const tok = openToken(r.access_token);
      if (tok && r.status === 'active') { try { await g(withToken(`${FB_GRAPH}/${encodeURIComponent(r.account_id)}/subscribed_apps`, tok), { method: 'DELETE' }); } catch (_) {} }
      await c.from('tenant_channels').update({ status: 'disconnected', access_token: null, updated_at: new Date().toISOString() }).eq('channel', 'messenger').eq('account_id', r.account_id).eq('tenant_id', tenantId);
    }
  } catch (_) {}
  await clearPending(c, tenantId);
  return { ok: true };
}

// ── Send ────────────────────────────────────────────────────────
export async function sendMessage(pageId, token, psid, text, { messagingType = 'RESPONSE' } = {}) {
  return g(withToken(`${FB_GRAPH}/${encodeURIComponent(pageId)}/messages`, token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: String(psid) }, messaging_type: messagingType, message: { text: String(text).slice(0, 1990) } })
  });
}

/** The person writing in: a Messenger-keyed client (merged with their phone client once they give it). */
async function fbClient(c, tenantId, psid, token) {
  const key = 'fb:' + String(psid).slice(0, 60);
  let { data: client } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', key).maybeSingle();
  if (client?.notes && /^linked:\+\d+$/.test(client.notes)) {
    const { data: real } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', client.notes.slice(7)).maybeSingle();
    if (real) return { client: real, key: real.phone, phone: real.phone, fbClientId: client.id };
  }
  if (!client) {
    let first = 'Facebook', last = null;
    try { const p = await g(withToken(`${FB_GRAPH}/${encodeURIComponent(psid)}?fields=first_name,last_name`, token)); first = p.first_name || first; last = p.last_name || null; } catch (_) {}
    const { data } = await c.from('clients').insert({ tenant_id: tenantId, phone: key, first_name: first, last_name: last, updated_at: new Date().toISOString() }).select().maybeSingle();
    client = data;
  }
  return { client, key, phone: null, fbClientId: client?.id || null };
}

/** First time we see this Meta message id? (Meta retries deliveries.) */
async function firstTime(c, mid) {
  if (!mid) return true;
  const id = 'meta:' + String(mid).slice(0, 180);
  try {
    const seen = await c.from('telnyx_events').select('id').eq('id', id).maybeSingle().then((r) => r, () => ({ data: null }));
    if (seen?.data?.id) return false;
    const { error } = await c.from('telnyx_events').insert({ id, kind: 'messenger', created_at: new Date().toISOString() });
    if (!error) return true;
    return !(String(error.code) === '23505' || /duplicate|unique/i.test(String(error.message)));
  } catch (_) { return true; }
}

/** One webhook delivery from Meta (object 'page'). send/answer are injectable for tests. */
export async function handleMessengerEvent(c, event, { answer = answerClient, send = sendMessage, now = Date.now() } = {}) {
  const done = [];
  if (!event || event.object !== 'page') return done;
  for (const entry of event.entry || []) {
    for (const m of entry.messaging || []) {
      const text = m?.message?.text || m?.postback?.title || null;
      if (!text || m?.message?.is_echo || !m.sender?.id) continue;
      const pageId = String(m.recipient?.id || entry.id || '');
      if (String(m.sender.id) === pageId) continue;
      const { data: ch } = await c.from('tenant_channels').select('*').eq('channel', 'messenger').eq('account_id', pageId).eq('status', 'active').maybeSingle();
      if (!ch) { done.push({ skipped: 'unknown_page', pageId }); continue; }
      const token = openToken(ch.access_token); if (!token) { done.push({ skipped: 'no_token' }); continue; }
      if (!(await firstTime(c, m.message?.mid || (m.postback && m.postback.mid)))) { done.push({ skipped: 'duplicate' }); continue; }
      const { data: tenant } = await c.from('tenants').select('*').eq('id', ch.tenant_id).maybeSingle();
      if (!tenant) continue;
      const psid = String(m.sender.id);
      const who = await fbClient(c, tenant.id, psid, token);
      // The 24-hour window opens with every message they send.
      try { await setClientMemory(tenant.id, 'fb:' + psid, 'messenger', { psid, page_id: pageId, last_inbound_at: new Date(m.timestamp || now).toISOString() }); } catch (_) {}
      // They gave their number → link Messenger to their phone client (one person, one memory).
      const ph = String(text).match(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/);
      if (ph && !who.phone) {
        const e = `+1${ph[1]}${ph[2]}${ph[3]}`;
        try {
          const { data: real } = await c.from('clients').select('*').eq('tenant_id', tenant.id).eq('phone', e).maybeSingle();
          if (real && who.client?.id) { await c.from('clients').update({ notes: 'linked:' + e }).eq('id', who.client.id).eq('tenant_id', tenant.id); who.client = real; who.key = e; }
          who.phone = e;
        } catch (_) {}
      }
      let conv = null, history = [];
      try { conv = await getOrStartConversation(tenant.id, { clientId: who.client?.id, participant: who.client?.id ? undefined : 'fb:' + psid, channel: 'messenger', agent: 'lola' }); if (conv?.id) history = (await getConversationHistory(conv.id, 10)) || []; } catch (_) {}
      const tz = (await c.from('booking_settings').select('timezone').eq('tenant_id', tenant.id).maybeSingle().then((r) => r.data?.timezone).catch(() => null)) || 'America/New_York';
      const ans = await answer({ tenant, client: who.client, channel: 'messenger', text, history: history.filter((h) => typeof h.content === 'string'), phone: who.phone, memoryKey: who.key, tz });
      const reply = String(ans?.reply || '').trim() || 'Thanks for your message! What can I help you book?';
      try { await send(pageId, token, psid, reply, { messagingType: 'RESPONSE' }); }
      catch (e) {
        await noteChannelError(c, 'messenger', pageId, e?.message || e);
        if (/token|session|OAuth/i.test(String(e?.message)) || e?.code === 190) { try { await c.from('tenant_channels').update({ status: 'needs_reconnect' }).eq('channel', 'messenger').eq('account_id', pageId); } catch (_) {} }
        done.push({ error: String(e?.message || e) }); continue;
      }
      try {
        if (conv?.id) {
          await logMessage({ conversationId: conv.id, tenantId: tenant.id, role: 'user', agent: 'lola', content: text });
          await logMessage({ conversationId: conv.id, tenantId: tenant.id, role: 'assistant', agent: 'lola', content: reply });
          await c.from('conversations').update({ last_message: reply, unread: true }).eq('id', conv.id);
        }
        await logUsage(tenant.id, 'messenger_received', 1);
      } catch (_) {}
      done.push({ tenant: tenant.id, reply, memoryKey: who.key, actions: (ans?.actions || []).map((a) => a.tool) });
    }
  }
  return done;
}

/** When did this person last message the salon on Messenger? (ms, or null) */
export async function lastInboundAt(tenantId, fbKey) {
  try {
    const rows = await getClientMemory(tenantId, fbKey);
    const row = (rows || []).find((r) => r.key === 'messenger');
    const v = row && (typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    const t = v && v.last_inbound_at ? new Date(v.last_inbound_at).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  } catch (_) { return null; }
}

/** The owner replies to a Messenger thread from the LolaDesk inbox (24-hour window respected). */
export async function replyAsSalon(c, tenantId, clientId, text, { now = Date.now(), send = sendMessage } = {}) {
  const { data: cl } = await c.from('clients').select('id,phone').eq('id', clientId).eq('tenant_id', tenantId).maybeSingle();
  let key = cl && String(cl.phone || '').startsWith('fb:') ? cl.phone : null;
  if (!key && cl?.phone) {
    try { const { data: l } = await c.from('clients').select('phone,notes').eq('tenant_id', tenantId).eq('notes', 'linked:' + cl.phone); key = ((l || []).find((x) => String(x.phone || '').startsWith('fb:')) || {}).phone || null; } catch (_) {}
  }
  if (!key) return { ok: false, error: 'This client hasn’t messaged you on Facebook.' };
  const { data: ch } = await c.from('tenant_channels').select('account_id,access_token,status').eq('tenant_id', tenantId).eq('channel', 'messenger').eq('status', 'active').maybeSingle();
  const token = ch ? openToken(ch.access_token) : null;
  if (!token) return { ok: false, error: 'Facebook Messenger isn’t connected — Settings → Lola on Facebook Messenger.' };
  const last = await lastInboundAt(tenantId, key);
  if (!last || now - last > WINDOW_MS) return { ok: false, outside_window: true, error: 'Facebook only allows replies within 24 hours of their last message. Your note is saved in the thread; text or call them instead.' };
  try { await send(ch.account_id, token, key.slice(3), text, { messagingType: 'RESPONSE' }); return { ok: true }; }
  catch (e) { return { ok: false, error: /window|24|outside/i.test(String(e?.message)) ? 'Facebook only allows replies within 24 hours of their last message.' : 'Facebook didn’t accept the message. Try again in a moment.' }; }
}

/** Nightly: every live Page still has a working token and is still subscribed (re-subscribe when not). */
export async function checkMessengerPages(c) {
  const out = { checked: 0, resubscribed: 0, needs_reconnect: 0 };
  if (!fbConfigured()) return out;
  let rows = [];
  try { const { data } = await c.from('tenant_channels').select('*').eq('channel', 'messenger').eq('status', 'active'); rows = data || []; } catch (_) { return out; }
  for (const r of rows) {
    out.checked++;
    const tok = openToken(r.access_token);
    if (!tok) { out.needs_reconnect++; await noteChannelError(c, 'messenger', r.account_id, 'Page token unreadable', { status: 'needs_reconnect' }); continue; }
    try {
      const d = await g(withToken(`${FB_GRAPH}/${encodeURIComponent(r.account_id)}/subscribed_apps`, tok));
      const ours = (d.data || []).find((a) => String(a.id) === fbAppId());
      const fields = new Set((ours && ours.subscribed_fields) || []);
      if (!ours || !fields.has('messages')) {
        await g(withToken(`${FB_GRAPH}/${encodeURIComponent(r.account_id)}/subscribed_apps?subscribed_fields=${SUBSCRIBED_FIELDS}`, tok), { method: 'POST' });
        out.resubscribed++;
      }
      await noteChannelError(c, 'messenger', r.account_id, null, { meta: { ...(r.meta || {}), subscribed: true, checked_at: new Date().toISOString() } });
    } catch (e) {
      const dead = e?.code === 190 || /token|session|OAuth/i.test(String(e?.message));
      if (dead) out.needs_reconnect++;
      await noteChannelError(c, 'messenger', r.account_id, e?.message || e, dead ? { status: 'needs_reconnect' } : {});
    }
  }
  return out;
}
