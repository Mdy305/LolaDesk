// Security pack 2: every public surface that could spend money, write a booking, read a secret or
// reach LolaDesk's own network now checks who is asking — while real owners, Telnyx and the website
// keep working exactly as before.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'svc-key'; process.env.TELNYX_API_KEY = 'tk';
process.env.ADMIN_EMAILS = 'boss@loladesk.com'; process.env.WIDGET_EMBED_SECRET = 'w-secret';
process.env.OWNER_LINE_NUMBER = '+13055550199';
delete process.env.LOLA_TOOL_SECRET; delete process.env.VERCEL_ENV; delete process.env.NODE_ENV; delete process.env.TELNYX_PUBLIC_KEY;
delete process.env.LOLA_VOICE_SECRET; delete process.env.FILL_GAP_REQUIRE_SIG;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  seen.push(u);
  if (u.includes('available_phone_numbers')) return J({ data: [{ phone_number: '+13055550777' }] });
  if (u.includes('api.telnyx.com/v2/phone_numbers')) return J({ data: [{ id: 'n1', phone_number: '+13055550111', status: 'active' }, { id: 'n2', phone_number: '+13055550199', status: 'active' }] });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'SUMMARY:\nA salon.' } }] });
  if (u.startsWith('https://redir.example')) return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal' } });
  if (u.startsWith('https://site.example')) return new Response('<html><title>Salon</title>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const A = '11111111-1111-4111-8111-111111111111';
T.tenants = [{ id: A, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon-a.com', subscription_status: 'active' }];
T.tenant_users = [{ user_id: 'u-owner', tenant_id: A, role: 'owner', status: 'active' }];
for (const k of ['tenant_numbers', 'platform_settings', 'tenant_number_ports', 'clients', 'bookings', 'fill_gap_attempts', 'calls', 'demo_requests', 'conversations', 'messages', 'usage_events', 'client_memories', 'client_memory', 'services', 'staff', 'booking_settings', 'integrations', 'leads']) T[k] = [];
T.platform_settings = [{ key: 'customer_care', value: { number: '+13055550111' } }];
globalThis.__authUsers = { owner: { id: 'u-owner', email: 'owner@salon-a.com' }, boss: { id: 'u-admin', email: 'boss@loladesk.com' } };
const P = new URL('../../api/', import.meta.url).href;
const mkRes = (resolve) => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); return this; }, send(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode }); } });
const run = async (mod, req = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { Promise.resolve(h({ method: 'POST', headers: {}, query: {}, url: '/api/' + mod, ...req }, mkRes(resolve))).catch((e) => resolve({ status: 'threw', body: String(e?.message || e) })); }); };
const formReq = (body, extra = {}) => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, query: {}, url: '/x', ...extra });
const runStream = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { Promise.resolve(h(req, mkRes(resolve))).catch((e) => resolve({ status: 'threw', body: String(e) })); }); };
const auth = (t) => ({ authorization: 'Bearer ' + t });

// ── 1. Numbers: owners can't take LolaDesk's own lines or buy unlimited numbers ──
let r = await run('provision-number.js', { method: 'GET', headers: auth('owner') });
ok(r.body.ok && r.body.owned.every((n) => n.phone_number !== '+13055550199' && n.phone_number !== '+13055550111'), 'the free pool offered to owners never lists the owner line or the support line');
r = await run('provision-number.js', { headers: auth('owner'), body: { use_existing: true, phone_number: '+13055550199' } });
ok(r.status === 403, 'an owner cannot attach LolaDesk’s owner line');
r = await run('provision-number.js', { headers: auth('owner'), body: { use_existing: true, phone_number: '+13055550111' } });
ok(r.status === 403, 'nor the customer-care line from platform_settings');
r = await run('provision-number.js', { headers: auth('owner'), body: { use_existing: true, phone_number: '+12125550123' } });
ok(r.status === 403, 'nor any number outside the free pool');
r = await run('provision-number.js', { headers: auth('owner'), body: { additional: true, areaCode: '305' } });
ok(r.status === 403, 'buying additional numbers is admin-only');

