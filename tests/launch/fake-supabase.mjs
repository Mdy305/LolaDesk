// In-memory stand-in for @supabase/supabase-js used by the pack tests.
export const T = globalThis.__T || (globalThis.__T = {});
const isTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
const cmp = (a, b) => (isTime(a) && isTime(b)) ? (Date.parse(a) - Date.parse(b)) : (a < b ? -1 : a > b ? 1 : 0);
function match(r, f) {
  const v = r[f.col];
  switch (f.op) {
    case 'eq': return v === f.val || (v != null && f.val != null && String(v) === String(f.val));
    case 'neq': return v !== f.val;
    case 'in': return f.val.includes(v);
    case 'gt': return v != null && cmp(v, f.val) > 0;
    case 'gte': return v != null && cmp(v, f.val) >= 0;
    case 'lt': return v != null && cmp(v, f.val) < 0;
    case 'lte': return v != null && cmp(v, f.val) <= 0;
    case 'is': return f.val === null ? v == null : v === f.val;
    case 'ilike': return new RegExp('^' + String(f.val).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i').test(String(v ?? ''));
    case 'not': return f.val2 === null ? v != null : v !== f.val2;
    default: return true;
  }
}
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.one = false; this.maybe = false; this.ord = null; this.lim = null; }
  select(c, o) { if (o && o.count) this.cnt = true; if (o && o.head) this.head = true; return this; }
  eq(c, v) { this.f.push({ col: c, op: 'eq', val: v }); return this; }
  neq(c, v) { this.f.push({ col: c, op: 'neq', val: v }); return this; }
  in(c, v) { this.f.push({ col: c, op: 'in', val: v }); return this; }
  gt(c, v) { this.f.push({ col: c, op: 'gt', val: v }); return this; }
  gte(c, v) { this.f.push({ col: c, op: 'gte', val: v }); return this; }
  lt(c, v) { this.f.push({ col: c, op: 'lt', val: v }); return this; }
  lte(c, v) { this.f.push({ col: c, op: 'lte', val: v }); return this; }
  is(c, v) { this.f.push({ col: c, op: 'is', val: v }); return this; }
  ilike(c, v) { this.f.push({ col: c, op: 'ilike', val: v }); return this; }
  not(c, o, v) { this.f.push({ col: c, op: 'not', val2: v }); return this; }
  filter(c, o, v) { this.f.push({ col: c, op: o, val: v }); return this; }
  or() { return this; }
  order(c, o) { this.ord = { c, asc: o?.ascending !== false }; return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.lim = b + 1; return this; }
  insert(p) { this.op = 'insert'; this.p = p; return this; }
  update(p) { this.op = 'update'; this.p = p; return this; }
  upsert(p, o) { this.op = 'upsert'; this.p = p; this.conflict = o && o.onConflict ? String(o.onConflict).split(',').map(x => x.trim()) : null; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.maybe = true; return this; }
  then(res, rej) { try { return Promise.resolve(this.run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } }
  run() {
    const rows = T[this.t] || (T[this.t] = []);
    const pick = (list) => ({ data: this.head ? null : (this.one || this.maybe) ? (list[0] || null) : list, error: null, count: this.cnt ? list.length : null });
    if (globalThis.__missing && globalThis.__missing.has(this.t)) return { data: null, error: { message: `relation "${this.t}" does not exist` } };
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = (Array.isArray(this.p) ? this.p : [this.p]).map(p => ({ id: p.id || ('id_' + Math.random().toString(36).slice(2, 9)), created_at: new Date().toISOString(), ...p }));
      if (this.op === 'upsert' && this.conflict) for (const n of list) { const i = rows.findIndex(r => this.conflict.every(k => r[k] === n[k])); if (i >= 0) { Object.assign(rows[i], n, { id: rows[i].id }); list[list.indexOf(n)] = rows[i]; continue; } rows.push(n); }
      else rows.push(...list);
      return pick(list);
    }
    let out = rows.filter(r => this.f.every(f => match(r, f)));
    if (this.op === 'update') { out.forEach(r => Object.assign(r, this.p)); return pick(out); }
    if (this.op === 'delete') { T[this.t] = rows.filter(r => !out.includes(r)); return pick(out); }
    if (this.ord) out = out.slice().sort((a, b) => cmp(a[this.ord.c], b[this.ord.c]) * (this.ord.asc ? 1 : -1));
    if (this.lim) out = out.slice(0, this.lim);
    return pick(out);
  }
}
// Storage, in memory: buckets in T.__buckets ({ name: { public, files: {path: bytes} } }).
function fakeStorage() {
  const B = () => (T.__buckets || (T.__buckets = {}));
  const url = (b, p) => `https://fake.supabase.co/storage/v1/object/public/${b}/${p}`;
  return {
    getBucket: async (name) => B()[name] ? { data: { name, public: B()[name].public }, error: null } : { data: null, error: { message: 'Bucket not found' } },
    createBucket: async (name, o = {}) => { B()[name] = { public: !!o.public, files: {} }; return { data: { name }, error: null }; },
    updateBucket: async (name, o = {}) => { if (!B()[name]) return { data: null, error: { message: 'Bucket not found' } }; B()[name].public = !!o.public; return { data: {}, error: null }; },
    from: (b) => ({
      upload: async (p, bytes) => { if (!B()[b]) return { data: null, error: { message: 'Bucket not found' } }; B()[b].files[p] = bytes; return { data: { path: p }, error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: url(b, p) } }),
    }),
  };
}
export function createClient() {
  return { from: (t) => new Q(t), rpc: async () => ({ data: null, error: { message: 'no rpc' } }),
    auth: { getUser: async (token) => {                 // tests may map token → user via globalThis.__authUsers
      const u = (globalThis.__authUsers || {})[token];
      return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'no auth' } };
    }, admin: {} },
    storage: fakeStorage(), channel: () => ({ on() { return this; }, subscribe() { return this; } }) };
}
export default { createClient };
