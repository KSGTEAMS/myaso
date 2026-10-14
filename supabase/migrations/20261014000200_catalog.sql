-- Tenants and catalog. Everything that depends on a tenant carries tenant_id
-- and references its parent through a composite (tenant_id, id) key, so a row
-- can never point at another tenant's data.

create type public.tenant_status as enum ('draft', 'preview', 'live', 'suspended');

create table public.tenants (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique
                         check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                   text not null check (length(name) between 1 and 80),
  status                 public.tenant_status not null default 'draft',
  timezone               text not null,
  currency               char(3) not null default 'RUB',
  locale                 text not null default 'ru-RU',
  pickup_step_minutes    int not null default 30 check (pickup_step_minutes between 5 and 240),
  min_notice_minutes     int not null default 60 check (min_notice_minutes between 0 and 10080),
  horizon_days           int not null default 14 check (horizon_days between 1 and 90),
  cancel_notice_minutes  int not null default 120 check (cancel_notice_minutes between 0 and 10080),
  max_order_lines        int not null default 30 check (max_order_lines between 1 and 100),
  -- Public, non-personal presentation data (tagline, address, phone, accent,
  -- hero image path, texts). Validated by the pipeline schema.
  profile                jsonb not null default '{}'::jsonb,
  config_version         int not null default 0,
  config_hash            text,
  live_at                timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create function private.tenants_validate() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.is_valid_timezone(new.timezone) then
    perform private.fail('invalid_timezone', new.timezone);
  end if;
  return new;
end $$;
create trigger tenants_validate before insert or update of timezone on public.tenants
  for each row execute function private.tenants_validate();
create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();

-- Owner/staff membership. There is no public signup: rows are created by the
-- server-side pipeline (scripts/owner-invite.ts) with the service role.
create table public.tenant_members (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- Physical resources that an order occupies while it is prepared:
-- cutting tables, smokehouse, dry-ageing chamber...
create table public.resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  key         text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  name        text not null,
  kind        text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

-- How a group of order lines is prepared: which resources can do it and how
-- long it takes. A profile can span several days (smoking, dry-ageing).
create table public.prep_profiles (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  key                text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  name               text not null,
  base_minutes       int not null check (base_minutes between 0 and 20160),
  per_kg_minutes     numeric(8,2) not null default 0 check (per_kg_minutes >= 0),
  per_unit_minutes   numeric(8,2) not null default 0 check (per_unit_minutes >= 0),
  buffer_minutes     int not null default 0 check (buffer_minutes between 0 and 1440),
  is_active          boolean not null default true,
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create table public.prep_profile_resources (
  tenant_id       uuid not null,
  prep_profile_id uuid not null,
  resource_id     uuid not null,
  primary key (prep_profile_id, resource_id),
  foreign key (tenant_id, prep_profile_id) references public.prep_profiles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id) on delete cascade
);
create index prep_profile_resources_tenant_idx on public.prep_profile_resources (tenant_id);

create table public.product_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  key         text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  key              text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,60}$'),
  category_id      uuid not null,
  prep_profile_id  uuid not null,
  name             text not null check (length(name) between 1 and 120),
  description      text not null default '',
  unit             text not null check (unit in ('kg', 'pcs')),
  -- price per kg for unit=kg, per piece for unit=pcs; minor currency units
  price_cents      bigint not null check (price_cents >= 0),
  qty_step         numeric(8,3) not null check (qty_step > 0),
  min_qty          numeric(8,3) not null check (min_qty > 0),
  max_qty          numeric(8,3) not null check (max_qty >= min_qty),
  badges           text[] not null default '{}',
  image_path       text,
  -- 'owner' images were uploaded in the cabinet and survive republishing
  image_source     text not null default 'pipeline' check (image_source in ('pipeline', 'owner')),
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key),
  foreign key (tenant_id, category_id) references public.product_categories (tenant_id, id),
  foreign key (tenant_id, prep_profile_id) references public.prep_profiles (tenant_id, id),
  check (unit = 'kg' or (qty_step = trunc(qty_step) and min_qty = trunc(min_qty)))
);
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();

-- Pickup hours: moments when orders are handed over. ISO weekday 1..7.
create table public.working_hours (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  weekday    smallint not null check (weekday between 1 and 7),
  opens_at   time not null,
  closes_at  time not null,
  check (closes_at > opens_at)
);
create index working_hours_tenant_idx on public.working_hours (tenant_id, weekday);

-- Date-specific overrides: a closed day, or replacement hours for that date.
create table public.schedule_exceptions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  day        date not null,
  is_closed  boolean not null default false,
  opens_at   time,
  closes_at  time,
  note       text not null default '',
  check (is_closed or (opens_at is not null and closes_at is not null and closes_at > opens_at))
);
create index schedule_exceptions_tenant_day_idx on public.schedule_exceptions (tenant_id, day);

create table public.tenant_publications (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  version       int not null,
  config_hash   text not null,
  mode          text not null check (mode in ('preview', 'live')),
  summary       jsonb not null default '{}'::jsonb,
  published_at  timestamptz not null default now()
);
