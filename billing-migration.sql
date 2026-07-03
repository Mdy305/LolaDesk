-- Add billing status to tenants (run in Supabase SQL editor)
alter table tenants add column if not exists billing_status text default 'trial';
-- values: trial | active | past_due | cancelled
