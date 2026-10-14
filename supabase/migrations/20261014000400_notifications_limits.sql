-- Web Push subscriptions, the notification outbox, and shared atomic counters
-- for rate limits and the LLM budget.

create table public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  audience         text not null check (audience in ('owner', 'client')),
  user_id          uuid references auth.users (id) on delete cascade,
  order_id         uuid,
  endpoint         text not null check (endpoint ~ '^https://'),
  p256dh           text not null,
  auth             text not null,
  user_agent       text not null default '',
  failure_count    int not null default 0,
  last_success_at  timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  check ((audience = 'owner' and user_id is not null and order_id is null)
      or (audience = 'client' and order_id is not null)),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade
);
create unique index push_subscriptions_owner_uniq
  on public.push_subscriptions (tenant_id, endpoint) where audience = 'owner';
create unique index push_subscriptions_client_uniq
  on public.push_subscriptions (order_id, endpoint) where audience = 'client';

create table public.notification_jobs (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  order_id         uuid,
  kind             text not null check (kind in
                     ('order_created', 'order_rescheduled', 'order_cancelled', 'pickup_reminder', 'order_ready')),
  audience         text not null check (audience in ('owner', 'client')),
  run_at           timestamptz not null default now(),
  status           text not null default 'pending'
                   check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped')),
  attempts         int not null default 0,
  max_attempts     int not null default 5,
  lease_until      timestamptz,
  locked_by        text,
  -- One job per logical event: replays and retries cannot double-send.
  dedupe_key       text not null,
  -- Order version the job was planned for; a reschedule makes it stale.
  order_version    int,
  payload          jsonb not null default '{}'::jsonb,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id) on delete cascade
);
create index notification_jobs_due_idx on public.notification_jobs (run_at)
  where status in ('pending', 'processing');

create table private.rate_limit_counters (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          int not null default 0,
  primary key (bucket, window_start)
);

create table private.llm_usage (
  scope     text not null,
  day       date not null,
  requests  int not null default 0,
  tokens    bigint not null default 0,
  primary key (scope, day)
);
