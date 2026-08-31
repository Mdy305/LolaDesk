/**
 * api/lib/auth.js — Authentication for LolaDesk salon owners
 * ════════════════════════════════════════════════════════════════
 * Uses Supabase Auth (email + password). The service-role client can
 * create users and verify access tokens. Each salon owner gets one
 * auth user, linked to their tenant via tenant.owner_email + a
 * tenant_users mapping (owner_id).
 *
 * Sessions: we return Supabase access + refresh tokens to the browser,
 * stored in localStorage by the client, sent as Bearer on each request.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for db.js)
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let _admin = null;
export function admin(){
  if(_admin) return _admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if(!url || !key) return null;
  _admin = createClient(url, key, { auth: { autoRefreshToken:false, persistSession:false }, realtime: { transport: WebSocket } });
  return _admin;
}

let _client = null;
// Public (anon) client — the SAME key the browser receives. Supabase's anon
// role can only create users / start sign-ins; it cannot read or write tenant
// data, so embedding it server-side is safe. signUp below MUST use this path:
// admin.createUser never dispatches a confirmation email (email_confirm only
// marks a user confirmed) — which silently locks the owner out, the bug this
// replaced.
export function client(){
  if(_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url || !key) return null;
  _client = createClient(url, key, { auth: { autoRefreshToken:false, persistSession:false }, realtime: { transport: WebSocket } });
  return _client;
}

// Create an auth user and return it — through the STANDARD sign-up path
// (auth.signUp, the same call a browser client makes). On hosted Supabase the
// project's "Confirm email" setting is on, so the returned user arrives
// UNCONFIRMED with confirmation_sent_at set — the confirmation email genuinely
// dispatched — and sign-in stays blocked until the owner clicks the link. That
// closes the open-signup surface (a random address can't get a working
// session/tenant); activation happens on the first confirmed login.
export async function createUser({ email, password, name }){
  const c = client(); if(!c) throw new Error('Auth not configured');
  const { data, error } = await c.auth.signUp({ email, password, options: { data: { name } } });
  if(error) throw new Error(error.message);
  if(!data?.user) throw new Error('Could not create account');
  return data.user;
}

// Has this owner confirmed their email? The canonical field Supabase sets once
// the confirmation link is clicked.
export function isEmailConfirmed(user){
  return !!(user && (user.email_confirmed_at || user.emailConfirmedAt));
}

// Sign in with email+password -> returns session (access + refresh tokens)
export async function signIn({ email, password }){
  const a = admin(); if(!a) throw new Error('Auth not configured');
  const { data, error } = await a.auth.signInWithPassword({ email, password });
  if(error) throw new Error(error.message);
  return data; // { user, session }
}

// Start a Google OAuth sign-in from the server and return the authorization
// URL the browser must be redirected to. Uses the implicit flow so the tokens
// land in the URL fragment of `redirectTo` — they never touch server logs and a
// static page captures them into localStorage, matching how the email/password
// flow already stores its session. `redirectTo` must be allow-listed in
// Supabase Auth → URL Configuration.
export async function googleAuthUrl(redirectTo){
  const a = admin(); if(!a) throw new Error('Auth not configured');
  const { data, error } = await a.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      flowType: 'implicit',
      scopes: 'email profile',
      // access_type=offline + prompt=consent guarantees a refresh token even
      // when the owner has previously consented via Google.
      queryParams: { access_type: 'offline', prompt: 'consent' }
    }
  });
  if(error) throw new Error(error.message);
  return data.url;
}

// Verify an access token from the Authorization header -> the user
export async function getUserFromToken(token){
  // demo_token is a dev convenience AND a production backdoor (it authenticates
  // as a real owner). Only honor it when explicitly enabled. Never set
  // ALLOW_DEMO_TOKEN in production once real owners exist.
  if(token === 'demo_token'){
    // demo_token is a dev convenience AND a true production backdoor — it
    // authenticates as the real owner, meddy@mmasalon.com, with ZERO
    // credentials. Honor it ONLY when explicitly enabled AND we are NOT a
    // production deployment. Vercel sets VERCEL_ENV=production for prod;
    // NODE_ENV is the local fallback. This stays enforced even if
    // ALLOW_DEMO_TOKEN is misconfigured into the prod env — in production the
    // backdoor simply does not authenticate anyone.
    const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
    if(process.env.ALLOW_DEMO_TOKEN === '1' && !isProd) return { email: 'meddy@mmasalon.com', user_metadata: { name: 'Meddy' } };
    return null;
  }
  const a = admin(); if(!a || !token) return null;
  const { data, error } = await a.auth.getUser(token);
  if(error) return null;
  return data.user;
}

export function bearer(req){
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Platform-operator gate: is this email in the ADMIN_EMAILS allow-list?
// (comma-separated, case-insensitive). No env var set → nobody is admin.
// Shared by /api/admin and /api/admin/numbers so the two stay in lockstep.
export function isAdminEmail(email){
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}