// ── 2. Telnyx signatures: a missing key never takes calls down; strict mode refuses ──
const wv = await import(P + 'lib/telnyx-webhook-verify.js');
const ts = await import(P + 'lib/telnyx-signature.js');
process.env.VERCEL_ENV = 'production';
ok(wv.verifyTelnyxSignature({ headers: {} }, '{}') === true && ts.verifyTelnyxSignature({ rawBody: '{}' }).ok === true, 'no TELNYX_PUBLIC_KEY in production: calls and texts keep flowing (status asks for the key)');
process.env.TELNYX_REQUIRE_SIGNATURE = '1';
ok(wv.verifyTelnyxSignature({ headers: {} }, '{}') === false && ts.verifyTelnyxSignature({ rawBody: '{}' }).ok === false, 'TELNYX_REQUIRE_SIGNATURE=1 without a key: every webhook is refused');
delete process.env.TELNYX_REQUIRE_SIGNATURE; delete process.env.VERCEL_ENV;
{ const wb = await import(P + 'lib/webhook-body.js'); const crypto2 = await import('node:crypto'); const kp = crypto2.generateKeyPairSync('ed25519');
  process.env.TELNYX_PUBLIC_KEY = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  ok(wb.checkTelnyxSignature({ headers: {} }, { raw: 'a=1', parsed: {} }, { texml: true }).ok === true, 'a TeXML call script without signature headers is still answered');
  ok(wb.checkTelnyxSignature({ headers: { 'telnyx-signature-ed25519': 'bad', 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) } }, { raw: 'a=1', parsed: {} }, { texml: true }).ok === false, 'a TeXML request with a forged signature is refused');
  ok(wb.checkTelnyxSignature({ headers: {} }, { raw: '{}', parsed: {} }).ok === false, 'an unsigned text webhook is refused once the key is set');
  delete process.env.TELNYX_PUBLIC_KEY; }

// ── 3. Text-to-speech: a made-up Bearer is just an anonymous caller ──
const vg = await import(P + 'lib/voice-guard.js');
let n = 0; for (let i = 0; i < 35; i++) if (await vg.allowSpeech({ headers: { 'x-forwarded-for': '7.7.7.7', authorization: 'Bearer ' + 'z'.repeat(30) } })) n++;
ok(n === 30, `fake Bearer tokens are held to the anonymous per-address cap (${n}/35)`);
ok(await vg.allowSpeech({ headers: { 'x-forwarded-for': '7.7.7.7', authorization: 'Bearer owner' } }), 'a verified owner still speaks');
ok(await vg.speechUser({ headers: { authorization: 'Bearer ' + 'z'.repeat(30) } }) === null, 'speak-lola only honours voice_id for a verified user');

// ── 4 + 10. Marketer and SSRF ──
r = await run('marketer.js', { headers: { 'x-forwarded-for': '6.6.6.1' }, body: { action: 'analyze', url: 'https://site.example' } });
ok(r.status === 401, 'Marketer analyze needs a signed-in owner');
r = await run('marketer.js', { headers: { 'x-forwarded-for': '6.6.6.1' }, body: { action: 'campaign', type: 'x' } });
ok(r.status === 401, 'Marketer campaign needs a signed-in owner');
seen.length = 0;
r = await run('marketer.js', { headers: { ...auth('owner'), 'x-forwarded-for': '6.6.6.2' }, body: { action: 'analyze', url: 'http://169.254.169.254/latest/meta-data/' } });
ok(!seen.some((u) => u.includes('169.254.169.254')), 'Marketer never fetches the cloud metadata address');
r = await run('marketer.js', { headers: { ...auth('owner'), 'x-forwarded-for': '6.6.6.2' }, body: { action: 'analyze', url: 'http://127.0.0.1:5432/' } });
ok(!seen.some((u) => u.includes('127.0.0.1')), 'nor localhost');
let lim = 0; for (let i = 0; i < 8; i++) { r = await run('marketer.js', { headers: { 'x-forwarded-for': '6.6.6.3' }, body: { action: 'strategy' } }); if (r.status === 429) lim++; }
ok(lim >= 3, 'anonymous strategy requests are rate limited per address');
const sf = await import(P + 'lib/safe-fetch.js');
ok(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'].every(sf.isBlockedAddress), 'private, loopback, link-local, metadata, CGNAT and IPv4-mapped addresses are blocked');
ok(!sf.isBlockedAddress('93.184.216.34') && !sf.isBlockedAddress('2606:4700::1'), 'public addresses are allowed');
let threw = null; try { await sf.assertPublicUrl('https://evil.example/', { lookup: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] }); } catch (e) { threw = e; }
ok(threw?.code === 'private_address', 'a hostname with ANY private address is refused (DNS checked, all records)');
threw = null; try { await sf.assertPublicUrl('file:///etc/passwd'); } catch (e) { threw = e; }
ok(threw?.code === 'bad_protocol', 'only http/https');
threw = null; try { await sf.safeFetch('https://redir.example/'); } catch (e) { threw = e; }
ok(threw?.code === 'private_address', 'a redirect to a private address is refused on the next hop');
const okRes = await sf.safeFetch('https://site.example/');
ok(okRes.ok && /Salon/.test(await okRes.text()), 'a normal public page still loads');
threw = null; try { await sf.safeFetch('https://site.example/', { maxBytes: 5 }); } catch (e) { threw = e; }
ok(threw?.code === 'too_large', 'responses are size-capped');
const ical = await import(P + 'lib/connectors/ical.js');
threw = null; try { await ical.fetchIcs('http://169.254.169.254/latest'); } catch (e) { threw = e; }
ok(threw && !seen.some((u) => u.includes('169.254.169.254')), 'calendar links go through the same SSRF guard');
const bl = await import(P + 'lib/business-learn.js');
threw = null; try { await bl.readWebsite('http://10.0.0.7/'); } catch (e) { threw = e; }
ok(!seen.some((u) => u.includes('10.0.0.7')), 'business-learn never reads a private address');

