/**
 * tests/voice-router.test.mjs — lola-voice-router.js routing decisions
 *
 *   node tests/voice-router.test.mjs
 *
 * Verifies the router prefers window.LolaVoice when the Telnyx assistant is
 * configured (probe → 200) and falls back to LolaResonance otherwise, plus
 * that a LolaVoice.stop() is routed on a second tap while streaming.
 *
 * The router is an IIFE against the global `window`, so we run it in a vm
 * sandbox with a fake window/fetch/localStorage/document.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(__dirname, '../lola-voice-router.js'), 'utf8');

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; } };

function makeWindow({ probeStatus = 503, lolaStreaming = false } = {}) {
  const store = { loladesk_token: 'tok' };
  const calls = { toggleVoice: 0, chatVoice: 0, begin: 0, stop: 0, resToggle: 0, disable: 0 };
  const lolaVoice = {
    state: { streaming: lolaStreaming },
    begin: async () => { calls.begin++; return true; },
    stop: () => { calls.stop++; },
  };
  const resonance = {
    toggle: () => { calls.resToggle++; },
    disable: () => { calls.disable++; },
  };
  const win = {
    LolaVoice: lolaVoice,
    LolaResonance: resonance,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    addEventListener: () => {},
    document: { addEventListener: () => {} },
    fetch: async () => ({ status: probeStatus }),
  };
  win.toggleVoice = () => { calls.toggleVoice++; };
  win.toggleChatVoice = () => { calls.chatVoice++; };
  return { win, calls, store };
}

function boot(opts) {
  const { win, calls, store } = makeWindow(opts);
  const sandbox = { window: win, fetch: win.fetch, document: win.document, localStorage: win.localStorage };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { win, calls, store };
}

async function run() {
  console.log('voice-router routing (primary)');
  {
    const { win, calls } = boot({ probeStatus: 200 });
    await new Promise((r) => setTimeout(r, 10));
    t('installs toggleVoice override', () => assert.notEqual(win.toggleVoice, undefined));
    await win.toggleVoice();
    await new Promise((r) => setTimeout(r, 5));
    t('routes orb tap to LolaVoice.begin when primary', () => {
      assert.equal(calls.begin, 1);
      assert.equal(calls.resToggle, 0);
    });
  }

  console.log('voice-router fallback');
  {
    const { win, calls } = boot({ probeStatus: 503 });
    await new Promise((r) => setTimeout(r, 10));
    await win.toggleVoice();
    await new Promise((r) => setTimeout(r, 5));
    t('routes orb tap to LolaResonance.toggle when not configured', () => {
      assert.equal(calls.resToggle, 1);
      assert.equal(calls.begin, 0);
    });
  }

  console.log('voice-router streaming toggle');
  {
    const { win, calls } = boot({ probeStatus: 200, lolaStreaming: true });
    await new Promise((r) => setTimeout(r, 10));
    await win.toggleVoice();
    await new Promise((r) => setTimeout(r, 5));
    t('routes a second tap to LolaVoice.stop while streaming', () => {
      assert.equal(calls.stop, 1);
      assert.equal(calls.begin, 0);
    });
  }

  console.log('\nvoice-router: ' + (process.exitCode ? 'FAILED' : 'all green') + ` (${passed} assertions)`);
}

run();