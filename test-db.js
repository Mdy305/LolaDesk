import { db } from './api/lib/db.js';
async function run() {
  const c = db();
  if(!c) { console.log('no db'); return; }
  const { data, error } = await c.from('tenants').select('*').limit(1);
  console.log(data?.[0]);
}
run();
