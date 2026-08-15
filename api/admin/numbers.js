/**
 * /api/admin/numbers — platform operator's number-routing control plane
 * ════════════════════════════════════════════════════════════════════
 * Operates on the tenant_numbers table that lib/tenant-resolver.js reads on
 * every inbound call. Gated by the same ADMIN_EMAILS allow-list as
 * /api/admin (via lib/auth.js isAdminEmail) — tenant owners can never reach
 * this.
 *
 *   GET  /api/admin/numbers            → JSON: routing rows + tenant roster
 *   GET  /api/admin/numbers (browser)  → the small HTML dashboard (no auth —
 *                                        it's a static shell; data is gated)
 *   POST /api/admin/numbers            → { action: 'reassign' | 'unassign' |
 *                                          'enable' | 'disable', ... }
 *
 * 'reassign' moves a number to a tenant (and, for kind=primary, makes it the
 * tenant's canonical tenants.phone_number while unclaiming it from everyone
 * else). 'unassign' removes the routing row and clears any canonical claim.
 * 'enable'/'disable' flip routing status — a disabled number makes the
 * resolver refuse inbound calls with status:'disabled'.
 */
import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db, e164, upsertTenantNumber, listTenantNumberRoutes, removeTenantNumber, setTenantNumberStatus } from '../lib/db.js';
import { invalidateRouting, verifyTenantRouting } from '../lib/tenant-resolver.js';

// E.164 with sane bounds so 'abc' or a bare '+' can't slip through.
function validPhone(input){
  const phone = e164(input);
  if(!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if(digits.length < 8 || digits.length > 15) return null;
  return phone;
}

function err(status, message){
  return Object.assign(new Error(message), { status });
}

async function reassign(c, body){
  const phone = validPhone(body.phone_number);
  const tenantId = String(body.tenant_id || '').trim();
  const kind = String(body.kind || 'primary').trim() || 'primary';
  const status = String(body.status || 'active').trim() || 'active';
  if(!phone) throw err(400, 'A valid phone_number is required (E.164, 8–15 digits)');
  if(!tenantId) throw err(400, 'tenant_id is required');
  if(!['primary','forwarded','sub_brand','owner_line'].includes(kind)) throw err(400, 'kind must be primary|forwarded|sub_brand|owner_line');
  if(!['active','pending','disabled'].includes(status)) throw err(400, 'status must be active|pending|disabled');

  const { data: tenant } = await c.from('tenants').select('id,name,slug').eq('id', tenantId).maybeSingle();
  if(!tenant) throw err(404, 'Tenant not found');

  await upsertTenantNumber(tenantId, phone, { kind, status });

  if(kind === 'primary' && body.set_primary !== false){
    // This is now the tenant's canonical number: unclaim it from every other
    // tenant first, then set it here. tenants.phone_number has no unique
    // constraint, so without the clear step two tenants could share it.
    await c.from('tenants').update({ phone_number: null }).neq('id', tenantId).eq('phone_number', phone);
    await c.from('tenants').update({ phone_number: phone }).eq('id', tenantId);
  }

  invalidateRouting(phone);

  const { data: updated } = await c.from('tenants').select('*').eq('id', tenantId).maybeSingle();
  const routing = updated ? await verifyTenantRouting(updated) : null;
  return {
    phone_number: phone,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    kind, status,
    routing_verified: routing?.ready ?? false,
    routing,
    message: 'Routed ' + phone + ' \u2192 ' + (tenant.name || tenant.slug) + ' (' + kind + ', ' + status + ')'
  };
}

async function unassign(c, body){
  const phone = validPhone(body.phone_number);
  if(!phone) throw err(400, 'A valid phone_number is required');
  await removeTenantNumber(phone);
  // Clear the canonical claim too, so verifyTenantRouting and launch-readiness
  // don't keep pointing a stale number at this tenant.
  await c.from('tenants').update({ phone_number: null }).eq('phone_number', phone);
  invalidateRouting(phone);
  return { phone_number: phone, message: 'Unassigned ' + phone + ' from routing.' };
}

async function setStatus(c, body, status){
  const phone = validPhone(body.phone_number);
  if(!phone) throw err(400, 'A valid phone_number is required');
  const row = await setTenantNumberStatus(phone, status);
  if(!row) throw err(404, 'Number not found in the routing table');
  invalidateRouting(phone);
  return { phone_number: phone, status, message: phone + ' is now ' + status + '.' };
}

const ACTIONS = {
  reassign,
  unassign,
  enable:  (c, b) => setStatus(c, b, 'active'),
  disable: (c, b) => setStatus(c, b, 'disabled')
};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();

  const accept = String(req.headers.accept || '');
  const wantsHtml = req.query?.html === '1' || accept.includes('text/html');

  // The dashboard shell itself carries no data, so it loads before the token
  // gate; every data/JSON path below still requires an admin session.
  if(req.method === 'GET' && wantsHtml){
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(DASHBOARD_HTML);
  }

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  if(req.method === 'GET'){
    const [numbers, tenants] = await Promise.all([
      listTenantNumberRoutes(500),
      c.from('tenants').select('id,name,slug,phone_number,plan,billing_status').order('name').limit(500).then(r => r.data || []).catch(() => [])
    ]);
    const rows = (numbers || []).map(n => ({
      id: n.id,
      tenant_id: n.tenant_id,
      tenant_name: n.tenants?.name || null,
      tenant_slug: n.tenants?.slug || null,
      phone_number: n.phone_number,
      kind: n.kind,
      status: n.status,
      connection_id: n.connection_id,
      notes: n.notes,
      updated_at: n.updated_at
    }));
    return res.status(200).json({ ok:true, numbers: rows, tenants });
  }

  if(req.method === 'POST'){
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '').trim();
    const run = ACTIONS[action];
    if(!run) return res.status(400).json({ ok:false, error:'action must be reassign|unassign|enable|disable', supported_actions: Object.keys(ACTIONS) });
    try{
      const data = await run(c, body);
      return res.status(200).json({ ok:true, action, ...data });
    }catch(e){
      return res.status(e?.status || 500).json({ ok:false, error: String(e?.message || e) });
    }
  }

  return res.status(405).json({ ok:false, error:'Method not allowed' });
}

