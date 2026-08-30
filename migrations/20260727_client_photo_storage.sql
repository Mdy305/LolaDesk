-- Private client profile photos. Files are written and signed only by
-- authenticated, tenant-scoped server endpoints using the service client.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('client-photos','client-photos',false,2097152,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
