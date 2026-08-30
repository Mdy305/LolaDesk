const BASE_URL = 'https://api.telnyx.com/v2';

export class TelnyxApiError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = 'TelnyxApiError';
    this.status = status;
    this.details = details;
  }
}

function apiKey() {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new TelnyxApiError('Missing TELNYX_API_KEY', 500);
  return key;
}

export async function telnyxRequest(path, options = {}) {
  const { method = 'GET', query, body, headers = {}, timeoutMs = 15000 } = options;
  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }

    if (!response.ok) {
      const message = payload?.errors?.[0]?.detail || payload?.error || `Telnyx request failed (${response.status})`;
      throw new TelnyxApiError(message, response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new TelnyxApiError('Telnyx request timed out', 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeE164(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function appUrl() {
  return String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, '');
}

export function telnyxData(payload) {
  return payload?.data ?? payload ?? null;
}
