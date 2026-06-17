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

let _admin = null;
export function admin(){
  if(_admin) return _admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if(!url || !key) return null;
  _admin = createClient(url, key, { auth: { autoRefreshToken:false, persistSession:false } });
  return _admin;
}

// Create an auth user (email confirmed) and return it
export async function createUser({ email, password, name }){
  const a = admin(); if(!a) throw new Error('Auth not configured');
  const { data, error } = await a.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }
  });
  if(error) throw new Error(error.message);
  return data.user;
}

// Sign in with email+password -> returns session (access + refresh tokens)
export async function signIn({ email, password }){
  const a = admin(); if(!a) throw new Error('Auth not configured');
  const { data, error } = await a.auth.signInWithPassword({ email, password });
  if(error) throw new Error(error.message);
  return data; // { user, session }
}

// Verify an access token from the Authorization header -> the user
export async function getUserFromToken(token){
  const a = admin(); if(!a || !token) return null;
  const { data, error } = await a.auth.getUser(token);
  if(error) return null;
  return data.user;
}

export function bearer(req){
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
