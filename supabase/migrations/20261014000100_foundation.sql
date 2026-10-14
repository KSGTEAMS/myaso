-- Foundation: extensions, private schema, shared helpers.
-- Every Supabase project has the `extensions` schema; the local stack
-- bootstrap (scripts/local/bootstrap.sql) creates it too.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Not exposed through PostgREST. Holds helpers and server-only settings.
create schema if not exists private;
revoke all on schema private from public;

create table private.app_settings (
  key   text primary key,
  value text not null
);
revoke all on private.app_settings from public;

-- Server-only secret used to derive per-booking access tokens. Only the
-- SHA-256 of a token is ever stored; the HMAC lets a retried request with the
-- same idempotency key receive the same token without storing it.
insert into private.app_settings (key, value)
values ('booking_token_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create function private.setting(p_key text) returns text
language sql stable security definer set search_path = ''
as $$ select value from private.app_settings where key = p_key $$;

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function private.is_valid_timezone(p_tz text) returns boolean
language sql stable set search_path = ''
as $$ select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) $$;

-- Raise a client-facing error with a stable machine code in DETAIL.
-- SQLSTATE P0001 + message = code keeps PostgREST responses predictable.
create function private.fail(p_code text, p_detail text default null) returns void
language plpgsql set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, p_code);
end $$;
