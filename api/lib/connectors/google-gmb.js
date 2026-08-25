/**
 * api/lib/connectors/google-gmb.js — Google Business Profile reviews connector
 * ════════════════════════════════════════════════════════════════════════════
 * Pulls a salon's REAL Google reviews via the Business Profile API and feeds
 * them into the review syndication pipeline (review_queue → branded cards →
 * Facebook/Instagram). This is the compliant way to "use GMB reviews": Google
 * reviews are imported and re-published on channels where the salon owns the
 * feed. Yelp has no write API, so reviews can never be pushed to Yelp — but
 * real GMB reviews can populate the salon's Facebook/Instagram accounts.
 *
 *   OAuth: same Google OAuth shape as google-calendar.js, but with the
 *   business.manage scope (the Business Profile API permission).
 *   Read:   GET https://mybusiness.googleapis.com/v1/accounts/{a}/locations/{l}/reviews
 *
 * Note: accounts/locations discovery is optional — a tenant with one business
 * will have one account and one location, which listReviews resolves
 * automatically. Integrations row provider id: 'google_gmb'.
 */

export const META = {
  name: 'Google reviews (Business Profile)',
  description: 'Import real Google reviews and auto-publish them as branded cards.',
  status: 'available',
  docs: 'https://developers.google.com/my-business'
};

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const API = 'https://mybusiness.googleapis.com/v1';

export function getAuthUrl(state){
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=google_gmb`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code){
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=google_gmb`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code'
    })
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Google OAuth failed');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    raw: data
  };
}

export async function refreshToken(refresh_token){
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Google refresh failed');
  return { access_token: data.access_token, expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString() };
}

function authHeaders(integration){
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${integration.access_token}` };
}

// Star rating is an enum on the Business Profile API: ONE..FIVE.
function ratingToNumber(r){
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[r] || null;
}

/**
 * Resolve the tenant's account + location. A salon normally has one of each;
 * if there are several, the first account and first location are used (the
 * import endpoint reports counts so owners can tell).
 */
export async function discoverLocation(integration){
  const acc = await fetch(`${API}/accounts`, { headers: authHeaders(integration) });
  const accData = await acc.json().catch(() => ({}));
  if(!acc.ok) throw new Error(accData?.error?.message || 'Google accounts lookup failed');
  const account = (accData.accounts || [])[0];
  if(!account) throw new Error('No Google Business Profile account found for this Google account');
  const accountId = account.name.split('/').pop();

  const loc = await fetch(`${API}/accounts/${accountId}/locations?pageSize=50`, { headers: authHeaders(integration) });
  const locData = await loc.json().catch(() => ({}));
  if(!loc.ok) throw new Error(locData?.error?.message || 'Google locations lookup failed');
  const location = (locData.locations || [])[0];
  if(!location) throw new Error('No Google Business Profile location found for this account');

  return {
    accountId,
    locationId: location.name.split('/').pop(),
    accountName: account.accountName || null,
    locationName: location.locationName || location.title || null
  };
}

/**
 * List the tenant's Google reviews, newest first.
 * @returns {Promise<Array<{rating:number,author:string,body:string,created_at:string|null}>>}
 */
export async function listReviews(integration){
  const { accountId, locationId } = await discoverLocation(integration);
  const url = `${API}/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50&orderBy=createTime desc`;
  const r = await fetch(url, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data?.error?.message || 'Google reviews lookup failed');

  return (data.reviews || []).map(rev => ({
    reviewId: rev.name || null,
    rating: ratingToNumber(rev.starRating),
    author: rev.reviewer?.displayName || 'Google reviewer',
    body: rev.comment || '',
    created_at: rev.createTime || null,
    raw: rev
  }));
}

/**
 * Post a public reply to a Google review. `reviewId` is the review's full
 * resource name (accounts/…/locations/…/reviews/…) as returned by
 * listReviews. This is the ONLY remaining Google surface a business can
 * automate — Google retired Business Messages (chat from Maps) on 2024-07-31,
 * so replying to reviews is how Lola "answers" customers on Google.
 */
export async function replyToReview(integration, reviewId, comment){
  const r = await fetch(`${API}/${reviewId}:updateReply`, {
    method: 'POST',
    headers: { ...authHeaders(integration), 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: { comment } })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data?.error?.message || 'Google review reply failed');
  return data;
}

// Adapter-contract stubs so the aggregator registry never chokes if a tenant
// has a google_gmb integration listed alongside booking providers. GMB is a
// reviews-only connector: it never reads/writes appointments.
export async function listAppointments(){ return []; }
export async function createAppointment(){ throw new Error('google_gmb is a reviews connector — it does not manage appointments'); }
export async function listClients(){ return []; }

export default { META, getAuthUrl, exchangeCode, refreshToken, discoverLocation, listReviews, replyToReview };
