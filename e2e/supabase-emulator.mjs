/**
 * e2e/supabase-emulator.mjs — a local Supabase for end-to-end tests
 * ════════════════════════════════════════════════════════════════
 * Implements exactly the surface LolaDesk's code uses, over the REAL
 * local Postgres (so the REAL schema.sql + migrations are what's
 * being exercised):
 *
 *   REST (PostgREST subset, consumed via @supabase/supabase-js):
 *     select (columns, count=exact), insert, update, delete,
 *     upsert (on_conflict + resolution=merge-duplicates),
 *     filters: eq neq gt gte lt lte in not is ilike, match,
 *     order, limit, single/maybeSingle (vnd.pgrst.object semantics).
 *
 *   Auth (GoTrue subset, via supabase-js auth):
 *     POST /auth/v1/admin/users        (createUser, email_confirm)
 *     POST /auth/v1/token?grant_type=password  (signInWithPassword)
 *     GET  /auth/v1/user               (getUser from Bearer token)
 *
 * Deliberately NOT a mock of results — every query really executes
 * against Postgres; only the HTTP dialect is emulated. If the schema
 * is wrong, tests fail, which is the point.
 */
import http from 'http';
import crypto from 'crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.PG_URL || 'postgres://postgres@127.0.0.1:5432/loladesk' });

/* ── tiny GoTrue ── */
const users = new Map();   // id -> user
const tokens = new Map();  // access_token -> user id

function makeUser(email, password, meta){
  const id = crypto.randomUUID();
  const u = { id, email, user_metadata: meta || {}, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), password };
  users.set(id, u);
  return u;
}
function issueToken(user){
  const t = 'e2e_' + crypto.randomBytes(24).toString('hex');
  tokens.set(t, user.id);
  return t;
}
function publicUser(u){ const { password, ...rest } = u; return rest; }

/* ── PostgREST subset ── */
const OPS = { eq:'=', neq:'<>', gt:'>', gte:'>=', lt:'<', lte:'<=' };

