// Lola reads the salon's Google Maps listing and Instagram, ranks it against
// the salons around it, and turns it into money moves. Places API mocked.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.GOOGLE_PLACES_API_KEY = 'gk';
const seen = [];
const PLACE = { id: 'ChIJmma123456789', displayName: { text: 'MMA Salon' }, formattedAddress: '1 Ocean Dr, Miami Beach, FL', location: { latitude: 25.78, longitude: -80.13 },
  rating: 4.8, userRatingCount: 120, nationalPhoneNumber: '(305) 555-0000', websiteUri: null, googleMapsUri: 'https://maps.google.com/?cid=1', photos: [{}, {}, {}], primaryType: 'hair_salon',
  regularOpeningHours: { weekdayDescriptions: ['Monday: Closed', 'Tuesday: 10:00 AM – 7:00 PM'] },
  reviews: [{ rating: 5, text: { text: 'Best balayage in Miami, Ana is magic.' }, relativePublishTimeDescription: 'a week ago' }, { rating: 4, text: { text: 'Great color, parking is hard.' } }] };
const NEAR = [{ id: 'ChIJmma123456789', displayName: { text: 'MMA Salon' }, rating: 4.8, userRatingCount: 120 },
  { id: 'ChIJother00000001', displayName: { text: 'Glow Studio' }, rating: 4.9, userRatingCount: 610 },
  { id: 'ChIJother00000002', displayName: { text: 'Cut Bar' }, rating: 4.3, userRatingCount: 45 }];
let llmText = 'HEADLINE: Your balayage is the draw — put it front and center.\nLOVED:\n- Balayage\n- Ana\nFIX:\n- Parking directions\nPOSTS:\n- Before/after balayage\n- Meet Ana\n- Parking tips';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); seen.push(u);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('places:searchText')) return J({ places: [{ id: PLACE.id }] });
  if (u.includes('places:searchNearby')) return J({ places: NEAR });
  if (u.includes('places.googleapis.com/v1/places/')) return J(PLACE);
  if (u.includes('instagram.com')) return new Response('<meta property="og:description" content="2,345 Followers, 10 Following, 311 Posts - See Instagram photos and videos from MMA Salon (&#064;mmasalon)">', { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('chat/completions')) {
    const b = JSON.parse(init.body || '{}'); const sys = b.messages?.[0]?.content || '';
    if (/STRICT JSON/.test(sys)) return J({ choices: [{ message: { content: JSON.stringify({ summary: 'A Miami Beach color salon.', tone: 'warm', services: [{ name: 'Balayage', price: 250, duration_min: 180 }], team: [{ name: 'Ana', role: 'Colorist' }], marketing: { opportunities: ['Own balayage'] } }) } }] });
    return J({ choices: [{ message: { content: llmText } }] });
  }
  return J({});
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TID = '00000000-0000-4000-8000-0000000000cc', DAY = 864e5, now = Date.now();
globalThis.__authUsers = { tok: { id: 'u1', email: 'owner@salon.com' } };
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', owner_email: 'owner@salon.com', subscription_status: 'active', phone_number: '+13055550100' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
T.tenant_numbers = []; T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York' }];
T.services = []; T.staff = []; T.staff_schedules = []; T.staff_time_off = []; T.blocked_slots = []; T.lola_fill_plans = [];
T.clients = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, tenant_id: TID, first_name: 'C' + i, phone: '+1305555000' + i }));
T.bookings = T.clients.map((cl, i) => ({ id: 'b' + i, tenant_id: TID, client_id: cl.id, status: 'completed', total_amount: 200, start_time: new Date(now - (200 + i) * DAY).toISOString(), end_time: new Date(now - (200 + i) * DAY + 3600e3).toISOString() }));

const gp = await import(P + 'lib/google-places.js');
const ig = await import(P + 'lib/instagram-read.js');
// 1) Links
let p = gp.parseMapsUrl('https://www.google.com/maps/place/MMA+Salon/@25.7801,-80.1301,17z/data=!3m1!4b1!4m6!3m5!1s0x88d9:0x1!8m2!3d25.78!4d-80.13');
ok(p.name === 'MMA Salon' && p.lat === 25.78 && p.lng === -80.13, 'a full Maps link gives the name and the pin');
ok(gp.parseMapsUrl('https://maps.google.com/?q=MMA+Salon+Miami').query === 'MMA Salon Miami', 'a ?q= link gives the search');
ok(gp.parseMapsUrl('https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJabcdefghijk').placeId === null || true, 'odd links never throw');
ok(ig.igHandle('https://www.instagram.com/mmasalon/?hl=en') === 'mmasalon' && ig.igHandle('@MMASalon') === 'mmasalon' && ig.igHandle('instagram.com/p/xyz') === null, 'Instagram handle from a link or @name');
const d = ig.parseIgDescription('1.2K Followers, 5 Following, 88 Posts - See Instagram photos and videos from Studio (@studio)');
ok(d.followers === 1200 && d.posts === 88 && d.name === 'Studio', 'Instagram counts read (1.2K → 1,200)');

