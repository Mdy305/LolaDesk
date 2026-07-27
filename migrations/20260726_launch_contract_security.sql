-- Harden public helper functions flagged by the Supabase security advisor.
-- Service-role-only tables intentionally keep RLS enabled with no browser policies.

alter function public.set_updated_at() set search_path = '';
alter function public.update_updated_at_column() set search_path = '';
alter function public.auth_tenant() set search_path = '';
alter function public.current_tenant_id() set search_path = '';
alter function public.handle_new_tenant() set search_path = '';
alter function public.match_client_memories(extensions.vector, uuid, uuid, double precision, integer)
  set search_path = 'public, extensions';

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.update_updated_at_column() from public, anon, authenticated;
revoke execute on function public.auth_tenant() from public, anon;
grant execute on function public.auth_tenant() to authenticated;
revoke execute on function public.handle_new_tenant() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.match_client_memories(extensions.vector, uuid, uuid, double precision, integer)
  from public, anon, authenticated;

-- Public buckets serve object URLs without a broad object-listing policy.
drop policy if exists voice_audio_public_read on storage.objects;

-- Keep extension objects out of the API-exposed public schema.
create schema if not exists extensions;
alter extension vector set schema extensions;
