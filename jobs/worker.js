// jobs/worker.js
// Simple worker that polls the jobs table and processes jobs.
// Run this in a background process (Node) on a worker dyno or server.

import fetch from 'node-fetch';
import { db } from '../api/lib/db.js';

const POLL_INTERVAL_MS = process.env.WORKER_POLL_INTERVAL_MS ? parseInt(process.env.WORKER_POLL_INTERVAL_MS) : 3000;
const MAX_ATTEMPTS = 5;

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function claimJob(c, id){
  // Attempt to transition a pending job -> processing atomically
  const now = new Date().toISOString();
  const { data, error } = await c.from('jobs').update({ status: 'processing', updated_at: now }).match({ id, status: 'pending' }).select().maybeSingle();
  if(error) return null;
  return data || null;
}

async function fetchPendingJob(c){
  const { data } = await c.from('jobs').select('id').eq('status','pending').order('created_at',{ ascending:true }).limit(1);
  return data?.[0]?.id || null;
}

async function markJobSuccess(c, id, meta = {}){
  await c.from('jobs').update({ status: 'succeeded', updated_at: new Date().toISOString(), payload: meta }).eq('id', id);
}

async function markJobFailed(c, id, errMsg){
  await c.from('jobs').update({ status: 'failed', last_error: String(errMsg), attempts: (Math.min(MAX_ATTEMPTS, (await getAttempts(c,id))+1)), updated_at: new Date().toISOString() }).eq('id', id);
}

async function incrementAttempts(c, id){
  const attempts = await getAttempts(c,id);
  await c.from('jobs').update({ attempts: attempts + 1, updated_at: new Date().toISOString() }).eq('id', id);
}

async function getAttempts(c, id){
  const { data } = await c.from('jobs').select('attempts').eq('id', id).maybeSingle();
  return data?.attempts || 0;
}

async function processDemoCall(c, job){
  const payload = job.payload || {};
  const { demo_request_id, phone } = payload;
  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const TELNYX_VOICE_APP_ID = process.env.TELNYX_VOICE_APP_ID;
  const FROM_NUMBER = process.env.DEMO_FROM_NUMBER || process.env.TELNYX_FROM_NUMBER;

  if(!TELNYX_API_KEY || !TELNYX_VOICE_APP_ID || !FROM_NUMBER){
    throw new Error('Telnyx not configured on worker');
  }

  // attempt to create a Telnyx outbound call
  const resp = await fetch('https://api.telnyx.com/v2/calls', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ connection_id: TELNYX_VOICE_APP_ID, from: FROM_NUMBER, to: phone, if_machine: 'continue' })
  });

  if(!resp.ok){
    const text = await resp.text();
    throw new Error(`telnyx-error:${resp.status}:${text}`);
  }
  const json = await resp.json();

  // update demo_requests with metadata
  if(demo_request_id){
    await c.from('demo_requests').update({ processed: true, metadata: json }).eq('id', demo_request_id);
  }

  return json;
}

async function processJob(c, jobId){
  try{
    const claimed = await claimJob(c, jobId);
    if(!claimed) return; // someone else grabbed it
    const job = claimed;
    if(!job) return;

    if(job.attempts >= MAX_ATTEMPTS){
      await c.from('jobs').update({ status: 'failed', last_error: 'max attempts reached', updated_at: new Date().toISOString() }).eq('id', job.id);
      return;
    }

    try{
      if(job.type === 'demo_call'){
        const result = await processDemoCall(c, job);
        await c.from('jobs').update({ status: 'succeeded', updated_at: new Date().toISOString(), payload: { ...job.payload, result } }).eq('id', job.id);
      } else if(job.type === 'tts'){ 
        // Placeholder: implement TTS job processing (synthesize and upload) in future
        await c.from('jobs').update({ status: 'failed', last_error: 'tts not implemented', updated_at: new Date().toISOString() }).eq('id', job.id);
      } else {
        await c.from('jobs').update({ status: 'failed', last_error: `unknown job type ${job.type}`, updated_at: new Date().toISOString() }).eq('id', job.id);
      }
    }catch(e){
      console.error('job processing error', e);
      // increment attempts and set status back to pending for retry/backoff
      const attempts = (job.attempts || 0) + 1;
      const now = new Date().toISOString();
      const nextStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await c.from('jobs').update({ attempts, last_error: String(e?.message||e), status: nextStatus, updated_at: now }).eq('id', job.id);
    }
  }catch(e){
    console.error('processJob top error', e);
  }
}

async function loop(){
  const c = db();
  if(!c) { console.error('Supabase not configured for worker'); return; }
  while(true){
    try{
      const pendingId = await fetchPendingJob(c);
      if(pendingId){
        await processJob(c, pendingId);
      }
    }catch(e){ console.error('worker loop error', e); }
    await sleep(POLL_INTERVAL_MS);
  }
}

if(require.main === module){
  console.log('Starting jobs worker...');
  loop().catch(e=>{ console.error('worker failed', e); process.exit(1); });
}
