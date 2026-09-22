// Shared CORS + preflight helper.
// Use at the top of every handler:
//   if (cors(req, res)) return;
export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Stripe-Signature,Telnyx-Signature-Ed25519,Telnyx-Timestamp');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Small JSON body parser that works whether req.body is a string, object, or missing.
export function jsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body;
}
