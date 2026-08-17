/**
 * tests/fake-supabase.js — in-memory Supabase stand-in for tests.
 *
 * Mimics the slice of @supabase/supabase-js the booking stack actually uses:
 * a thenable query builder with .select/.eq/.neq/.gt/.gte/.lt/.lte/.in/.ilike/
 * .not/.or/.order/.limit/.single/.maybeSingle and insert/update/upsert/delete.
 *
 * It also fakes two DB-level defaults so the booking flow behaves like the
 * real schema: a generated `id` on insert, and a generated `hold_token` for
 * availability_holds.
 */

const COMPARATORS = {
  eq:  (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt:  (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt:  (a, b) => a < b,
  lte: (a, b) => a <= b
};

function colGet(row, col) {
  if (col in row) return row[col];
  // Supabase foreign-table filters: 'staff.tenant_id' -> row.tenant_id
  const dot = col.indexOf('.');
  if (dot > 0) return row[col.slice(dot + 1)];
  return undefined;
}

function matchOr(row, expr) {
  const clauses = String(expr).split(',').map(s => s.trim()).filter(Boolean);
  return clauses.some(clause => {
    const i = clause.indexOf('.');
    if (i < 0) return false;
    const col = clause.slice(0, i);
    const rest = clause.slice(i + 1);
    const j = rest.indexOf('.');
    const op = j < 0 ? rest : rest.slice(0, j);
    const rawVal = j < 0 ? null : rest.slice(j + 1);
    const v = colGet(row, col);
    if (op === 'is' && rawVal === 'null') return v == null;
    if (COMPARATORS[op]) return COMPARATORS[op](v, rawVal);
    return false;
  });
}

export class FakeSupabase {
  constructor() {
    this.tables = new Map();
    this._seq = 0;
    this.storage = {
      buckets: new Map(),
      from(bucket) {
        return {
          upload: async (path, data, opts) => {
            this.buckets.set(bucket, { ...(this.buckets.get(bucket) || {}), [path]: { data, opts } });
            return { error: null };
          },
          getPublicUrl: (path) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}` } })
        };
      }
    };
    this.auth = {
      users: new Map(), // token -> user object
      signInWithOAuthCalls: [],
      async signInWithOAuth({ provider, options = {} }) {
        this.signInWithOAuthCalls.push({ provider, options });
        const q = new URLSearchParams({
          provider,
          redirect_to: options.redirectTo || '',
          flow: options.flowType || 'pkce'
        });
        return { data: { url: `https://fake.supabase.co/auth/v1/authorize?${q.toString()}` }, error: null };
      },
      async getUser(token) {
        const user = this.users.get(token);
        return user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid token' } };
      }
    };
  }
  from(table) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new FakeQueryBuilder(this, table, this.tables.get(table));
  }
  seed(table, rows) {
    this.tables.set(table, rows.map(r => ({ ...r })));
  }
  all(table) {
    return this.tables.get(table) || [];
  }
  reset() {
    this.tables.clear();
    this._seq = 0;
  }
  nextId(table) {
    this._seq += 1;
    return `fake-${table}-${this._seq}`;
  }
  // Stand-in for supabase.rpc(). The migration runner only calls
  // rpc('exec_sql', …) when a table is MISSING, which the seeded fake never
  // simulates; return an error so an accidental call fails loudly instead of
  // silently doing nothing.
  async rpc() {
    return { data: null, error: { message: 'rpc() not supported by FakeSupabase' } };
  }
}

class FakeQueryBuilder {
  constructor(client, table, rows) {
    this.client = client;
    this.table = table;
    this.rows = rows;
    this._action = 'select';
    this._selectCols = null;
    this._count = false;
    this._filters = [];
    this._order = null;
    this._limit = null;
    this._values = null;
    this._patch = null;
    this._onConflict = null;
    this._ran = false;
    this._result = null;
  }

  // ── thenable + promise surface ──────────────────────────────────
  _run() {
    return Promise.resolve().then(() => this._exec());
  }
  then(res, rej) {
    return this._run().then(res, rej);
  }
  catch(rej) {
    return this._run().catch(rej);
  }
  finally(cb) {
    return this._run().finally(cb);
  }

  // ── chainable query methods ─────────────────────────────────────
  select(...cols) {
    this._selectCols = cols.length ? cols : ['*'];
    if (cols.some(c => c && typeof c === 'object' && c.count === 'exact')) this._count = true;
    return this;
  }
  eq(col, val)   { this._filters.push({ op: 'eq', col, val }); return this; }
  neq(col, val)  { this._filters.push({ op: 'neq', col, val }); return this; }
  gt(col, val)   { this._filters.push({ op: 'gt', col, val }); return this; }
  gte(col, val)  { this._filters.push({ op: 'gte', col, val }); return this; }
  lt(col, val)   { this._filters.push({ op: 'lt', col, val }); return this; }
  lte(col, val)  { this._filters.push({ op: 'lte', col, val }); return this; }
  in(col, vals)  { this._filters.push({ op: 'in', col, vals }); return this; }
  ilike(col, pattern) { this._filters.push({ op: 'ilike', col, val: pattern }); return this; }
  not(col, op, val) { this._filters.push({ op: 'not', col, notOp: op, val }); return this; }
  or(expr)       { this._filters.push({ op: 'or', expr }); return this; }
  order(col, opts = {}) {
    this._order = { col, dir: opts.ascending === false ? 'desc' : 'asc' };
    return this;
  }
  limit(n) { this._limit = n; return this; }

  insert(rows) { this._action = 'insert'; this._values = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this._action = 'update'; this._patch = patch; return this; }
  upsert(rows, opts = {}) { this._action = 'upsert'; this._values = Array.isArray(rows) ? rows : [rows]; this._onConflict = opts.onConflict; return this; }
  delete() { this._action = 'delete'; return this; }

  // ── terminal methods ────────────────────────────────────────────
  single() {
    return this._run().then(r => {
      const row = r.data?.[0] ?? null;
      return { data: row, error: row ? null : { message: 'JSON object requested, multiple (or no) rows returned' } };
    });
  }
  maybeSingle() {
    return this._run().then(r => ({ data: r.data?.[0] ?? null, error: null }));
  }

  _match(row) {
    for (const f of this._filters) {
      if (f.op === 'or') { if (!matchOr(row, f.expr)) return false; continue; }
      if (f.op === 'in') { if (!f.vals.includes(colGet(row, f.col))) return false; continue; }
      if (f.op === 'ilike') {
        const v = String(colGet(row, f.col) || '').toLowerCase();
        const p = String(f.val || '').replace(/%/g, '').toLowerCase();
        if (!v.includes(p)) return false;
        continue;
      }
      if (f.op === 'not') {
        const v = colGet(row, f.col);
        if (f.notOp === 'is' && f.val === null) { if (v != null) return false; }
        else if (COMPARATORS[f.notOp] && COMPARATORS[f.notOp](v, f.val)) return false;
        continue;
      }
      if (COMPARATORS[f.op] && !COMPARATORS[f.op](colGet(row, f.col), f.val)) return false;
    }
    return true;
  }

  _withDefaults(row) {
    const out = { ...row };
    if (!out.id) out.id = this.client.nextId(this.table);
    if (this.table === 'availability_holds' && !out.hold_token) out.hold_token = `hold-${this.client.nextId('hold')}`;
    return out;
  }

  _exec() {
    if (this._ran) return this._result;
    this._ran = true;
    let result;

    switch (this._action) {
      case 'select': {
        let out = this.rows.filter(r => this._match(r));
        if (this._order) {
          const { col, dir } = this._order;
          const sign = dir === 'asc' ? 1 : -1;
          out = out.slice().sort((a, b) => {
            const av = colGet(a, col), bv = colGet(b, col);
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av < bv ? -1 : av > bv ? 1 : 0) * sign;
          });
        }
        if (this._limit != null) out = out.slice(0, this._limit);
        // Return shallow copies so a later update/upsert (which mutates the
        // stored rows in place) can't retroactively change an earlier read
        // snapshot — matching real Supabase, which returns fresh JSON.
        out = out.map(r => ({ ...r }));
        result = { data: out, error: null };
        if (this._count) result.count = out.length;
        break;
      }
      case 'insert': {
        const inserted = this._values.map(v => this._withDefaults(v));
        this.rows.push(...inserted);
        result = { data: this._selectCols ? inserted : null, error: null };
        break;
      }
      case 'update': {
        const matched = this.rows.filter(r => this._match(r));
        for (const r of matched) Object.assign(r, this._patch);
        result = { data: this._selectCols ? matched : null, error: null };
        break;
      }
      case 'upsert': {
        const conflictCols = this._onConflict ? String(this._onConflict).split(',').map(s => s.trim()) : [];
        const out = [];
        for (const v of this._values) {
          const existing = conflictCols.length
            ? this.rows.find(r => conflictCols.every(c => r[c] === v[c]))
            : null;
          if (existing) { Object.assign(existing, v); out.push(existing); }
          else { const row = this._withDefaults(v); this.rows.push(row); out.push(row); }
        }
        result = { data: this._selectCols ? out : null, error: null };
        break;
      }
      case 'delete': {
        const removed = this.rows.filter(r => this._match(r));
        const keep = this.rows.filter(r => !this._match(r));
        this.client.tables.set(this.table, keep);
        this.rows = keep;
        result = { data: this._selectCols ? removed : null, error: null };
        break;
      }
      default:
        result = { data: [], error: null };
    }

    this._result = result;
    return result;
  }
}

export default FakeSupabase;
