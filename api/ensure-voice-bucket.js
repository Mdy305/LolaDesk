/**
 * /api/ensure-voice-bucket — Creates the Supabase Storage bucket for TTS audio
 * POST /api/ensure-voice-bucket
 *
 * Creates 'voice-audio' bucket if it doesn't exist, makes it public.
 * Required for ElevenLabs voice playback via <Play> on phone calls.
 */
import { db } from './lib/db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured' });

  const BUCKET = 'voice-audio';
  const results = { steps: [] };

  try {
    // List existing buckets
    const { data: buckets, error: listErr } = await c.storage.listBuckets();
    results.steps.push({ step: 'list_buckets', ok: !listErr, count: buckets?.length || 0 });

    const exists = buckets?.some(b => b.name === BUCKET);

    if(!exists){
      // Create the bucket
      const { data, error } = await c.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 5242880, // 5MB max
        allowedMimeTypes: ['audio/mpeg']
      });
      results.steps.push({ 
        step: 'create_bucket', 
        ok: !error, 
        error: error?.message || null 
      });
    } else {
      results.steps.push({ step: 'bucket_exists', ok: true });
    }

    // Verify the bucket is accessible
    const { data: testList, error: testErr } = await c.storage.from(BUCKET).list('', { limit: 1 });
    results.steps.push({ 
      step: 'verify_bucket', 
      ok: !testErr, 
      fileCount: testList?.length || 0,
      error: testErr?.message || null
    });

    return res.status(200).json({ ok: true, bucket: BUCKET, results });
  } catch(e){
    return res.status(500).json({ error: String(e?.message || e), results });
  }
}
