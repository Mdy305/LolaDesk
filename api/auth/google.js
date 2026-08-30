/**
 * GET /api/auth/google
 * Begins a Google OAuth sign-in. Redirects the browser to Supabase's Google
 * consent URL, which returns to /oauth-callback.html with the access/refresh
 * tokens in the URL fragment (implicit flow).
 */
import { googleAuthUrl } from '../lib/auth.js';

function appUrl(){
  return (process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
}

export default async function handler(req, res){
  if(req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try{
    // redirectTo must be a clean, allow-listed URL (no query params) so the
    // implicit flow's token fragment is the only thing Supabase appends.
    const redirectTo = `${appUrl()}/oauth-callback.html`;
    const authUrl = await googleAuthUrl(redirectTo);
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }catch(e){
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
