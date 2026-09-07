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