function parseFilters(sp, table){
  const where = [], params = [];
  const qcol = (s) => `"${table}"."${s.replace(/"/g,'')}"`;
  for(const [col, raw] of sp.entries()){
    if(['select','order','limit','offset','on_conflict','columns'].includes(col)) continue;
    const dot = raw.indexOf('.');
    const op = dot === -1 ? 'eq' : raw.slice(0, dot);
    const val = dot === -1 ? raw : raw.slice(dot + 1);
    const q = (s)=>'"' + s.replace(/"/g,'') + '"';
    if(OPS[op]){ params.push(val); where.push(`${qcol(col)} ${OPS[op]} $${params.length}`); }
    else if(op === 'is'){ where.push(`${qcol(col)} IS ${val === 'null' ? 'NULL' : val.toUpperCase()}`); }
    else if(op === 'not'){ // e.g. not.is.null
      const [op2, v2] = [val.slice(0, val.indexOf('.')), val.slice(val.indexOf('.')+1)];
      if(op2 === 'is') where.push(`${qcol(col)} IS NOT ${v2 === 'null' ? 'NULL' : v2.toUpperCase()}`);
      else if(OPS[op2]){ params.push(v2); where.push(`NOT (${qcol(col)} ${OPS[op2]} $${params.length})`); }
    }
    else if(op === 'in'){
      const vals = val.replace(/^\(|\)$/g,'').split(',').map(v=>v.replace(/^"|"$/g,''));
      const ph = vals.map(v=>{ params.push(v); return '$'+params.length; });
      where.push(`${qcol(col)} IN (${ph.join(',')})`);
    }
    else if(op === 'ilike'){ params.push(val.replace(/\*/g,'%')); where.push(`${qcol(col)} ILIKE $${params.length}`); }
  }
  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function parseOrder(sp){
  const o = sp.get('order'); if(!o) return '';
  return ' ORDER BY ' + o.split(',').map(part=>{
    const bits = part.split('.');
    const col = '"' + bits[0].replace(/"/g,'') + '"';
    const dir = bits.includes('desc') ? 'DESC' : 'ASC';
    const nulls = bits.includes('nullsfirst') ? ' NULLS FIRST' : bits.includes('nullslast') ? ' NULLS LAST' : '';
    return `${col} ${dir}${nulls}`;
  }).join(', ');
}

function jsonBody(req){
  return new Promise(r=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>{ try{ r(s?JSON.parse(s):{}); }catch{ r({}); } }); });
}

function pgVal(v){
  if(v === null || v === undefined) return null;
  if(Array.isArray(v)) return v.every(x=>typeof x==='string') ? v : JSON.stringify(v); // text[] vs jsonb array
  if(typeof v === 'object') return JSON.stringify(v);
  return v;
}

/* PostgREST select subset: "alias:column", "column", "alias:table(col1,col2)".
   Embedded resources resolve through the parent's "<table>_id" FK column —
   the exact shape every LolaDesk select uses (service:services(name),
   stylist:staff(name), starts_at:start_time, price:total_amount). Without
   this the harness would 400 on aliased selects and the journey would pass
   on silent empty results instead of real data. */
function parseSelect(raw, table){
  const toks = [];
  let depth = 0, cur = '';
  for(const ch of raw){
    if(ch === '('){ depth++; cur += ch; }
    else if(ch === ')'){ depth--; cur += ch; }
    else if(ch === ',' && depth === 0){ toks.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if(cur.trim()) toks.push(cur.trim());
  const select = [], embeds = [];
  for(const tok of toks){
    if(!tok) continue;
    const colon = tok.indexOf(':');
    if(colon === -1){ select.push(`"${table}"."${tok.replace(/"/g,'')}"`); continue; }
    const alias = tok.slice(0, colon).trim().replace(/"/g,'');
    const target = tok.slice(colon + 1).trim();
    const m = target.match(/^([a-z_]+)\(([^)]*)\)$/);
    if(m){
      const rel = m[1];
      const cols = m[2].split(',').map(c=>c.trim()).filter(Boolean);
      embeds.push({ alias, rel, cols });
      for(const c of cols) select.push(`"${rel}"."${c.replace(/"/g,'')}" AS "${alias}.${c.replace(/"/g,'')}"`);
    } else {
      select.push(`"${target.replace(/"/g,'')}" AS "${alias}"`);
    }
  }
  let joins = '';
  for(const e of embeds){
    const fk = `${e.rel.replace(/s$/,'')}_id`;
    joins += ` LEFT JOIN "${e.rel}" ON "${table}"."${fk}" = "${e.rel}"."id"`;
  }
  return { select: select.length ? select.join(', ') : '*', joins, embeds };
}
function assembleEmbeds(row, embeds){
  if(!embeds.length) return row;
  const out = { ...row };
  for(const e of embeds){
    const obj = {};
    let any = false;
    for(const c of e.cols){
      const k = `${e.alias}.${c}`;
      if(k in out){
        obj[c] = out[k];
        delete out[k];
        if(obj[c] !== null && obj[c] !== undefined) any = true;
      }
    }
    out[e.alias] = any ? obj : null;
  }
  return out;
}

async function handleRest(req, res, url){
  const table = url.pathname.replace('/rest/v1/','').replace(/\/$/,'');
  if(!/^[a-z_]+$/.test(table)) { res.writeHead(404); return res.end('{}'); }
  const sp = url.searchParams;
  const prefer = String(req.headers['prefer']||'');
  const wantObject = String(req.headers['accept']||'').includes('vnd.pgrst.object');
  const wantCount = prefer.includes('count=exact');
  const sel = (sp.get('select') && sp.get('select') !== '*')
    ? parseSelect(sp.get('select'), table) : { select: '*', joins: '', embeds: [] };
  const { where, params } = parseFilters(sp, table);
  const order = parseOrder(sp);
  const limit = sp.get('limit') ? ` LIMIT ${parseInt(sp.get('limit'),10)}` : '';

  const send = async (rows, count)=>{
    const hdrs = { 'Content-Type':'application/json' };
    if(wantCount) hdrs['Content-Range'] = `0-${Math.max(rows.length-1,0)}/${count ?? rows.length}`;
    if(wantObject){
      if(rows.length !== 1){
        res.writeHead(406, hdrs);
        return res.end(JSON.stringify({ code:'PGRST116', message:`JSON object requested, multiple (or no) rows returned: ${rows.length}`, details:`Results contain ${rows.length} rows` }));
      }
      res.writeHead(200, hdrs); return res.end(JSON.stringify(rows[0]));
    }
    res.writeHead(200, hdrs); return res.end(JSON.stringify(rows));
  };

  try{
    if(req.method === 'GET'){
      const r = await pool.query(`SELECT ${sel.select} FROM ${table}${sel.joins}${where}${order}${limit}`, params);
      const rows = r.rows.map(row => assembleEmbeds(row, sel.embeds));
      let count;
      if(wantCount){ const cr = await pool.query(`SELECT count(*)::int AS n FROM ${table}${where}`, params); count = cr.rows[0].n; }
      return send(rows, count);
    }
    if(req.method === 'POST'){
      const body = await jsonBody(req);
      const rows = Array.isArray(body) ? body : [body];
      if(!rows.length) return send([]);
      const keys = [...new Set(rows.flatMap(r=>Object.keys(r)))];
      const qk = keys.map(k=>'"'+k.replace(/"/g,'')+'"');
      const vals = [], tuples = [];
      for(const r of rows){
        const ph = keys.map(k=>{ vals.push(pgVal(r[k])); return '$'+vals.length; });
        tuples.push('('+ph.join(',')+')');
      }
      let conflict = '';
      const oc = sp.get('on_conflict');
      if(oc && prefer.includes('resolution=merge-duplicates')){
        const ocCols = oc.split(',').map(c=>'"'+c.trim()+'"').join(',');
        const sets = qk.map(k=>`${k}=EXCLUDED.${k}`).join(',');
        conflict = ` ON CONFLICT (${ocCols}) DO UPDATE SET ${sets}`;
      } else if(oc){
        conflict = ` ON CONFLICT (${oc.split(',').map(c=>'"'+c.trim()+'"').join(',')}) DO NOTHING`;
      }
      const r = await pool.query(`INSERT INTO ${table} (${qk.join(',')}) VALUES ${tuples.join(',')}${conflict} RETURNING *`, vals);
      return send(r.rows);
    }
    if(req.method === 'PATCH'){
      const body = await jsonBody(req);
      const sets = [], vals = [];
      for(const [k,v] of Object.entries(body)){ vals.push(pgVal(v)); sets.push(`"${k.replace(/"/g,'')}"=$${vals.length}`); }
      const { where: w2, params: p2 } = parseFilters(sp, table);
      const shifted = w2.replace(/\$(\d+)/g, (_,n)=>'$'+(Number(n)+vals.length));
      const r = await pool.query(`UPDATE ${table} SET ${sets.join(',')}${shifted} RETURNING *`, [...vals, ...p2]);
      return send(r.rows);
    }
    if(req.method === 'DELETE'){
      const r = await pool.query(`DELETE FROM ${table}${where} RETURNING *`, params);
      return send(r.rows);
    }
    res.writeHead(405); res.end('{}');
  }catch(e){
    res.writeHead(400, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ code:'E2E', message: String(e.message||e) }));
  }
}

/* ── server ── */
export function start(port = 54321){
  const server = http.createServer(async (req, res)=>{
    const url = new URL(req.url, 'http://x');
    // GoTrue
    if(url.pathname === '/auth/v1/admin/users' && req.method === 'POST'){
      const b = await jsonBody(req);
      const u = makeUser(b.email, b.password, b.user_metadata);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(publicUser(u)));
    }
    if(url.pathname === '/auth/v1/signup' && req.method === 'POST'){
      // Standard client sign-up path (supabase.auth.signUp). Hosted semantics
      // with "Confirm email" on: the user is created UNCONFIRMED, the mailer
      // dispatched the link (confirmation_sent_at set) and NO session is
      // returned — sign-in stays blocked until the owner confirms. The
      // emulator's token route below stays lenient on purpose so the journey
      // exercises the app-level pending -> active gate end to end.
      const b = await jsonBody(req);
      const u = makeUser(b.email, b.password, b.data || b.user_metadata);
      u.email_confirmed_at = null;
      u.emailConfirmedAt = null;
      u.confirmation_sent_at = new Date().toISOString();
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ user: publicUser(u), session: null }));
    }
    if(url.pathname === '/auth/v1/token' && req.method === 'POST'){
      const b = await jsonBody(req);
      const u = [...users.values()].find(x=>x.email === b.email && x.password === b.password);
      if(!u){ res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ error:'invalid_grant', error_description:'Invalid login credentials', msg:'Invalid login credentials', code:400 })); }
      const access_token = issueToken(u);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ access_token, token_type:'bearer', expires_in:3600, refresh_token:'e2e_refresh', user: publicUser(u) }));
    }
    if(url.pathname === '/auth/v1/user' && req.method === 'GET'){
      const t = String(req.headers['authorization']||'').replace('Bearer ','');
      const uid = tokens.get(t);
      if(!uid){ res.writeHead(401, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ msg:'invalid token', code:401 })); }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(publicUser(users.get(uid))));
    }
    // PostgREST
    if(url.pathname.startsWith('/rest/v1/')) return handleRest(req, res, url);
    // Warm voice-audio cache: the voice path (operator-voice / telnyx-voice)
    // refuses to run without Lola's canonical voice, so the e2e serves the
    // cached audio HEAD/GET it checks (speakCached) — the real cache-hit branch,
    // zero external network.
    if(url.pathname.startsWith('/storage/v1/object/public/')){
      res.writeHead(200, { 'Content-Type':'audio/mpeg', 'Content-Length':'0' });
      return res.end();
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise(r=>server.listen(port, '127.0.0.1', ()=>r(server)));
}

if(import.meta.url === `file://${process.argv[1]}`){
  start().then(()=>console.log('supabase emulator on :54321'));
}