// 2) Onboarding: a Maps link + Instagram alone is enough to learn the salon
const run = async (mod, { method = 'POST', body = {}, query = {} } = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method, url: '/api/' + mod, headers: { authorization: 'Bearer tok' }, query, body }, res); }); };
let r = await run('onboarding/learn.js', { body: { maps_url: 'https://www.google.com/maps/place/MMA+Salon/@25.78,-80.13,17z', instagram: '@mmasalon' } });
const t = T.tenants[0], k = JSON.parse(t.knowledge || '{}');
ok(r.ok && r.status === 200, 'learned from the Maps link alone: ' + (r.say || r.error || '').slice(0, 140));
ok(k.google?.place_id === PLACE.id && k.google.rating === 4.8 && k.google.reviews_count === 120 && k.google.competitors.length === 2, 'listing + neighbors saved to Lola’s knowledge');
ok(t.google_review_url === `https://search.google.com/local/writereview?placeid=${PLACE.id}`, 'Google review link set → review requests go live');
ok(t.location === '1 Ocean Dr, Miami Beach, FL' && /Tuesday/.test(t.hours || ''), 'address and hours filled from Google');
ok(k.instagram === 'mmasalon' && k.instagram_profile?.followers === 2345, 'Instagram audience read');
ok(/Google Maps/.test(r.say) && /4\.8★/.test(r.say) && /#2 of 3/.test(r.say) && /review requests/.test(r.say), 'Lola tells the owner where they stand');
ok(r.growth && r.growth.moves.length >= 1 && r.growth.google?.rank === 2, 'the growth plan comes back with onboarding');

// 3) The brief
T.tenants[0].knowledge = JSON.stringify({ ...JSON.parse(T.tenants[0].knowledge), growth_brief: null });
const n0 = seen.filter(u => u.includes('places.googleapis')).length;
r = await run('growth-brief.js', { method: 'GET' });
const b = r.brief;
ok(r.ok && b && b.google.rank === 2 && b.google.of === 3 && b.google.leader.name === 'Glow Studio', 'rank vs the salons around: #2 of 3, Glow Studio leads');
ok(seen.filter(u => u.includes('places.googleapis')).length === n0, 'fresh listing is not re-bought from Google');
const keys = b.moves.map(m => m.key);
ok(keys.includes('listing_phone') && b.moves.find(m => m.key === 'listing_phone').fix.includes('+13055550100'), 'Google “Call” goes to the old number → move: put Lola’s line on the listing');
ok(keys.includes('listing_booking') && keys.includes('listing_photos'), 'no website / few photos → listing fixes');
ok(keys.includes('win_back') && b.moves.find(m => m.key === 'win_back').impact_usd === Math.round(6 * 0.06 * b.business.avg_ticket), 'win-back sized from the real book (6 lapsed × 6% × avg ticket)');
ok(b.moves.find(m => m.key === 'reviews')?.done === true, 'review engine already on → shown as done, ranked last');
ok(keys.includes('instagram') && /2,345/.test(b.moves.find(m => m.key === 'instagram').why), 'Instagram move uses the real audience');
ok(b.voice && b.voice.loved.includes('Balayage') && b.voice.posts.length === 3 && /balayage/i.test(b.headline), 'Lola’s read of the reviews (Telnyx brain, labeled prose)');
ok(typeof b.score === 'number' && b.score > 0 && b.score <= 100, 'visibility score ' + b.score);
ok(b.moves.every(m => m.impact_usd == null || m.basis), 'every dollar figure says what it is based on');
r = await run('growth-brief.js', { method: 'GET' });
ok(r.brief.cached === true, 'cached for the day');

// 4) The switch
T.tenants[0].google_review_url = null; T.tenants[0].review_requests = false;
r = await run('growth-brief.js', { body: { action: 'enable_reviews' } });
ok(r.ok && T.tenants[0].google_review_url && T.tenants[0].review_requests === true, 'one tap turns Google review requests on');
ok(r.brief?.voice?.loved?.length, 'quick rebuild keeps Lola’s review read');

// 5) Brain down → still a full plan
llmText = '';
const { growthBrief } = await import(P + 'lib/growth-brief.js');
const b2 = await growthBrief(T.createClient ? T.createClient() : (await import(P + 'lib/db.js')).db(), T.tenants[0], { refresh: true, save: false });
ok(b2.moves.length > 0 && b2.headline, 'brain unavailable → the numbers and moves still come');

// 6) No Google key → the link is kept, the owner is told
delete process.env.GOOGLE_PLACES_API_KEY;
T.tenants[0].gmb_url = null;
r = await run('onboarding/learn.js', { body: { maps_url: 'https://maps.app.goo.gl/abc' } });
ok(!r.ok && /saved your Google Maps link/.test(r.say) && T.tenants[0].gmb_url === 'https://maps.app.goo.gl/abc', 'no Places key → link saved, clear next step');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
