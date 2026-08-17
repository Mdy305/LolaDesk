/**
 * tests/review-syndication.test.mjs — the Atomic Review Syndication pipeline.
 *
 * Run: node tests/review-syndication.test.mjs  (or node --test tests/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashReview, moderateReview, normalizeRating, parseReviewCSV,
  filterReviews, renderReviewCardPng, scheduleReviews, publishToMeta
} from '../api/lib/review-syndication.js';
import { FakeSupabase } from './fake-supabase.js';

// ── pure functions ─────────────────────────────────────────────────

test('parseReviewCSV handles quoted fields, commas and flexible headers', () => {
  const csv = [
    'stars,Reviewer,review_text',
    '5,"Sarah","Incredible balayage, best I have ever had!"',
    '4,Jim,Meh it was fine',
    '5,Mia,"Loved it, will be back"'
  ].join('\n');
  const { rows, error } = parseReviewCSV(csv);
  assert.equal(error, null);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rating, '5');
  assert.equal(rows[0].author, 'Sarah');
  assert.match(rows[0].body, /Incredible balayage, best/);
});

test('parseReviewCSV falls back to positional columns when headers are unrecognised', () => {
  const { rows } = parseReviewCSV('5,Sarah,Amazing service and great vibes\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, '5');
  assert.equal(rows[0].author, 'Sarah');
  assert.match(rows[0].body, /Amazing service/);
});

test('filterReviews keeps only 5-star reviews longer than 10 chars', () => {
  const rows = [
    { rating: 5, author: 'A', body: 'Best experience ever, truly exceptional.' },
    { rating: 4, author: 'B', body: 'Pretty good, would come again.' },
    { rating: '5.0', author: 'C', body: 'Amazing.' },                    // too short (7)
    { rating: 'five', author: 'D', body: 'Stars written as a word.' },   // non-numeric
    { rating: 5, author: 'E', body: 'Call me at (305) 555-0100, loved it!' } // flagged (phone)
  ];
  const { accepted, rejected } = filterReviews(rows);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].author, 'A');

  const reasons = rejected.map(r => r.reason);
  assert.ok(reasons.includes('not_five_star'));
  assert.ok(reasons.includes('too_short'));
  assert.ok(reasons.includes('flagged'));
});

test('moderateReview flags phone numbers and addresses, passes clean text', () => {
  assert.equal(moderateReview('Loved it! Call me at 305-555-0100').flagged, true);
  assert.equal(moderateReview('Best salon at 1234 Ocean Drive, Miami').flagged, true);
  assert.equal(moderateReview('Beautiful balayage, five stars!').flagged, false);
});

test('hashReview is deterministic and dedupes on author+body', () => {
  assert.equal(hashReview('Sarah', 'Amazing'), hashReview('Sarah', 'Amazing'));
  assert.notEqual(hashReview('Sarah', 'Amazing'), hashReview('Sarah', 'Great'));
  assert.notEqual(hashReview('Sarah', 'Amazing'), hashReview('Mia', 'Amazing'));
});

test('normalizeRating coerces strings and rejects non-numbers', () => {
  assert.equal(normalizeRating('5'), 5);
  assert.equal(normalizeRating('5.0'), 5);
  assert.equal(normalizeRating('4.5'), 4.5);
  assert.equal(normalizeRating('five'), null);
});

// ── scheduling against the fake DB ─────────────────────────────────

test('scheduleReviews de-dups, staggers +48h and writes queue rows', async () => {
  const fake = new FakeSupabase();
  const tenantId = 'tenant-a';
  const rows = [
    { rating: 5, author: 'Sarah', body: 'Incredible balayage, best in Miami.' },
    { rating: 5, author: 'Mia', body: 'Loved the extensions, will be back.' },
    { rating: 5, author: 'Sarah', body: 'Incredible balayage, best in Miami.' }, // duplicate
    { rating: 3, author: 'Jim', body: 'It was okay but nothing special honestly.' } // filtered
  ];

  const r = await scheduleReviews(fake, tenantId, 'yelp_csv', rows);
  assert.equal(r.ok, true);
  assert.equal(r.accepted, 3);
  assert.equal(r.scheduled, 2);
  assert.equal(r.skipped.duplicate, 1);
  assert.equal(r.skipped.not_five_star, 1);

  const queue = fake.all('review_queue');
  assert.equal(queue.length, 2);
  assert.equal(queue[0].status, 'scheduled');
  assert.equal(queue[0].rating, 5);
  // +48h stagger
  const t0 = new Date(queue[0].scheduled_for).getTime();
  const t1 = new Date(queue[1].scheduled_for).getTime();
  assert.equal(Math.round((t1 - t0) / 3600000), 48);

  // re-running with the same input de-dups everything
  const again = await scheduleReviews(fake, tenantId, 'yelp_csv', rows);
  assert.equal(again.scheduled, 0);
  assert.equal(again.skipped.duplicate, 3);
});

// ── card renderer ──────────────────────────────────────────────────

test('renderReviewCardPng returns a 1080x1080 PNG', async () => {
  const buf = await renderReviewCardPng({ author: 'Sarah', body: 'Incredible balayage — best in Miami.', tenantName: 'MMΛ Salon' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
  // PNG magic + IHDR width/height at offsets 16/20
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buf.readUInt32BE(16), 1080);
  assert.equal(buf.readUInt32BE(20), 1080);
});

// ── Meta publish ───────────────────────────────────────────────────

test('publishToMeta posts the card to the Facebook page', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ id: 'photo-id-1', post_id: 'page_123_456' }) };
  };
  try{
    const r = await publishToMeta({ accessToken: 'tok', pageId: 'page_123' }, { imageUrl: 'https://x/card.png', caption: 'Amazing!' });
    assert.equal(r.posted, true);
    assert.equal(r.postId, 'page_123_456');
    assert.equal(r.provider, 'facebook');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/page_123\/photos/);
    assert.match(String(calls[0].opts.body), /url=https%3A%2F%2Fx%2Fcard\.png/);
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('publishToMeta does the two-step Instagram publish when only ig_user_id is set', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if(calls[calls.length - 1].includes('/media_publish')) return { ok: true, status: 200, json: async () => ({ id: 'ig-post-9' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'creation-7' }) };
  };
  try{
    const r = await publishToMeta({ accessToken: 'tok', igUserId: 'ig_123' }, { imageUrl: 'https://x/card.png', caption: 'Amazing!' });
    assert.equal(r.postId, 'ig-post-9');
    assert.equal(r.provider, 'instagram');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /ig_123\/media$/);
    assert.match(calls[1], /ig_123\/media_publish/);
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('publishToMeta surfaces Meta errors (e.g. expired token)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) });
  try{
    await assert.rejects(
      () => publishToMeta({ accessToken: 'bad', pageId: 'page_123' }, { imageUrl: 'https://x/card.png', caption: 'x' }),
      /Invalid OAuth access token/
    );
  }finally{
    globalThis.fetch = realFetch;
  }
});