// ── 5. Website widget booking goes through the public booking core (rate limited) ──
let got429 = false; for (let i = 0; i < 14; i++) { r = await run('widget/book.js', { headers: { 'x-forwarded-for': '5.5.5.5' }, query: { tenant: 'salon-a' }, body: { service_id: 'nope', start_iso: new Date(Date.now() + 864e5).toISOString(), client: { phone: '+13055550001', first_name: 'Eve' } } }); if (r.status === 429) got429 = true; }
ok(got429, '/api/widget/book is rate limited like the public booking page');
ok(!T.bookings.length, 'and an unknown service never writes a booking');

// ── 6. Phone booking tool needs LolaDesk's signed key ──
r = await run('lola/book-appointment.js', { body: { to_number: '+13055550100', from_number: '+13055550002', service_id: 's', start_iso: new Date().toISOString() } });
ok(r.status === 401, 'book-appointment refuses an unsigned caller (no LOLA_TOOL_SECRET set)');

// ── 7. Demo calls: per-address and daily caps ──
const cg = await import(P + 'lola/concierge.js');
let allowed = 0; for (let i = 0; i < 8; i++) if (!(await cg.demoCallCapped(null, '4.4.4.4'))) allowed++;
ok(allowed === 5, `demo calls from one address are capped (${allowed}/8 allowed per hour)`);
T.demo_requests = Array.from({ length: 200 }, (_, i) => ({ id: 'd' + i, phone_number: '+1305555' + String(1000 + i), ip: '9.' + i, created_at: new Date().toISOString() }));
ok(!!(await cg.demoCallCapped((await import(P + 'lib/db.js')).db(), '4.4.4.5')), 'and a platform-wide daily ceiling stops call floods from many addresses');
T.demo_requests = [];