// ── the small dashboard view ────────────────────────────────────────
// Self-contained: vanilla JS + fetch against THIS endpoint. The token is
// kept in localStorage for the browser only, and sent as a Bearer header.
// Row actions use event delegation (data-act / data-phone) rather than
// inline onclick strings, so no quote-escaping gymnastics.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LolaDesk · Number Routing</title>
<style>
  :root { --pink:#ec4899; --ink:#1f2430; --muted:#6b7280; --bg:#f8fafc; --line:#e5e7eb; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--ink); }
  header { background:linear-gradient(90deg,#ec4899,#f472b6); color:#fff; padding:20px 24px; }
  header h1 { margin:0; font-size:20px; }
  header p { margin:4px 0 0; font-size:13px; opacity:.9; }
  main { max-width:1100px; margin:24px auto; padding:0 20px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:20px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  label { font-size:12px; color:var(--muted); display:block; margin-bottom:4px; }
  input, select, button { font-size:14px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; }
  input, select { background:#fff; }
  button { background:var(--pink); color:#fff; border:none; cursor:pointer; font-weight:600; }
  button.secondary { background:#f3f4f6; color:var(--ink); border:1px solid var(--line); }
  button.danger { background:#fff; color:#dc2626; border:1px solid #fecaca; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.active { background:#dcfce7; color:#15803d; }
  .badge.disabled { background:#fee2e2; color:#b91c1c; }
  .badge.pending { background:#fef3c7; color:#b45309; }
  #msg { display:none; padding:10px 14px; border-radius:8px; font-size:13px; margin-top:12px; }
  #msg.ok { display:block; background:#dcfce7; color:#15803d; }
  #msg.err { display:block; background:#fee2e2; color:#b91c1c; }
  .actions button { margin-right:6px; padding:5px 10px; font-size:12px; }
  .muted { color:var(--muted); }
  .grow { flex:1; min-width:220px; }
</style>
</head>
<body>
<header>
  <h1>LolaDesk · Number Routing</h1>
  <p>List, reassign, enable or disable the tenant_numbers map the resolver reads on every inbound call.</p>
</header>
<main>
  <div class="card">
    <label for="token">Admin token (stored in this browser only)</label>
    <div class="row">
      <input id="token" class="grow" type="password" placeholder="Paste your LolaDesk session token…">
      <button id="saveToken">Save token</button>
      <button id="load" class="secondary">Reload</button>
    </div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">Assign / reassign a number</h3>
    <div class="row">
      <div><label for="fPhone">Phone number (E.164)</label><input id="fPhone" placeholder="+13055550100"></div>
      <div><label for="fTenant">Tenant</label><select id="fTenant"></select></div>
      <div><label for="fKind">Kind</label><select id="fKind"><option>primary</option><option>forwarded</option><option>sub_brand</option><option>owner_line</option></select></div>
      <div><label for="fStatus">Status</label><select id="fStatus"><option>active</option><option>pending</option><option>disabled</option></select></div>
      <button id="assign">Assign</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <table>
      <thead><tr><th>Phone</th><th>Tenant</th><th>Kind</th><th>Status</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody id="tbody"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
    </table>
  </div>
</main>
<script>
var TOKEN_KEY = 'lola_admin_token';
function byId(id){ return document.getElementById(id); }
function token(){ return byId('token').value || localStorage.getItem(TOKEN_KEY) || ''; }
function msg(text, ok){ var m = byId('msg'); m.textContent = text; m.className = ok ? 'ok' : 'err'; }
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function api(path, opts){
  opts = opts || {};
  var headers = { 'Content-Type':'application/json' };
  var t = token();
  if(t) headers['Authorization'] = 'Bearer ' + t;
  return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, status: r.status, data: j }; }); });
}
function badge(s){ return '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>'; }
function render(numbers){
  var tb = byId('tbody');
  if(!numbers || !numbers.length){ tb.innerHTML = '<tr><td colspan="6" class="muted">No routing rows yet.</td></tr>'; return; }
  tb.innerHTML = numbers.map(function(n){
    var name = n.tenant_name
      ? esc(n.tenant_name) + ' <span class="muted">(' + esc(n.tenant_slug || '') + ')</span>'
      : '<span class="muted">unassigned</span>';
    var toggleAct = n.status === 'active' ? 'disable' : 'enable';
    var toggleLabel = n.status === 'active' ? 'Disable' : 'Enable';
    var actions =
      '<button class="secondary" data-act="' + toggleAct + '" data-phone="' + esc(n.phone_number) + '">' + toggleLabel + '</button>' +
      '<button class="danger" data-act="unassign" data-phone="' + esc(n.phone_number) + '">Unassign</button>';
    return '<tr>' +
      '<td>' + esc(n.phone_number) + '</td>' +
      '<td>' + name + '</td>' +
      '<td>' + esc(n.kind) + '</td>' +
      '<td>' + badge(n.status) + '</td>' +
      '<td class="muted">' + esc((n.updated_at || '').slice(0, 10)) + '</td>' +
      '<td class="actions">' + actions + '</td>' +
      '</tr>';
  }).join('');
}
function load(){
  byId('msg').className = '';
  api('/api/admin/numbers').then(function(res){
    if(!res.ok){ msg((res.data && res.data.error) || ('HTTP ' + res.status), false); return; }
    render(res.data.numbers);
    var sel = byId('fTenant');
    var current = sel.value;
    sel.innerHTML = '<option value="">— select tenant —</option>' + (res.data.tenants || []).map(function(t){
      return '<option value="' + esc(t.id) + '">' + esc(t.name || t.slug || t.id) + '</option>';
    }).join('');
    if(current) sel.value = current;
    msg('Loaded ' + (res.data.numbers || []).length + ' routing rows.', true);
  });
}
function post(action, body){
  msg('Working…', false);
  api('/api/admin/numbers', { method:'POST', body: Object.assign({ action: action }, body) }).then(function(res){
    if(!res.ok || res.data.ok === false){ msg((res.data && res.data.error) || ('HTTP ' + res.status), false); return; }
    msg((res.data && res.data.message) || 'OK', true);
    load();
  });
}
byId('tbody').addEventListener('click', function(ev){
  var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
  if(!btn) return;
  var act = btn.getAttribute('data-act');
  var phone = btn.getAttribute('data-phone');
  if(act === 'unassign'){
    if(confirm('Unassign ' + phone + '? This removes its routing row and clears any tenant listing it as primary.')){
      post('unassign', { phone_number: phone });
    }
  } else {
    post(act, { phone_number: phone });
  }
});
byId('saveToken').onclick = function(){ localStorage.setItem(TOKEN_KEY, byId('token').value); msg('Token saved for this browser.', true); };
byId('load').onclick = load;
byId('assign').onclick = function(){
  post('reassign', {
    phone_number: byId('fPhone').value,
    tenant_id: byId('fTenant').value,
    kind: byId('fKind').value,
    status: byId('fStatus').value
  });
};
byId('token').value = localStorage.getItem(TOKEN_KEY) || '';
load();
</script>
</body>
</html>
`;
