// POST /api/webhooks/telnyx-fill-gap-status
// Telnyx StatusCallback — updates the attempt with final call disposition.
export const config = { api: { bodyParser: false } };

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function parseForm(body) {
  const out = {};
  for (const pair of String(body || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const attemptId = req.query?.attempt_id || '';
    const raw = await readBody(req);
    const form = parseForm(raw);
    const callStatus = String(form.CallStatus || form.status || '').toLowerCase();
    const duration = parseInt(form.CallDuration || '0', 10) || 0;
    const machine = form.AnsweredBy || form.answered_by || '';

    if (attemptId) {
      try {
        const { db: dbFn } = await import('../lib/db.js');
        const patch = {
          call_duration_sec: duration,
          answered_by: machine || null,
        };
        // Final states — only overwrite non-terminal statuses
        if (['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(callStatus)) {
          patch.final_call_status = callStatus;
          patch.ended_at = new Date().toISOString();
        }
        await dbFn().from('fill_gap_attempts').update(patch).eq('id', attemptId);
      } catch (e) { console.warn('[fill-gap-status] update failed', e?.message); }
    }
    return res.status(200).send('OK');
  } catch (e) {
    return res.status(200).send('OK'); // Never fail Telnyx callbacks
  }
}