// ── 8. Status: public view has no env map, ids or balances ──
const st = await import(P + 'status.js');
const pub = st.publicStatus({ ok: false, release: 'r1', settings: { TELNYX_API_KEY: true }, live: { database: true, assistant_id: 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', elevenlabs_left_pct: 4, brain_error: 'HTTP 402 x' }, healed: ['found (assistant-57f2d23e-48b1-4107-9811-c40b296f15b6)'], fixes: ['Lola can’t think (Telnyx said: HTTP 402 balance).'] });
ok(pub.release === 'r1' && pub.live.database === true && !('settings' in pub) && !('assistant_id' in pub.live) && !('elevenlabs_left_pct' in pub.live) && !JSON.stringify(pub).includes('57f2d23e'), 'public /api/status keeps release + yes/no probes, drops env names, ids and figures');

// ── 9. Debug endpoints are admin-only ──
for (const m of ['debug-lola.js', 'diagnose.js']) {
  r = await run(m, { method: 'GET' }); const a1 = r.status;
  r = await run(m, { method: 'GET', headers: auth('owner') }); const a2 = r.status;
  r = await run(m, { method: 'GET', headers: auth('boss') }); const a3 = r.status;
  ok(a1 === 401 && a2 === 403 && a3 !== 401 && a3 !== 403, `${m}: anonymous 401, owner 403, admin allowed`);
}

// ── 11. Voice session tokens: no default secret ──
const vst = await import(P + 'lib/voice-session-token.js');
threw = null; try { vst.issueVoiceToken({ userId: 'u', tenantId: 't' }); } catch (e) { threw = e; }
const forged = (() => { const base = ['u', 't', Date.now() + 6e4, 'ab'].join('.'); return base + '.' + crypto.createHmac('sha256', 'lola-voice-dev-only').update(base).digest('hex'); })();
ok(threw && vst.verifyVoiceToken(forged) === null, 'without LOLA_VOICE_SECRET nothing is issued and the old dev secret forges nothing');
r = await run('voice-relay.js', { method: 'GET', headers: { upgrade: 'websocket' } });
ok(r.status === 503, 'the relay refuses when its secret is unset');

// ── 12. Password reset needs the recovery-link session ──
r = await run('auth/reset.js', { headers: auth('owner'), body: { action: 'update', password: 'newpassword1' } });
ok(r.status === 403, 'an ordinary signed-in session cannot silently change the password');
const { isRecoverySession } = await import(P + 'auth/reset.js');
const jwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const nowS = Math.floor(Date.now() / 1000);
ok(isRecoverySession(jwt({ amr: [{ method: 'recovery', timestamp: nowS }] })) && isRecoverySession(jwt({ amr: [{ method: 'otp', timestamp: nowS }] })), 'the emailed recovery link session is accepted (reset.html flow unchanged)');
ok(!isRecoverySession(jwt({ amr: [{ method: 'password', timestamp: nowS }] })) && !isRecoverySession(jwt({ amr: [{ method: 'recovery', timestamp: nowS - 5 * 3600 }] })), 'a password session or a stale recovery is not');

// ── 13. Fill-gap callbacks: signed, and one outcome per call ──
const { fillGapKey } = await import(P + 'lib/callback-sign.js');
T.fill_gap_attempts = [{ id: 'att1', tenant_id: A, status: 'answered', client_phone: '+13055550003', client_name: 'Mia', gap_date: '2030-01-01', gap_start_time: '10:00', gap_duration_minutes: 60 }];
r = await runStream('webhooks/telnyx-fill-gap-response.js', formReq('Digits=1', { query: { attempt_id: 'att1', k: 'wrong' } }));
ok(T.fill_gap_attempts[0].status === 'answered', 'a forged key changes nothing');
r = await runStream('webhooks/telnyx-fill-gap-response.js', formReq('Digits=1', { query: { attempt_id: 'att1', k: fillGapKey('att1') } }));
const afterFirst = T.bookings.length; const firstStatus = T.fill_gap_attempts[0].status;
r = await runStream('webhooks/telnyx-fill-gap-response.js', formReq('Digits=1', { query: { attempt_id: 'att1', k: fillGapKey('att1') } }));
ok(firstStatus !== 'answered' && T.bookings.length === afterFirst && afterFirst <= 1, `replaying "1" never books twice (bookings: ${afterFirst} → ${T.bookings.length}, status ${firstStatus})`);
ok(afterFirst === 1 && T.fill_gap_attempts[0].status === 'booked', 'a yes on the call books the gap: ' + T.fill_gap_attempts[0].status);
T.fill_gap_attempts.push({ id: 'att2', tenant_id: A, status: 'answered', client_phone: '+13055550004', client_name: 'Zoe', gap_date: '2030-01-01', gap_start_time: '10:00', gap_duration_minutes: 60 });
r = await runStream('webhooks/telnyx-fill-gap-response.js', formReq('Digits=1', { query: { attempt_id: 'att2', k: fillGapKey('att2') } }));
ok(T.bookings.length === afterFirst && T.fill_gap_attempts[1].status === 'taken' && /grabbed/.test(String(r.body || '')), 'a second client saying yes to the same gap is not double-booked — she says it was just taken');
r = await runStream('webhooks/telnyx-fill-gap-status.js', formReq('CallStatus=completed&CallDuration=99', { query: { attempt_id: 'att1' } }));
ok(T.fill_gap_attempts[0].call_duration_sec == null, 'an unsigned status callback is ignored');
r = await runStream('webhooks/telnyx-fill-gap-status.js', formReq('CallStatus=completed&CallDuration=42', { query: { attempt_id: 'att1', k: fillGapKey('att1') } }));
ok(T.fill_gap_attempts[0].call_duration_sec === 42, 'the signed one updates the attempt');
const src = fs.readFileSync(new URL('../../api/lola/voice-fill-gap.js', import.meta.url), 'utf8');
ok(/k: fillGapKey\(attemptId\)/.test(src) && /telnyx-fill-gap-status\?attempt_id=.*&k=/.test(src), 'voice-fill-gap signs the URLs it gives Telnyx');
T.calls = [{ id: 'c1', telnyx_call_control_id: 'cc1', recording_audio_url: null }];
const { recordingKey } = await import(P + 'lib/callback-sign.js');
r = await runStream('webhooks/telnyx-recording.js', formReq('CallSid=cc1&RecordingUrl=https%3A%2F%2Fa.example%2Fr.mp3&RecordingStatus=completed', { query: { k: recordingKey() } }));
r = await runStream('webhooks/telnyx-recording.js', formReq('CallSid=cc1&RecordingUrl=https%3A%2F%2Fevil.example%2Fx.mp3&RecordingStatus=completed', { query: { k: recordingKey() } }));
ok(T.calls[0].recording_audio_url === 'https://a.example/r.mp3', 'a recording link is set once; a replay never replaces it');
r = await runStream('webhooks/telnyx-recording.js', formReq('CallSid=cc1&RecordingUrl=https%3A%2F%2Fa.example%2Fr.mp3', { query: { k: 'bad' } }));
ok(r.status === 401, 'a wrong recording key is refused');

// ── 14. Cron routes: only Authorization: Bearer CRON_SECRET ──
const { cronAuthorized } = await import(P + 'lib/cron-auth.js');
delete process.env.CRON_SECRET;
ok(!cronAuthorized({ headers: { authorization: 'Bearer undefined' } }), 'no CRON_SECRET → refused (never “Bearer undefined”)');
process.env.CRON_SECRET = 'cron-s';
ok(cronAuthorized({ headers: { authorization: 'Bearer cron-s' } }) && !cronAuthorized({ headers: { 'x-vercel-cron': '1' } }) && !cronAuthorized({ headers: {}, query: { secret: 'cron-s' } }), 'Bearer CRON_SECRET only: x-vercel-cron and ?secret= no longer pass');
for (const m of ['cron/rebook-nudge.js', 'cron/no-show-scan.js', 'weekly-report.js']) {
  r = await run(m, { method: 'GET', headers: { 'x-vercel-cron': '1' }, query: { secret: 'cron-s' } });
  const s1 = r.status;
  r = await run(m, { method: 'POST', headers: {} });
  ok(s1 === 401 && r.status === 401, `${m}: spoofed cron header / query secret / unauthenticated POST refused`);
}
const ns = fs.readFileSync(new URL('../../api/cron/no-show-scan.js', import.meta.url), 'utf8');
ok(!/\.rpc\([^)]*\)\.catch/.test(ns), 'no-show-scan no longer calls .catch on a Supabase builder');

// ── 15. No hard-coded fallback secrets ──
const wc = await import(P + 'widget-chat.js');
const keyWithEnv = wc.widgetKeyFor('salon-a');
ok(keyWithEnv === crypto.createHmac('sha256', 'w-secret').update('widget|salon-a').digest('hex').slice(0, 32), 'with WIDGET_EMBED_SECRET set, every pasted embed key is unchanged');
delete process.env.WIDGET_EMBED_SECRET; delete process.env.OPERATOR_TOOLS_SECRET;
ok(wc.widgetKeyFor('salon-a') !== crypto.createHmac('sha256', 'dev-only-secret-change-me').update('widget|salon-a').digest('hex').slice(0, 32), 'without it, the key is no longer computable from the source code');
process.env.WIDGET_EMBED_SECRET = 'w-secret';
const od = await import(P + 'lib/operator-db.js');
ok(od.tenantToolSecret('salon-a') !== crypto.createHmac('sha256', 'dev-only-secret-change-me').update('operator-tool:salon-a').digest('hex'), 'operator tool secret no longer derives from “dev-only-secret-change-me”');
const zb = await import(P + 'lib/zapier-bridge.js');
const hk = zb.hookKey(A);
ok(hk === crypto.createHmac('sha256', 'svc-key:zap-hook').update(A).digest('hex').slice(0, 32), 'Zapier hook keys are unchanged while the server key is set');
const ov = await import(P + 'lib/one-voice.js');
ok(ov.checkTextSig('hi', ov.signText('hi')) && !ov.checkTextSig('hi', crypto.createHmac('sha256', 'loladesk:lola-voice').update('hi').digest('base64url').slice(0, 22)), 'voice text signatures verify, and the old “loladesk” fallback forges nothing');

// ── 16. Owner email lookup is exact ──
const ta = await import(P + 'lib/tenant-access.js');
ok((await ta.resolveTenantForUser({ id: 'x1', email: '%@salon-a.com' })) === null, 'a wildcard email never resolves to another salon');
ok((await ta.resolveTenantForUser({ id: 'x2', email: 'OWNER@Salon-A.com' }))?.id === A, 'the real owner still resolves, case-insensitively');

// ── 17. Unsubscribe links are signed ──
T.clients = [{ id: 'cl1', tenant_id: A, email: 'mia@x.com', opted_out: false }];
const em = await import(P + 'email.js');
const unsub = em.createHandler({ db: (await import(P + 'lib/db.js')).db() });
const call = (q) => new Promise((resolve) => unsub({ method: 'GET', headers: {}, query: q }, mkRes(resolve)));
r = await call({ email: 'mia@x.com', tenant: A });
ok(r.status === 200 && T.clients[0].opted_out === false, 'an unsigned unsubscribe link changes nothing (same neutral 200)');
const { unsubscribeSig } = await import(P + 'lib/unsubscribe-sign.js');
const tpl = (await import(P + 'lib/email-templates.js')).renderEmail('confirmation', { to: 'mia@x.com', tenantId: A });
ok(tpl.html.includes('sig=' + unsubscribeSig(A, 'mia@x.com')) && tpl.text.includes('sig='), 'every email carries the signed link');
r = await call({ email: 'mia@x.com', tenant: A, sig: unsubscribeSig(A, 'mia@x.com') });
ok(T.clients[0].opted_out === true, 'the signed link unsubscribes');

// ── 18. Widget chat: rotating visitor_id doesn't dodge the brake ──
let blocked = false; for (let i = 0; i < 32; i++) { r = await run('widget-chat.js', { headers: { 'x-forwarded-for': '3.3.3.3' }, body: { slug: 'salon-a', key: keyWithEnv, visitor_id: 'v' + i, message: 'hi' } }); if (r.status === 429) blocked = true; }
ok(blocked, 'a new visitor_id per message is still limited per address');

// ── 19. Booking tool secret ──
process.env.BOOKING_TOOL_SECRET = 'bt-secret';
r = await run('telnyx-book-tool.js', { headers: { 'x-lola-booking-secret': 'bt-secreX' }, body: {} });
const wrong = r.status;
r = await run('telnyx-book-tool.js', { headers: { 'x-lola-booking-secret': 'bt-secret' }, body: {} });
ok(wrong === 401 && r.status === 400, 'telnyx-book-tool: wrong secret 401, right secret passes (constant-time compare)');

// ── 20. Deployment hygiene ──
const vi = fs.readFileSync(new URL('../../.vercelignore', import.meta.url), 'utf8');
ok(['*.bak', '*.sql', '/migrations/', '/sql/', '*.py', '/deploy.sh', '/docker-compose.yml', '/OpenMythos/', '/r4ven/', '/bat-security-toolkit/', '/copilot-worktrees/', '/macv7/', '/tests/'].every((p) => vi.split('\n').includes(p)) && !/^\/?api\/?$/m.test(vi) && !/^\*\.html$/m.test(vi) && !/^\*\.js$/m.test(vi), '.vercelignore keeps backups, SQL, scripts and side projects off the deployment — never api/ or the pages');
ok(!fs.readdirSync(new URL('../../', import.meta.url)).some((f) => f.endsWith('.bak')), 'no .bak backups at the repo root');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
