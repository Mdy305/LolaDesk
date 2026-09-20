/**
 * tests/lola-persona.test.mjs — Lola is ONE persona everywhere.
 *
 * Run:
 *   node tests/lola-persona.test.mjs
 *   node --test tests/
 *
 * The persona ("a Los Angeles girl who works the valet stand in Beverly
 * Hills") lives in api/lib/lola-persona.js and is consumed by every surface
 * that speaks in her voice: the Telnyx AI Assistant instructions (phone),
 * the realtime voice session system prompt (orb), and the SMS/text style
 * guide. These tests keep the persona single-sourced: the shared module
 * carries the character, and no call site may fork its own flavor again.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { lolaPersona } = await import('../api/lib/lola-persona.js');

test('persona carries the Los Angeles / Beverly Hills valet character and the salon name', () => {
  const p = lolaPersona('MMΛ Salon');
  assert.ok(p.includes('MMΛ Salon'), 'persona names the salon');
  assert.ok(/Los Angeles/.test(p), 'persona is a Los Angeles girl');
  assert.ok(/valet stand in Beverly Hills/.test(p), 'persona works the valet stand in Beverly Hills');
  assert.ok(/warm|upbeat|high-energy/i.test(p), 'persona keeps the warm, upbeat register');
});

test('persona falls back gracefully without a salon name', () => {
  const p = lolaPersona();
  assert.ok(p.includes('the salon'), 'uses the fallback name instead of undefined');
});

const PERSONA_CONSUMERS = [
  'api/telnyx-agents.js',   // phone: Telnyx AI Assistant instructions
  'api/voice-stream.js'     // orb: realtime voice session system prompt
];

test('every voice surface imports the shared persona lib', () => {
  for (const f of PERSONA_CONSUMERS) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(src.includes("from './lib/lola-persona.js'"), f + ' must import the shared persona');
    assert.ok(src.includes('lolaPersona('), f + ' must interpolate the shared persona');
  }
});

test('the forked "5-star Beverly Hills luxury hotel concierge" personas are gone', () => {
  for (const f of PERSONA_CONSUMERS) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/Beverly Hills luxury hotel concierge/.test(src),
      f + ' must not fork its own persona anymore — use the shared lib');
  }
});

test('the SMS/text style guide matches the persona', () => {
  const src = readFileSync(join(ROOT, 'api/lib/lola-skills.js'), 'utf8');
  assert.ok(/valet girl/.test(src), 'lola-skills style guide should echo the valet-girl persona');
});

// ── SMS copy lives in ONE place ──────────────────────────────────────
// Every client-facing text is composed by the persona module. These tests
// keep the voice (greeting + sign-off) and the facts (service, time, code,
// links, opt-out) from drifting apart again.

const {
  smsGreeting, missedCallText, bookingFailedText, reviewRequestText,
  gapFillText, missedCallTextbackText, cancelText, confirmText,
  reminderText, waitlistOfferText, radarText
} = await import('../api/lib/lola-persona.js');

const SMS_SOURCES = [
  'api/lib/autopilot.js',
  'api/lib/booking-repository.js',
  'api/lib/booking-reminders.js',
  'api/telnyx-voice.js',
  'api/salon.js'
];

test('every SMS send site imports its copy from the shared persona module', () => {
  for (const f of SMS_SOURCES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(src.includes("from './lola-persona.js'") || src.includes("from '../lib/lola-persona.js'") || src.includes("from './lib/lola-persona.js'"),
      f + ' must import its text copy from the shared persona module');
  }
});

test('no send site composes its own voice copy — the phrases live only in the persona module', () => {
  for (const f of SMS_SOURCES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const phrase of ['this is Lola at', 'got cut off', 'Reminder from', 'spot just opened', 'has been cancelled', 'review means the world', 'since your last visit', "didn't go through"]) {
      assert.ok(!src.includes(phrase), f + ' must not compose its own copy: "' + phrase + '" belongs in lola-persona.js');
    }
  }
});

test('Lola opens every text with her greeting and never leaves it undefined', () => {
  const salon = 'MMΛ Salon';
  const cases = [
    [missedCallText({ firstName: 'Grace Kelly', salon }), 'Hi Grace,'],
    [bookingFailedText({ firstName: undefined, salon }), 'Hi there,'],
    [reviewRequestText({ firstName: 'Ana', salon, links: [] }), 'Hi Ana,'],
    [gapFillText({ firstName: '', salon, day: 'Thursday', when: '2 PM', staffName: 'Jerome' }), 'Hi there,']
  ];
  for (const [t, greet] of cases) assert.ok(t.startsWith(greet + ' this is Lola at MMΛ Salon.'), 'not her greeting: ' + t);
  assert.ok(smsGreeting('Grace  Kelly', salon).startsWith('Hi Grace,'), 'greeting uses the first name only');
  assert.ok(smsGreeting('', salon).startsWith('Hi there,'), 'greeting falls back without a name');
  assert.ok(smsGreeting('Ana').includes('the salon'), 'greeting falls back without a salon');
});

test('proactive agent texts keep their facts and their sign-off', () => {
  const t1 = missedCallText({ firstName: 'Sophia', salon: 'MMΛ' });
  assert.ok(t1.includes("missed your call") && t1.includes("I'll pick up"), 'missed-call keeps ask + sign-off: ' + t1);
  const t2 = bookingFailedText({ firstName: 'Sophia', salon: 'MMΛ', service: 'Balayage' });
  assert.ok(t2.includes('Your Balayage') && t2.includes("didn't go through"), 'failed-booking names the service: ' + t2);
  const t3 = reviewRequestText({ firstName: 'Sophia', salon: 'MMΛ', links: ['Google: https://g.co', 'Yelp: https://yelp.com'] });
  assert.ok(t3.includes('a review means the world') && t3.includes('Google: https://g.co · Yelp: https://yelp.com'), 'review keeps both links joined by · : ' + t3);
  const t4 = gapFillText({ firstName: 'Sophia', salon: 'MMΛ', day: 'Thursday', when: '2 PM', staffName: 'Jerome' });
  assert.ok(t4.includes('opening Thursday at 2 PM with Jerome'), 'gap-fill keeps day/time/staff: ' + t4);
});

test('booking lifecycle texts carry every fact the client needs — and the opt-out', () => {
  const c = confirmText({ verb: 'Confirmed', salon: 'MMΛ', serviceName: 'Balayage', when: 'Thu, Sep 17, 2:00 PM', code: 'AB23CD' });
  assert.ok(c.startsWith('Confirmed at MMΛ: Balayage on Thu, Sep 17, 2:00 PM.'), 'confirmation shape: ' + c);
  assert.ok(c.includes('Your code: AB23CD — use it to cancel or reschedule online.'), 'code line: ' + c);
  assert.ok(/Reply STOP to opt out\.$/.test(c), 'opt-out last: ' + c);
  const r = confirmText({ verb: 'Rescheduled', salon: 'MMΛ', serviceName: 'Cut', when: 'Fri 10 AM' });
  assert.ok(r.startsWith('Rescheduled at '), 'reschedule leads with the verb: ' + r);
  const n = confirmText({ salon: 'MMΛ', serviceName: 'Cut', when: 'Fri 10 AM', code: null });
  assert.ok(n.startsWith('Confirmed at ') && !n.includes('Your code:'), 'no code line without a code: ' + n);
  const x = cancelText('MMΛ', 'Thu, Sep 17');
  assert.ok(x === 'Your appointment at MMΛ on Thu, Sep 17 has been cancelled. Reply to this text and we\'ll get you back on the books soon.', 'cancel keeps its voice: ' + x);
});

test('reminder and waitlist texts keep the factual fragments the tests and clients rely on', () => {
  const rem = reminderText({ salon: 'MMΛ', what: 'Balayage', when: 'Thu, Sep 17, 2:00 PM' });
  assert.ok(rem.startsWith('Reminder from MMΛ: Balayage on Thu, Sep 17, 2:00 PM.'), 'reminder shape: ' + rem);
  assert.ok(/Reply STOP to opt out\.$/.test(rem), 'reminder opt-out: ' + rem);
  const w = waitlistOfferText({ salon: 'MMΛ', what: 'Balayage', when: 'Thu 2 PM' });
  assert.ok(w === 'MMΛ: a Balayage spot just opened — Thu 2 PM. Reply to claim it, or reply STOP to opt out.', 'waitlist shape: ' + w);
});

test('the 2h radar text keeps its facts and its opt-out', () => {
  const r = radarText({ salon: 'MMΛ', what: 'Balayage', when: 'Thu, Sep 17, 2:00 PM', staffName: 'Rex' });
  assert.ok(r.startsWith('Reminder from MMΛ: Balayage is coming up at Thu, Sep 17, 2:00 PM with Rex.'), 'radar shape: ' + r);
  assert.ok(/Reply STOP to opt out\.$/.test(r), 'radar opt-out: ' + r);
  const bare = radarText({ salon: 'MMΛ', what: 'Balayage', when: 'Thu 2 PM' });
  assert.ok(!bare.includes('with'), 'no dangling stylist fragment when absent: ' + bare);
});

test('the text-back matches the voice farewell that promises it', () => {
  const tb = missedCallTextbackText('MMΛ');
  assert.ok(tb.startsWith("Hi, it's Lola from MMΛ 💗 Sorry we got cut off!"), 'text-back voice: ' + tb);
  assert.ok(tb.includes('tell me the service and a day that works'), 'text-back keeps the ask: ' + tb);
});
