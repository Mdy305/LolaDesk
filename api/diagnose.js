/**
 * /api/diagnose — Safe environment diagnostic, no secrets ever returned
 * ════════════════════════════════════════════════════════════════
 * Visit this URL to see exactly what the running deployment can see,
 * without exposing any actual key/secret values. Use this instead of
 * guessing back and forth about "is the env var really set" — this
 * reads process.env directly from the live function and reports
 * presence, length, and basic shape validation only.
 *
 * Safe to leave deployed; reveals no secrets. Delete once debugging
 * is done if you want to reduce surface area, but it's not a risk
 * to leave it.
 */
function shape(name, value, expectedPrefix){
  if(!value) return { name, present:false };
  const info = { name, present:true, length: value.length };
  if(expectedPrefix) info.looksRight = value.startsWith(expectedPrefix);
  return info;
}

export default async function handler(req, res){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  const checks = [
    shape('SUPABASE_URL', url, 'https://'),
    shape('SUPABASE_SERVICE_KEY', key, 'eyJ'),
    shape('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY, 'sk-ant-'),
    shape('TELNYX_API_KEY', process.env.TELNYX_API_KEY, 'KEY'),
    shape('TELNYX_VOICE_APP_ID', process.env.TELNYX_VOICE_APP_ID),
    shape('ELEVENLABS_API_KEY', process.env.ELEVENLABS_API_KEY),
    shape('ELEVENLABS_VOICE_ID', process.env.ELEVENLABS_VOICE_ID),
    shape('INTEGRATION_ENCRYPTION_KEY', process.env.INTEGRATION_ENCRYPTION_KEY)
  ];

  // Try an ACTUAL connection, not just "is the string present" — this
  // is the real test, since a present-but-wrong URL/key would pass the
  // shape check but still fail to connect.
  let liveConnection = { attempted:false };
  if(url && key){
    liveConnection.attempted = true;
    try{
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(url, key, { auth:{ persistSession:false } });
      const { data, error, status } = await client.from('tenants').select('id', { count:'exact', head:true });
      if(error){
        liveConnection.ok = false;
        liveConnection.httpStatus = status;
        liveConnection.error = error.message;
        liveConnection.hint = status === 401 || status === 403
          ? 'Auth rejected -- SUPABASE_SERVICE_KEY value is likely wrong, truncated, or actually the anon key instead of service_role.'
          : /relation .* does not exist/i.test(error.message||'')
            ? 'Connected successfully, but the tenants table does not exist -- schema.sql was never run against this database.'
            : 'Connected to Supabase but the query failed -- see error message above.';
      } else {
        liveConnection.ok = true;
        liveConnection.message = 'Successfully connected and queried the tenants table.';
      }
    }catch(e){
      liveConnection.ok = false;
      liveConnection.error = String(e&&e.message||e);
      liveConnection.hint = 'Failed before even reaching Supabase -- SUPABASE_URL is likely malformed (should look like https://xxxxx.supabase.co with no trailing path).';
    }
  } else {
    liveConnection.skippedReason = !url ? 'SUPABASE_URL is not present in this running deployment' : 'SUPABASE_SERVICE_KEY is not present in this running deployment';
  }

  return res.status(200).json({
    note: 'No secret values are ever shown here -- only presence, length, and connection test results.',
    envVarsSeenByThisDeployment: checks,
    liveSupabaseConnectionTest: liveConnection
  });
}
