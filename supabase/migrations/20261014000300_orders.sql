-- Orders, their lines (with price snapshots), resource occupancy, blocks,
-- payments and idempotency records.

create type public.order_status as enum ('confirmed', 'ready', 'completed', 'cancelled', 'no_show');

create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  number              int,              -- assigned after occupancy succeeds
  status              public.order_status not null default 'confirmed',
  pickup_at           timestamptz not null,
  customer_name       text not null,
  customer_phone      text not null,
  customer_email      text,
  note                text not null default '',
  -- Estimated total from snapshot prices; weighed items may change it.
  subtotal_cents      bigint not null check (subtotal_cents >= 0),
  -- Amount after weighing, set by the shop when the order is handed over.
  final_amount_cents  bigint check (final_amount_cents >= 0),
  currency            char(3) not null,
  access_token_hash   bytea,
  source              text not null default 'client' check (source in ('client', 'owner', 'demo')),
  is_demo             boolean not null default false,
  version             int not null default 1,
  arrived_at          timestamptz,
  ready_at            timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number)
);
create index orders_tenant_pickup_idx on public.orders (tenant_id, pickup_at);
create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();

create table public.order_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  order_id          uuid not null,
  product_id        uuid not null,
  prep_profile_id   uuid not null,
  product_name      text not null,
  unit              text not null check (unit in ('kg', 'pcs')),
  unit_price_cents  bigint not null check (unit_price_cents >= 0),
  quantity          numeric(8,3) not null check (quantity > 0),
  line_total_cents  bigint not null check (line_total_cents >= 0),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id),
  foreign key (tenant_id, prep_profile_id) references public.prep_profiles (tenant_id, id)
);
create index order_items_order_idx on public.order_items (order_id);

create table public.resource_blocks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  resource_id uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text not null default '',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (tenant_id, id),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id)
);

-- The single source of truth for "is this resource busy". Orders (one row per
-- prep group) and owner blocks share it, and the EXCLUDE constraint makes an
-- overlap impossible regardless of how many requests race.
create table public.resource_occupancies (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null,
  resource_id      uuid not null,
  period           tstzrange not null,
  order_id         uuid,
  prep_profile_id  uuid,
  block_id         uuid,
  created_at       timestamptz not null default now(),
  check (not isempty(period) and lower_inc(period) and not upper_inc(period)
         and lower(period) is not null and upper(period) is not null),
  check ((order_id is not null and prep_profile_id is not null and block_id is null)
      or (order_id is null and prep_profile_id is null and block_id is not null)),
  unique (order_id, prep_profile_id),
  unique (block_id),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, prep_profile_id) references public.prep_profiles (tenant_id, id),
  foreign key (tenant_id, block_id) references public.resource_blocks (tenant_id, id) on delete cascade,
  constraint resource_occupancies_no_overlap
    exclude using gist (tenant_id with =, resource_id with =, period with &&)
);
create index resource_occupancies_order_idx on public.resource_occupancies (order_id);

create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  order_id         uuid not null,
  kind             text not null default 'payment' check (kind in ('payment', 'refund')),
  amount_cents     bigint not null check (amount_cents > 0),
  method           text not null check (method in ('cash', 'card', 'transfer', 'online')),
  received_at      timestamptz not null default now(),
  note             text not null default '',
  is_demo          boolean not null default false,
  created_by       uuid,
  idempotency_key  uuid not null,
  created_at       timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade
);
create index payments_tenant_received_idx on public.payments (tenant_id, received_at);

-- Idempotency ledger for create / reschedule / cancel. A retried request with
-- the same key and payload replays the original result.
create table public.order_requests (
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  operation        text not null check (operation in ('create', 'reschedule', 'cancel', 'block')),
  idempotency_key  uuid not null,
  request_hash     bytea not null,
  order_id         uuid,
  result           jsonb,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, operation, idempotency_key)
);

create table private.order_counters (
  tenant_id  uuid primary key references public.tenants (id) on delete cascade,
  last_value int not null default 0
);
