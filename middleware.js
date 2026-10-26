/**
 * middleware.js — what a staff sign-in can reach. One gate, in front of every API.
 * ════════════════════════════════════════════════════════════════════════════
 * Staff sign-ins are invited by the owner (api/team-invite.js), which tags them
 * in Supabase app_metadata: { loladesk_role: 'staff' }. That tag rides inside
 * every access token they get. Owners are never tagged, so for an owner this
 * gate does nothing at all.
 *
 * For a tagged token, the API is CLOSED unless the route is on STAFF_ALLOW:
 * the calendar, clients, calls, messages and checkout. Billing, phone numbers,
 * settings, the team, integrations, bulk import, campaigns and Lola's owner
 * chat stay closed, including every route added in the future until someone
 * decides to open it here.
 *
 * The token is decoded, not verified: the gate only ever REMOVES access. A
 * forged token without the tag still has to pass Supabase in the route itself.
 */
export const config = { runtime: 'nodejs', matcher: ['/api/:path*'] };

// Every method, unless a method list is given. Paths are exact or end in '/' (prefix).
export const STAFF_ALLOW = [
  ['/api/auth/'],
  ['/api/health'],
  ['/api/widget/'],
  ['/api/speak-lola', ['GET']],
  ['/api/lola/hear', ['POST']],
  ['/api/lola/pulse', ['GET']],
  ['/api/lola/away', ['GET']],
  ['/api/calendar'],
  ['/api/calendar/'],
  ['/api/calendar-owner'],          // rule overrides are refused inside for non-managers
  ['/api/appointments'],
  ['/api/appointments/'],
  ['/api/salon'],                    // writes limited below (no staff, services, products)
  ['/api/clients'],
  ['/api/clients/'],
  ['/api/crm'],
  ['/api/crm-notes'],
  ['/api/client-photo'],
  ['/api/staff', ['GET']],
  ['/api/staff-hours'],
  ['/api/services', ['GET']],
  ['/api/booking-settings', ['GET']],
  ['/api/calls'],
  ['/api/live-conversations'],
  ['/api/call-center/'],
  ['/api/inbox/'],
  ['/api/inbox-reply'],
  ['/api/email'],
  ['/api/notifications'],
  ['/api/action-center', ['GET']],
  ['/api/opportunities', ['GET']],
  ['/api/opportunity-event', ['POST']],
  ['/api/dashboard/', ['GET']],
  ['/api/data', ['GET']],            // resource limited below
  ['/api/pos/'],
  ['/api/customer-care', ['POST']], // "Contact support" from the account menu
];
// /api/data: what a team member sees, not the salon's revenue, integrations or team list.
export const STAFF_DATA = ['overview', 'bookings', 'calls', 'inbox', 'clients', 'calendar', 'services'];
// /api/salon writes that are the owner's: who works there, the menu, the shop.
export const SALON_OWNER_RESOURCES = ['staff', 'service', 'services', 'product', 'products', 'catalog', 'settings', 'resource', 'resources'];

export function claims(authorization) {
  const m = /^Bearer\s+([^.\s]+)\.([^.\s]+)\./.exec(String(authorization || ''));
  if (!m) return null;
  try {
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch { return null; }
}

export function isStaffToken(authorization) {
  const c = claims(authorization);
  return String(c?.app_metadata?.loladesk_role || '').toLowerCase() === 'staff';
}

export function staffMayCall(path, method, { resource = '' } = {}) {
  const p = String(path || '').replace(/\/+$/, '') || '/';
  const m = String(method || 'GET').toUpperCase();
  if (m === 'OPTIONS') return true;
  const hit = STAFF_ALLOW.find(([route]) => (route.endsWith('/') ? (p + '/').startsWith(route) : p === route));
  if (!hit) return false;
  if (hit[1] && !hit[1].includes(m)) return false;
  if (p === '/api/data') return STAFF_DATA.includes(String(resource || 'overview').toLowerCase());
  if (p === '/api/salon' && m !== 'GET') return !SALON_OWNER_RESOURCES.includes(String(resource || '').toLowerCase());
  return true;
}

const FORBIDDEN = JSON.stringify({ ok: false, error: 'owner_only', message: 'Only the salon owner can do this. Ask them, or have them change your access in Team.' });

export default async function middleware(request) {
  const auth = request.headers.get('authorization');
  if (!auth || !isStaffToken(auth)) return;                 // owners and public calls: untouched
  const url = new URL(request.url);
  const resource = url.searchParams.get('resource') || '';
  let ok = staffMayCall(url.pathname, request.method, { resource });
  // /api/salon reads the resource from the body first: check that one too, never just the query.
  if (ok && url.pathname.replace(/\/+$/, '') === '/api/salon' && request.method !== 'GET') {
    let bodyResource = '';
    try { bodyResource = String((await request.clone().json())?.resource || ''); } catch { bodyResource = ''; }
    ok = staffMayCall(url.pathname, request.method, { resource: bodyResource });
  }
  if (ok) return;
  return new Response(FORBIDDEN, { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
