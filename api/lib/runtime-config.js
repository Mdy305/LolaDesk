export function missingEnv(required = [], env = process.env){
  return required.filter((key) => !env[key]);
}

export function describeMissingEnv(required = [], env = process.env){
  const missing = missingEnv(required, env);
  return {
    ok: missing.length === 0,
    missing,
    message: missing.length ? `Missing required env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` : ''
  };
}

export function supabaseConfigStatus(env = process.env){
  return describeMissingEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'], env);
}

export function telnyxConfigStatus({ voice = false, messaging = false, signature = false } = {}, env = process.env){
  const required = ['TELNYX_API_KEY'];
  if(voice) required.push('TELNYX_VOICE_APP_ID');
  if(messaging) required.push('TELNYX_MESSAGING_PROFILE');
  if(signature) required.push('TELNYX_PUBLIC_KEY');
  return describeMissingEnv(required, env);
}
