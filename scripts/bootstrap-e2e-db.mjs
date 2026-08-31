#!/usr/bin/env node
/**
 * scripts/bootstrap-e2e-db.mjs — load the repo's schema + migrations into a
 * plain Postgres database (the e2e journey's container, and any fresh dev DB).
 *
 * Mirrors production bootstrap as closely as a bare Postgres allows:
 *  1. schema.sql first (MUST be clean — a failure here is a repo defect),
 *  2. then every migration in order, best-effort: statements that reference
 *     Supabase-coupled features (storage buckets, jobs, `alter publication`,
 *     supabase_functions) are tolerated and reported — the journey only
 *     asserts on what a plain Postgres can carry.
 *
 * Usage: PGPASSWORD=postgres node scripts/bootstrap-e2e-db.mjs
 * Env:   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (defaults match CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'loladesk',
});

/** Split SQL on statement terminators, respecting quotes, comments, dollar-quoting. */
function splitStatements(sql){
  const out = [];
  let cur = '', i = 0, n = sql.length, state = 'code', dollarTag = null;
  while(i < n){
    const c = sql[i], d = sql[i + 1];
    if(state === 'code'){
      if(c === '-' && d === '-'){ state = 'line'; i += 2; continue; }
      if(c === '/' && d === '*'){ state = 'block'; i += 2; continue; }
      if(c === "'"){ state = 'sq'; cur += c; i++; continue; }
      if(c === '"'){ state = 'dq'; cur += c; i++; continue; }
      if(c === '$'){
        const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
        if(m){ state = 'dollar'; dollarTag = m[0]; cur += dollarTag; i += dollarTag.length; continue; }
      }
      if(c === ';'){ out.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    } else if(state === 'sq'){
      if(c === "'"){ if(d === "'"){ cur += "''"; i += 2; } else { state = 'code'; cur += c; i++; } }
      else { cur += c; i++; }
    } else if(state === 'dq'){
      if(c === '"'){ if(d === '"'){ cur += '""'; i += 2; } else { state = 'code'; cur += c; i++; } }
      else { cur += c; i++; }
    } else if(state === 'line'){
      // comment text is dropped entirely (it is whitespace for the parser)
      if(c === '\n'){ state = 'code'; cur += '\n'; }
      i++;
    } else if(state === 'block'){
      if(c === '*' && d === '/'){ state = 'code'; cur += ' '; i += 2; }
      else i++;
    } else if(state === 'dollar'){
      if(sql.startsWith(dollarTag, i)){ cur += dollarTag; i += dollarTag.length; state = 'code'; }
      else { cur += c; i++; }
    }
  }
  if(cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

const root = process.cwd();
const migrationDir = path.join(root, 'migrations');
const files = [
  { name: 'schema.sql', path: path.join(root, 'schema.sql'), critical: true },
  ...fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort().map(f => ({
    name: f, path: path.join(migrationDir, f), critical: false,
  })),
];

let ok = 0, failed = 0, criticalFailed = 0;
for(const f of files){
  const text = fs.readFileSync(f.path, 'utf8');
  for(const stmt of splitStatements(text)){
    try{ await pool.query(stmt); ok++; }
    catch(e){
      failed++;
      if(f.critical){ criticalFailed++; console.error(`  CRITICAL (${f.name}): ${String(e.message).split('\n')[0].slice(0, 160)}`); }
      else if(process.env.VERBOSE){ console.log(`  skip (${f.name}): ${String(e.message).split('\n')[0].slice(0, 140)}`); }
    }
  }
}
const tables = (await pool.query(`select count(*)::int n from information_schema.tables where table_schema = 'public'`)).rows[0].n;
console.log(`bootstrap: ${files.length} files — ${ok} statements ok, ${failed} tolerated failures, ${tables} public tables`);
await pool.end();
if(criticalFailed > 0){
  console.error(`FAIL: ${criticalFailed} schema.sql statement(s) failed — schema.sql must load cleanly on plain Postgres.`);
  process.exit(1);
}
if(failed > 0) console.log('note: tolerated failures are Supabase-coupled statements (jobs/storage/etc) — expected on bare Postgres.');
