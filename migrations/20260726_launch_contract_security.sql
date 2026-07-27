-- Harden public helper functions flagged by the Supabase security advisor.
-- These functions intentionally remain SECURITY INVOKER.

alter function public.set_updated_at() set search_path = '';
alter function public.update_updated_at_column() set search_path = '';
alter function public.auth_tenant() set search_path = '';

-- auth_tenant is used by RLS policies and must remain callable by API roles.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.update_updated_at_column() from public, anon, authenticated;
revoke execute on function public.auth_tenant() from public, anon;
grant execute on function public.auth_tenant() to authenticated;
