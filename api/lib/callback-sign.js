/**
 * api/lib/callback-sign.js — signatures for the TeXML callback URLs LolaDesk hands to Telnyx
 * (fill-gap status / response, recording). Telnyx calls the URLs exactly as given, so a per-call
 * key in the URL (k=…) proves the callback belongs to a call LolaDesk placed. Derived from the
 * same server secret as the tool key (api/lib/tool-key.js) — nothing new to configure.
 */
import crypto from 'node:crypto';
import { toolKey } from './tool-key.js';

/** Key for one fill-gap attempt (bound to its id). '' when no server secret exists. */
export function fillGapKey(attemptId) {
  if (!attemptId) return '';
  return toolKey('fillgap:' + String(attemptId));
}
export function fillGapKeyOk(attemptId, k) {
  const want = fillGapKey(attemptId);
  if (!want || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Key for the recording-status webhook URL. */
export const recordingKey = () => toolKey('recording');
export function recordingKeyOk(k) {
  const want = recordingKey();
  if (!want || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** The signed recording callback URL to give Telnyx (RecordingStatusCallback / webhook). */
export function recordingCallbackUrl(base = process.env.APP_URL || 'https://www.loladesk.com') {
  return `${String(base).replace(/\/+$/, '')}/api/webhooks/telnyx-recording?k=${recordingKey()}`;
}
