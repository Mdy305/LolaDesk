import { db } from './lib/db.js';

/**
 * Simple queue helpers that write to the `jobs` table and optionally return the job id.
 * This is intentionally small — the worker (jobs/worker.js) polls the jobs table and processes jobs.
 */
export async function enqueueJob({ type, payload = {}, idempotencyKey = null }){
  const c = db();
  if(!c) throw new Error('Supabase not configured');
  // Try to insert a job, respecting idempotency (unique index on idempotency_key)
  try{
    const insert = await c.from('jobs').insert({ type, payload, idempotency_key: idempotencyKey }).select().maybeSingle();
    const job = insert?.data || null;
    return job;
  }catch(e){
    // If idempotency_key conflict, try to find the existing job
    if(idempotencyKey){
      try{
        const { data } = await c.from('jobs').select().eq('idempotency_key', idempotencyKey).maybeSingle();
        return data || null;
      }catch(_){ /* fallthrough */ }
    }
    throw e;
  }
}

export async function getJob(jobId){
  const c = db(); if(!c) throw new Error('Supabase not configured');
  const { data } = await c.from('jobs').select().eq('id', jobId).maybeSingle();
  return data || null;
}
