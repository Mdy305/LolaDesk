import { telnyxRequest, TelnyxApiError } from './lib/telnyx-client.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const configuration = {
    api_key: Boolean(process.env.TELNYX_API_KEY),
    public_key: Boolean(process.env.TELNYX_PUBLIC_KEY),
    voice_app: Boolean(process.env.TELNYX_VOICE_APP_ID),
    messaging_profile: Boolean(process.env.TELNYX_MESSAGING_PROFILE),
    app_url: Boolean(process.env.APP_URL)
  };

  if (!configuration.api_key) {
    return res.status(503).json({ ok: false, configuration, telnyx: 'not_checked' });
  }

  try {
    await telnyxRequest('/phone_numbers', { query: { 'page[size]': 1 }, timeoutMs: 5000 });
    const productionSafe = process.env.NODE_ENV !== 'production' || configuration.public_key;
    return res.status(productionSafe ? 200 : 503).json({
      ok: productionSafe,
      configuration,
      telnyx: 'reachable',
      warning: productionSafe ? null : 'TELNYX_PUBLIC_KEY is required in production'
    });
  } catch (error) {
    const status = error instanceof TelnyxApiError ? error.status : 503;
    return res.status(status >= 500 ? 503 : status).json({
      ok: false,
      configuration,
      telnyx: 'unreachable',
      error: String(error?.message || error)
    });
  }
}
