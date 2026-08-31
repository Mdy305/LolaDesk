/**
 * tests/mfa-totp.test.mjs — owner MFA (TOTP) contract
 * Covers: TOTP math, the stateless challenge envelope, and the login gate
 * (registered + verified owner => second factor required; everyone else => the
 * existing frictionless session path, end-users/signup untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSecret, totp, validTOTP, otpauthUri,
  createChallenge, readChallenge, getRegistration, upsertRegistration,
  mfaRequiredFor, CHALLENGE_TTL_MS
} from '../api/lib/mfa.js';

// Minimal fake supabase client returning a single registration row.
function fakeClient(reg) {
  return {
    from() {
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: reg ?? null, error: null }) }; } };
        },
        upsert() { return { onConflict() { return { then: async () => ({ error: null }) }; } }; }
      };
    }
  };
}

// ── TOTP core ────────────────────────────────────────────────────────────────
test('generateSecret emits a valid base32 secret and uri', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{20,}$/);
  assert.ok(otpauthUri(secret, 'owner@salon.com').startsWith('otpauth://totp/LolaDesk:'));
  assert.match(otpauthUri(secret, 'owner@salon.com'), /secret=[A-Z2-7]+/);
});

test('totp returns a 6-digit code that validTOTP accepts (and rejects wrong ones)', () => {
  const secret = generateSecret();
  const code = totp(secret, Date.now());
  assert.match(code, /^\d{6}$/);
  assert.equal(validTOTP(secret, code), true);
  assert.equal(validTOTP(secret, '000000'), false, 'wrong code must fail');
  assert.equal(validTOTP(secret, '12345'), false, 'non-6-digit must fail');
});

test('totp is time-window tolerant (±1 step) and secret-sensitive', () => {
  const secret = generateSecret();
  const other = generateSecret();
  const now = Date.now();
  // a code 30s in the past is still accepted within the ±1 window
  const past = totp(secret, now - 30 * 1000);
  assert.equal(validTOTP(secret, past, now), true);
  // the same code is NOT valid for a different secret
  assert.equal(validTOTP(other, past, now), false);
});

// ── Stateless challenge envelope ─────────────────────────────────────────────
test('challenge round-trips and rejects tampering + expiry', async () => {
  process.env.MFA_CHALLENGE_KEY = 'test-challenge-key';
  try {
    const payload = { session: { access_token: 'abc' }, user: { email: 'o@x.com' }, tenant: { id: 't1' } };
    const ticket = createChallenge(payload, CHALLENGE_TTL_MS);
    assert.ok(ticket);
    const back = readChallenge(ticket);
    assert.equal(back.session.access_token, 'abc');
    assert.equal(back.tenant.id, 't1');
    assert.ok(back.exp > Date.now());

    // tamper -> null
    const flipped = ticket.slice(0, -4) + (ticket.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    assert.equal(readChallenge(flipped), null);

    // already-expired -> null
    const expired = createChallenge(payload, -1000);
    assert.equal(readChallenge(expired), null);
    // garbage -> null
    assert.equal(readChallenge('not-a-ticket'), null);
  } finally {
    delete process.env.MFA_CHALLENGE_KEY;
  }
});

// ── login gate ───────────────────────────────────────────────────────────────
test('owner WITHOUT a registration keeps the frictionless session path', async () => {
  const required = await mfaRequiredFor('fresh@salon.com', fakeClient(null));
  assert.equal(required, false);
});

test('owner with an UNVERIFIED registration is not gated (half-finished enroll)', async () => {
  const required = await mfaRequiredFor('half@salon.com', fakeClient({
    user_identifier: 'half@salon.com', secret: generateSecret(), verified: false
  }));
  assert.equal(required, false);
});

test('owner with a VERIFIED registration must pass the second factor', async () => {
  const secret = generateSecret();
  const required = await mfaRequiredFor('owner@salon.com', fakeClient({
    user_identifier: 'owner@salon.com', secret, verified: true
  }));
  assert.equal(required, true);
});

// ── end-to-end: enroll -> verify code -> accept/reject ───────────────────────
test('a live code from the enrolled secret completes the second factor; a wrong one is rejected', async () => {
  const secret = generateSecret();
  const client = { rows: null };
  client.from = () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { secret, verified: true } }) }) }),
    upsert: (row) => { client.rows = row; return { onConflict: () => ({ then: async () => ({ error: null }) }) }; }
  });

  const reg = await getRegistration('owner@salon.com', client);
  assert.ok(reg && reg.verified, 'registration resolves as verified');

  const good = totp(secret, Date.now());
  assert.equal(validTOTP(reg.secret, good), true, 'correct code passes verify');

  // a real code from a DIFFERENT secret must not pass
  assert.equal(validTOTP(reg.secret, totp(generateSecret(), Date.now())), false);
});