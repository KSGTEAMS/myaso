-- Customer-facing RPCs. They are executed only by the Edge Function
-- `public-api` with the service role (after rate limiting); anon has no
-- EXECUTE grant on them. The tenant is resolved from the slug server-side.

create function private.public_tenant(p_slug text) returns public.tenants
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
begin
  select * into t from public.tenants where slug = p_slug and status in ('preview', 'live');
  if not found then perform private.fail('tenant_not_found'); end if;
  return t;
end $$;

create function public.get_pickup_slots(p_slug text, p_items jsonb, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
  v_lines jsonb;
  v_groups jsonb;
  v_slots jsonb := '[]'::jsonb;
  c record;
  v_plan jsonb;
  v_today date;
  v_from date;
  v_to date;
begin
  t := private.public_tenant(p_slug);
  v_today := private.local_day(now(), t.timezone);
  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to := least(coalesce(p_to, v_from + 6), v_from + 13, v_today + t.horizon_days);
  if v_to < v_from then
    return jsonb_build_object('timezone', t.timezone, 'from', v_from, 'to', v_to, 'slots', '[]'::jsonb, 'groups', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v_lines from private.price_lines(t.id, p_items) l;
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_groups from private.prep_groups(t.id, v_lines) g;

  for c in select * from private.pickup_candidates(t.id, v_from, v_to) loop
    v_plan := private.plan_assignment(t.id, v_groups, c.pickup_at, c.window_opens, c.window_closes);
    if v_plan is not null then
      v_slots := v_slots || jsonb_build_object('pickup_at', c.pickup_at,
        'local_date', private.local_day(c.pickup_at, t.timezone),
        'local_time', to_char(c.pickup_at at time zone t.timezone, 'HH24:MI'),
        'prep_starts_at', (select min((p ->> 'starts_at')::timestamptz) from jsonb_array_elements(v_plan) p));
    end if;
  end loop;

  return jsonb_build_object(
    'timezone', t.timezone, 'from', v_from, 'to', v_to, 'slots', v_slots,
    'subtotal_cents', (select coalesce(sum((l ->> 'line_total_cents')::bigint), 0) from jsonb_array_elements(v_lines) l),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
        'prep_profile', pp.name, 'minutes', (g ->> 'minutes')::int,
        'buffer_minutes', (g ->> 'buffer_minutes')::int)), '[]'::jsonb)
      from jsonb_array_elements(v_groups) g
      join public.prep_profiles pp on pp.id = (g ->> 'prep_profile_id')::uuid));
end $$;

create function public.place_order(p_slug text, p_items jsonb, p_pickup_at timestamptz,
                                   p_customer jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.tenants;
begin
  t := private.public_tenant(p_slug);
  return private.create_order_core(t.id, p_items, p_pickup_at, p_customer, p_idempotency_key, 'client', true);
end $$;

create function public.get_order_by_token(p_order_id uuid, p_token text) returns jsonb
language sql stable security definer set search_path = ''
as $$ select private.order_json(private.order_by_token(p_order_id, p_token)) $$;

create function public.reschedule_order_by_token(p_order_id uuid, p_token text, p_pickup_at timestamptz,
                                                 p_idempotency_key uuid)
returns jsonb
language sql security definer set search_path = ''
as $$
  select private.reschedule_core(private.order_by_token(p_order_id, p_token), p_pickup_at,
                                 p_idempotency_key, true, true)
$$;

create function public.cancel_order_by_token(p_order_id uuid, p_token text, p_reason text default '')
returns jsonb
language sql security definer set search_path = ''
as $$ select private.cancel_core(private.order_by_token(p_order_id, p_token), p_reason, true) $$;

create function public.register_client_push(p_order_id uuid, p_token text, p_subscription jsonb,
                                            p_user_agent text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order uuid := private.order_by_token(p_order_id, p_token);
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.orders where id = v_order;
  insert into public.push_subscriptions (tenant_id, audience, order_id, endpoint, p256dh, auth, user_agent)
  values (v_tenant, 'client', v_order, p_subscription ->> 'endpoint',
          p_subscription #>> '{keys,p256dh}', p_subscription #>> '{keys,auth}', left(coalesce(p_user_agent, ''), 300))
  on conflict (order_id, endpoint) where audience = 'client'
  do update set p256dh = excluded.p256dh, auth = excluded.auth, revoked_at = null, failure_count = 0;
  return jsonb_build_object('subscribed', true);
end $$;

-- Atomic fixed-window counter shared by every Edge Function instance.
create function public.rate_limit_hit(p_bucket text, p_limit int, p_window_seconds int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into private.rate_limit_counters (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = private.rate_limit_counters.hits + 1
  returning hits into v_hits;
  return jsonb_build_object('allowed', v_hits <= p_limit, 'hits', v_hits, 'limit', p_limit,
                            'reset_at', v_window + make_interval(secs => p_window_seconds));
end $$;

-- LLM budget: reserve tokens against tenant and global daily caps atomically.
create function public.llm_budget_reserve(p_tenant uuid, p_tokens int, p_tenant_daily int, p_global_daily int)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'UTC')::date;
  v_ok boolean;
begin
  begin
    insert into private.llm_usage as u (scope, day, requests, tokens) values ('tenant:' || p_tenant, v_day, 1, p_tokens)
    on conflict (scope, day) do update set requests = u.requests + 1, tokens = u.tokens + excluded.tokens;
    insert into private.llm_usage as u (scope, day, requests, tokens) values ('global', v_day, 1, p_tokens)
    on conflict (scope, day) do update set requests = u.requests + 1, tokens = u.tokens + excluded.tokens;
    select bool_and(case when scope = 'global' then tokens <= p_global_daily else tokens <= p_tenant_daily end)
      into v_ok from private.llm_usage
     where day = v_day and scope in ('tenant:' || p_tenant, 'global');
    if not v_ok then
      raise exception using errcode = 'P0001', message = 'llm_budget_exceeded';
    end if;
    return true;
  exception when sqlstate 'P0001' then
    -- the block's implicit savepoint undoes both increments
    return false;
  end;
end $$;

-- Replace the reservation with the real usage reported by the provider.
create function public.llm_budget_commit(p_tenant uuid, p_reserved int, p_actual int) returns void
language sql security definer set search_path = ''
as $$
  update private.llm_usage set tokens = greatest(0, tokens + (p_actual - p_reserved))
   where day = (now() at time zone 'UTC')::date and scope in ('tenant:' || p_tenant, 'global')
$$;
