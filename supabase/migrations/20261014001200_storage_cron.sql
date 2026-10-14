-- Storage bucket for tenant media and Supabase Cron for the outbox.
-- Both blocks are conditional so the same migrations also run on the plain
-- local PostgreSQL stack, which has no storage schema and no pg_cron.

do $storage$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tenant-media', 'tenant-media', true, 5242880,
            array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    -- Public read is served by the public bucket URL. Owners may write only
    -- below "<tenant_id>/owner/"; pipeline files ("<tenant_id>/pipeline/")
    -- are uploaded with the service role.
    execute $p$
      create policy tenant_media_owner_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'tenant-media'
        and (storage.foldername(name))[2] = 'owner'
        and private.is_member(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy tenant_media_owner_update on storage.objects for update to authenticated
      using (bucket_id = 'tenant-media'
        and (storage.foldername(name))[2] = 'owner'
        and private.is_member(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy tenant_media_owner_delete on storage.objects for delete to authenticated
      using (bucket_id = 'tenant-media'
        and (storage.foldername(name))[2] = 'owner'
        and private.is_member(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end
$storage$;

create function private.cleanup_counters() returns void
language sql security definer set search_path = ''
as $$
  delete from private.rate_limit_counters where window_start < now() - interval '1 day';
  delete from public.order_requests where created_at < now() - interval '30 days';
$$;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    -- The project URL and the shared cron secret live in Supabase Vault
    -- (see SETUP.md, "Cron"). Nothing secret is stored in this migration.
    perform cron.schedule('notify-dispatch', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/notify-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000)
    $job$);
    perform cron.schedule('cleanup-counters', '17 3 * * *', 'select private.cleanup_counters()');
  end if;
end
$cron$;
