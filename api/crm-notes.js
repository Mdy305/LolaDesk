/**
 * /api/crm-notes — a client's notes and color formulas (owner/staff, signed in).
 *
 *   GET    /api/crm-notes?client_id=…[&kind=notes|formulas]  → { ok, notes, formulas }
 *   POST   /api/crm-notes  { client_id, kind:'note', body }
 *   POST   /api/crm-notes  { client_id, kind:'formula', formula, developer, processing, notes, stylist, date }
 *   DELETE /api/crm-notes?id=…
 *
 * The salon ALWAYS comes from the signed-in user (tenant_users / owner_email),
 * never from the request, and the client must belong to that salon.
 *
 * Storage: the client_notes table (migrations/20261006_client_notes.sql).
 * Until that migration runs, everything still saves: each note / formula is
 * appended to clients.notes as a dated line, and read back from there.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { cors, jsonBody } from './lib/cors.js';
import { db } from './lib/db.js';

const MAX = 4000;
const clip = (v, n = MAX) => String(v == null ? '' : v).trim().slice(0, n);
const missingTable = (e) => !!e && /does not exist|relation|schema cache|42P01|PGRST205/i.test(String(e.message || e.code || e));
const today = () => new Date().toISOString().slice(0, 10);
const FORMULA_FIELDS = ['date', 'formula', 'developer', 'processing', 'notes', 'stylist'];

export function formulaFrom(body = {}) {
  const f = {};
  for (const k of FORMULA_FIELDS) f[k] = clip(body[k], k === 'notes' || k === 'formula' ? MAX : 200);
  if (!/^\d{4}-\d{2}-\d{2}/.test(f.date)) f.date = today();
  f.date = f.date.slice(0, 10);
  return f;
}

// ── Fallback store: dated lines inside clients.notes ──
const FORMULA_LINE = /^\[(\d{4}-\d{2}-\d{2})\] Formula: (.*)$/;
export function formulaLine(f) {
  const parts = [f.formula];
  if (f.developer) parts.push('Developer: ' + f.developer);
  if (f.processing) parts.push('Processing: ' + f.processing);
  if (f.stylist) parts.push('Stylist: ' + f.stylist);
  if (f.notes) parts.push('Notes: ' + f.notes);
  return `[${f.date}] Formula: ${parts.join(' · ').replace(/\n+/g, ' ')}`;
}
export function parseNotesText(text, clientId) {
  const notes = [], formulas = [];
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const loose = [];
  lines.forEach((line, i) => {
    const fm = line.match(FORMULA_LINE);
    if (fm) {
      const [formula, ...rest] = fm[2].split(' · ');
      const f = { id: `legacy-f-${i}`, client_id: clientId, date: fm[1], created_at: fm[1] + 'T12:00:00.000Z', formula, developer: '', processing: '', stylist: '', notes: '' };
      for (const r of rest) { const m = r.match(/^(Developer|Processing|Stylist|Notes): (.*)$/); if (m) f[m[1].toLowerCase()] = m[2]; }
      formulas.push(f); return;
    }
    const nm = line.match(/^\[(\d{4}-\d{2}-\d{2})\] (.*)$/);
    if (nm) notes.push({ id: `legacy-n-${i}`, client_id: clientId, body: nm[2], created_at: nm[1] + 'T12:00:00.000Z', author: '' });
    else loose.push(line);
  });
  if (loose.length) notes.push({ id: 'legacy-on-file', client_id: clientId, body: loose.join('\n'), created_at: null, author: 'On file' });
  const newest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  return { notes: notes.sort(newest), formulas: formulas.sort(newest) };
}

const shapeNote = (r) => ({ id: r.id, client_id: r.client_id, body: r.body || '', author: r.author || '', created_at: r.created_at });
const shapeFormula = (r) => ({ id: r.id, client_id: r.client_id, ...(r.data || {}), formula: (r.data && r.data.formula) || r.body || '', created_at: r.created_at });

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const access = await resolveTenantAccessForUser(user);
    const tenant = access?.tenant;
    if (!tenant?.id) return res.status(403).json({ ok: false, error: 'tenant_not_mapped' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });
    const body = jsonBody(req) || {};
    const q = req.query || {};
    const author = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || String(user.email || '').split('@')[0] || 'Salon';

    // DELETE one row (only this salon's).
    if (req.method === 'DELETE') {
      const id = clip(q.id || body.id, 80);
      if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
      const { data, error } = await c.from('client_notes').delete().eq('id', id).eq('tenant_id', tenant.id).select();
      if (error) return res.status(missingTable(error) ? 409 : 500).json({ ok: false, error: missingTable(error) ? 'Older notes can be edited from the client’s details.' : 'delete_failed' });
      return res.json({ ok: true, deleted: (data || []).length });
    }

    const clientId = clip(q.client_id || body.client_id, 80);
    if (!clientId) return res.status(400).json({ ok: false, error: 'client_id_required' });
    const { data: client } = await c.from('clients').select('id,tenant_id,notes').eq('id', clientId).eq('tenant_id', tenant.id).maybeSingle();
    if (!client) return res.status(404).json({ ok: false, error: 'client_not_found' });

    if (req.method === 'GET') {
      const kind = String(q.kind || '').toLowerCase();
      const { data, error } = await c.from('client_notes').select('*').eq('tenant_id', tenant.id).eq('client_id', clientId).order('created_at', { ascending: false }).limit(500);
      const legacy = parseNotesText(client.notes, clientId);
      if (error) {
        if (!missingTable(error)) throw error;
        return res.json({ ok: true, storage: 'client_notes_text', notes: kind === 'formulas' ? undefined : legacy.notes, formulas: kind === 'notes' ? undefined : legacy.formulas });
      }
      const rows = data || [];
      const notes = rows.filter((r) => r.kind !== 'formula').map(shapeNote).concat(legacy.notes);
      const formulas = rows.filter((r) => r.kind === 'formula').map(shapeFormula).concat(legacy.formulas);
      return res.json({ ok: true, storage: 'client_notes', notes: kind === 'formulas' ? undefined : notes, formulas: kind === 'notes' ? undefined : formulas });
    }

    // POST: add a note or a formula.
    const kind = /formula/i.test(String(body.kind || body.type || '')) || (body.formula != null && body.body == null && body.text == null) ? 'formula' : 'note';
    let row;
    if (kind === 'formula') {
      const f = formulaFrom(body);
      if (!f.formula) return res.status(400).json({ ok: false, error: 'formula_required' });
      row = { tenant_id: tenant.id, client_id: clientId, kind, body: f.formula, data: f, author, created_by: user.id || null };
    } else {
      const text = clip(body.body ?? body.text ?? body.note);
      if (!text) return res.status(400).json({ ok: false, error: 'note_required' });
      row = { tenant_id: tenant.id, client_id: clientId, kind, body: text, data: {}, author, created_by: user.id || null };
    }
    const { data: saved, error } = await c.from('client_notes').insert(row).select().maybeSingle();
    if (error) {
      if (!missingTable(error)) throw error;
      // Table not there yet: keep it on the client record so nothing is lost.
      const line = kind === 'formula' ? formulaLine(row.data) : `[${today()}] ${row.body.replace(/\n+/g, ' ')}`;
      const next = [String(client.notes || '').trim(), line].filter(Boolean).join('\n');
      const up = await c.from('clients').update({ notes: next }).eq('id', clientId).eq('tenant_id', tenant.id);
      if (up && up.error) throw up.error;
      const parsed = parseNotesText(line, clientId);
      const item = kind === 'formula' ? parsed.formulas[0] : parsed.notes[0];
      return res.json({ ok: true, storage: 'client_notes_text', [kind]: { ...item, author, created_at: new Date().toISOString() } });
    }
    const out = saved || { ...row, created_at: new Date().toISOString() };
    return res.json({ ok: true, storage: 'client_notes', [kind]: kind === 'formula' ? shapeFormula(out) : shapeNote(out) });
  } catch (e) {
    console.error('[crm-notes]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'notes_error' });
  }
}
