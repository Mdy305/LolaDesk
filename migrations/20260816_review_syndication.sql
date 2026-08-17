-- ============================================================================
-- Review Syndication pipeline (idempotent)
-- 5-star reviews -> rendered 1080x1080 cards -> Meta Graph API publish cron
-- ============================================================================
-- Queue holds the ONLY reviews that survive the filter (rating = 5 and body
-- longer than 10 chars). content_hash (sha-256 of author + body) makes the
-- queue de-duplicated: the same review can never be scheduled twice.
--
-- Meta credentials are NOT stored here. They live per-tenant on the
-- `integrations` table (provider 'meta': encrypted access_token +
-- metadata.page_id / metadata.ig_user_id) and fall back to the
-- META_ACCESS_TOKEN / META_PAGE_ID / META_IG_ID env vars for a single
-- default tenant. See api/lib/review-syndication.js resolveMetaConfig().

create table if not exists review_queue (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  source         text not null check (source in ('google_gmb','yelp_csv','shopify','manual_csv')),
  content_hash   text not null unique,
  author_name    text not null,
  rating         integer not null check (rating = 5),
  review_body    text not null,
  image_url      text,                                  -- rendered card in review-cards bucket
  status         text not null default 'scheduled'
                 check (status in ('queued','scheduled','published','failed')),
  scheduled_for  timestamptz not null default now(),    -- staggered +48h apart
  meta_post_id   text,                                  -- facebook post id / ig media id
  error_message  text,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);

create index if not exists idx_review_queue_due  on review_queue (tenant_id, status, scheduled_for);
create index if not exists idx_review_queue_hash on review_queue (content_hash);

-- Reads go through the service-role client in this codebase; RLS is enabled
-- with a tenant-scoped read policy so a leaked anon key cannot enumerate the
-- queue. Default is deny.
alter table review_queue enable row level security;
drop policy if exists review_queue_read on review_queue;
create policy review_queue_read on review_queue
  for select using (tenant_id = auth_tenant());

-- ── storage: public review-cards bucket ───────────────────────────
-- Public read is required: Meta's Graph API must fetch the card image by URL
-- anonymously. Only server endpoints write here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-cards', 'review-cards', true, 5242880, array['image/png','image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists review_cards_public_read on storage.objects;
create policy review_cards_public_read on storage.objects
  for select using (bucket_id = 'review-cards');
