import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudio, ownerText, inboxNote, lookLine, STUDIO_DEPOSIT_CENTS } from '../api/lib/studio.js';

const base = { salon: '+13057034132', name: 'Camille Laurent', phone: '(305) 555-0123',
  look: { method: 'itips', shade: 'Greige', code: '', inches: 18, fullness: 'full', match: 'Level 8 · neutral' } };

test('deposit is a flat $500', () => { assert.equal(STUDIO_DEPOSIT_CENTS, 50000); });

test('lead parses and normalises the phone', () => {
  const p = parseStudio({ ...base, event: 'lead' });
  assert.equal(p.ok, true);
  assert.equal(p.value.phone, '+13055550123');
  assert.equal(p.value.look.method, 'I-Tips');
});

test('the length is the tier: 12, 18, 24 inches, 100 g each', () => {
  const p = parseStudio({ ...base, event: 'order', look: { ...base.look, fullness: 'natural', inches: 30 } });
  assert.equal(p.value.look.inches, 12); assert.equal(p.value.look.grams, 100); assert.equal(p.value.look.priceCents, 150000);
});

test('a shade other than the AI match adds $500 color customization', () => {
  const p = parseStudio({ ...base, event: 'order', look: { ...base.look, colorChange: true } });
  assert.equal(p.value.look.priceCents, 300000);
  assert.match(lookLine(p.value), /Color customization \(same day\)/);
  assert.match(lookLine(parseStudio({ ...base, event: 'order' }).value), /perfect match, no color/);
});

test('price comes from the server tier, never the browser', () => {
  const p = parseStudio({ ...base, event: 'order', look: { ...base.look, fullness: 'iconic', priceCents: 1 } });
  assert.equal(p.value.look.priceCents, 350000);
  assert.match(lookLine(p.value), /\$3,500/);
});

test('rejects bad input', () => {
  assert.equal(parseStudio({ ...base, event: 'nope' }).error, 'bad_event');
  assert.equal(parseStudio({ ...base, event: 'lead', phone: '123' }).error, 'bad_phone');
  assert.equal(parseStudio({ ...base, event: 'lead', name: '  ' }).error, 'bad_name');
  assert.equal(parseStudio({ ...base, event: 'booking', install: { startsAt: 'x' } }).error, 'bad_time');
});

test('owner texts say who, what and what to do', () => {
  const lead = parseStudio({ ...base, event: 'lead' }).value;
  assert.match(ownerText(lead), /New lead: Camille Laurent \(305\) 555-0123/);
  const order = parseStudio({ ...base, event: 'order' }).value;
  assert.match(ownerText(order, { paid: true }), /DEPOSIT PAID \$500.*Order the hair now.*Balance at install: \$2,000/);
  const when = new Date(Date.now() + 7 * 864e5).toISOString();
  const booking = parseStudio({ ...base, event: 'booking', install: { startsAt: when, artist: 'Meddy', label: 'Fri Oct 16, 11:30 AM' } }).value;
  assert.match(ownerText(booking), /Install booked: .*Fri Oct 16, 11:30 AM with Meddy/);
  assert.match(inboxNote(booking), /booked the install/);
});

test('order keeps only real JPEG color references', async () => {
  const { parseStudio } = await import('../api/lib/studio.js');
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 7)]).toString('base64');
  const png = 'data:image/png;base64,' + Buffer.alloc(2000, 7).toString('base64');
  const p = parseStudio({ event: 'order', name: 'Ana', phone: '3055550100', look: { fullness: 'full', colorChange: true }, photos: { card: jpeg, before: png, after: 'nope' } });
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.value.photos), ['card']);
  const lead = parseStudio({ event: 'lead', name: 'Ana', phone: '3055550100', photos: { card: jpeg } });
  assert.deepEqual(lead.value.photos, {});
});

test('order text carries the AI read and the reference links', async () => {
  const { parseStudio, ownerText } = await import('../api/lib/studio.js');
  const v = parseStudio({ event: 'order', name: 'Ana', phone: '3055550100', look: { fullness: 'iconic', shade: 'Platine', colorChange: true, match: 'Level 8 · neutral → Greige' } }).value;
  const t = ownerText(v, { links: '\nOrder card: https://x/card.jpg' });
  assert.match(t, /AI read: Level 8/);
  assert.match(t, /Color customization/);
  assert.match(t, /\$4,000/);
  assert.match(t, /Order card: https:\/\/x\/card\.jpg/);
});

test('client texts: welcome and one follow-up, both with opt-out and the studio link', async () => {
  const { clientText, STUDIO_LINK } = await import('../api/lib/studio.js');
  const v = { name: 'Camille Laurent', phone: '+13055550123' };
  for (const k of ['welcome', 'followup']) {
    const t = clientText(v, k);
    assert.match(t, /^Bonjour Camille/);
    assert.ok(t.includes(STUDIO_LINK));
    assert.match(t, /STOP to opt out/);
  }
});
