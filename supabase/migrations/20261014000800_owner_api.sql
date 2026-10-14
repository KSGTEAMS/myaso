-- Owner cabinet RPCs. Callable by `authenticated`; every function confirms
-- membership of auth.uid() in the requested tenant on the server.

create function private.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.tenant_members
                 where tenant_id = p_tenant and user_id = (select auth.uid()))
$$;

create function private.assert_member(p_tenant uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.is_member(p_tenant) then
    perform private.fail('forbidden');
  end if;
end $$;

create function private.assert_order_member(p_tenant uuid, p_order uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  if not exists (select 1 from public.orders where tenant_id = p_tenant and id = p_order) then
    perform private.fail('order_not_found');
  end if;
end $$;

create function public.owner_tenants() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name,
                                               'status', t.status, 'timezone', t.timezone,
                                               'currency', t.currency, 'role', m.role)
                            order by t.name), '[]'::jsonb)
  from public.tenant_members m join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid())
$$;

-- Period bounds in the tenant timezone. The same function feeds the UI and
-- the AI assistant, so both always talk about the same interval.
create function private.period_bounds(p_tz text, p_period text, p_from date, p_to date)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_today date := (now() at time zone p_tz)::date;
  v_from date;
  v_to date;
begin
  case coalesce(p_period, 'today')
    when 'today' then v_from := v_today; v_to := v_today;
    when 'yesterday' then v_from := v_today - 1; v_to := v_today - 1;
    when 'tomorrow' then v_from := v_today + 1; v_to := v_today + 1;
    when 'week' then v_from := date_trunc('week', v_today)::date; v_to := v_from + 6;
    when 'last7' then v_from := v_today - 6; v_to := v_today;
    when 'month' then v_from := date_trunc('month', v_today)::date;
                      v_to := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;
    when 'custom' then
      if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
        perform private.fail('invalid_period');
      end if;
      v_from := p_from; v_to := p_to;
    else perform private.fail('invalid_period', p_period);
  end case;
  return jsonb_build_object('period', coalesce(p_period, 'today'), 'timezone', p_tz,
    'from_date', v_from, 'to_date', v_to,
    'from_ts', (v_from::timestamp at time zone p_tz),
    'to_ts', ((v_to + 1)::timestamp at time zone p_tz));
end $$;

create function public.owner_stats(p_tenant uuid, p_period text default 'today',
                                   p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
  b jsonb;
  v_from timestamptz;
  v_to timestamptz;
begin
  perform private.assert_member(p_tenant);
  select * into t from public.tenants where id = p_tenant;
  b := private.period_bounds(t.timezone, p_period, p_from, p_to);
  v_from := (b ->> 'from_ts')::timestamptz;
  v_to := (b ->> 'to_ts')::timestamptz;
  return jsonb_build_object(
    'bounds', b,
    'currency', t.currency,
    -- Customers who came to the shop for their order (marked on arrival).
    'visits', (select count(*) from public.orders
               where tenant_id = p_tenant and arrived_at >= v_from and arrived_at < v_to),
    -- Orders handed over in the period, valued at the weighed/final amount.
    'completed_orders', (select jsonb_build_object('count', count(*),
                                'value_cents', coalesce(sum(coalesce(final_amount_cents, subtotal_cents)), 0))
                         from public.orders
                         where tenant_id = p_tenant and status = 'completed'
                           and completed_at >= v_from and completed_at < v_to),
    -- Money actually received (payments minus refunds) in the period.
    'payments_received', (select jsonb_build_object(
                                 'count', count(*) filter (where kind = 'payment'),
                                 'net_cents', coalesce(sum(case when kind = 'payment' then amount_cents else -amount_cents end), 0),
                                 'refunds_cents', coalesce(sum(amount_cents) filter (where kind = 'refund'), 0))
                          from public.payments
                          where tenant_id = p_tenant and received_at >= v_from and received_at < v_to),
    'scheduled_pickups', (select count(*) from public.orders
                          where tenant_id = p_tenant and status in ('confirmed', 'ready', 'completed', 'no_show')
                            and pickup_at >= v_from and pickup_at < v_to),
    -- Value of orders still to be picked up in the period. NOT revenue.
    'expected_pickups', (select jsonb_build_object('count', count(*), 'value_cents', coalesce(sum(subtotal_cents), 0))
                         from public.orders
                         where tenant_id = p_tenant and status in ('confirmed', 'ready')
                           and pickup_at >= greatest(v_from, now()) and pickup_at < v_to),
    'cancelled', (select count(*) from public.orders
                  where tenant_id = p_tenant and cancelled_at >= v_from and cancelled_at < v_to),
    'no_show', (select count(*) from public.orders
                where tenant_id = p_tenant and status = 'no_show' and pickup_at >= v_from and pickup_at < v_to),
    'resource_load', (select coalesce(jsonb_agg(jsonb_build_object(
                          'resource_id', r.id, 'name', r.name,
                          'busy_minutes', coalesce((select round(sum(extract(epoch from
                                (upper(o.period * tstzrange(v_from, v_to)) - lower(o.period * tstzrange(v_from, v_to)))) / 60))
                              from public.resource_occupancies o
                              where o.tenant_id = p_tenant and o.resource_id = r.id
                                and o.period && tstzrange(v_from, v_to)), 0),
                          'period_minutes', round(extract(epoch from v_to - v_from) / 60))
                        order by r.sort_order), '[]'::jsonb)
                      from public.resources r where r.tenant_id = p_tenant and r.is_active)
  );
end $$;

create function public.owner_schedule(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
  v_from timestamptz;
  v_to timestamptz;
begin
  perform private.assert_member(p_tenant);
  select * into t from public.tenants where id = p_tenant;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('invalid_period');
  end if;
  v_from := p_from::timestamp at time zone t.timezone;
  v_to := (p_to + 1)::timestamp at time zone t.timezone;
  return jsonb_build_object(
    'timezone', t.timezone, 'from_date', p_from, 'to_date', p_to,
    'orders', coalesce((select jsonb_agg(private.order_json(o.id) order by o.pickup_at)
                        from public.orders o
                        where o.tenant_id = p_tenant and o.pickup_at >= v_from and o.pickup_at < v_to), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'resource_id', b.resource_id,
                          'resource_name', r.name, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'reason', b.reason)
                          order by b.starts_at)
                        from public.resource_blocks b
                        join public.resources r on r.tenant_id = b.tenant_id and r.id = b.resource_id
                        where b.tenant_id = p_tenant and b.ends_at > v_from and b.starts_at < v_to), '[]'::jsonb),
    'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kind', r.kind,
                             'is_active', r.is_active) order by r.sort_order)
                           from public.resources r where r.tenant_id = p_tenant), '[]'::jsonb),
    'occupancies', coalesce((select jsonb_agg(jsonb_build_object('resource_id', o.resource_id,
                               'starts_at', lower(o.period), 'ends_at', upper(o.period),
                               'order_id', o.order_id, 'block_id', o.block_id) order by lower(o.period))
                             from public.resource_occupancies o
                             where o.tenant_id = p_tenant and o.period && tstzrange(v_from, v_to)), '[]'::jsonb));
end $$;

create function public.owner_get_order(p_tenant uuid, p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.assert_order_member(p_tenant, p_order_id);
  return private.order_json(p_order_id);
end $$;

create function public.owner_find_orders(p_tenant uuid, p_query text, p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
begin
  perform private.assert_member(p_tenant);
  return coalesce((
    select jsonb_agg(private.order_json(o.id) order by o.pickup_at desc)
    from (select id, pickup_at from public.orders o
          where o.tenant_id = p_tenant
            and (v_q = ''
              or (v_digits <> '' and length(v_digits) <= 6 and o.number = v_digits::int)
              or (length(v_digits) >= 4 and o.customer_phone like '%' || v_digits || '%')
              or o.customer_name ilike '%' || v_q || '%')
          order by o.pickup_at desc
          limit least(greatest(coalesce(p_limit, 10), 1), 50)) o), '[]'::jsonb);
end $$;

create function public.owner_create_order(p_tenant uuid, p_items jsonb, p_pickup_at timestamptz,
                                          p_customer jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  return private.create_order_core(p_tenant, p_items, p_pickup_at, p_customer, p_idempotency_key, 'owner', false)
         - 'access_token';
end $$;

create function public.owner_reschedule_order(p_tenant uuid, p_order_id uuid, p_pickup_at timestamptz,
                                              p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_order_member(p_tenant, p_order_id);
  return private.reschedule_core(p_order_id, p_pickup_at, p_idempotency_key, false, false);
end $$;

create function public.owner_cancel_order(p_tenant uuid, p_order_id uuid, p_reason text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_order_member(p_tenant, p_order_id);
  return private.cancel_core(p_order_id, p_reason, false);
end $$;

-- Status transitions after the order exists: arrived / ready / completed / no_show.
create function public.owner_update_order_status(p_tenant uuid, p_order_id uuid, p_action text,
                                                 p_final_amount_cents bigint default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
begin
  perform private.assert_order_member(p_tenant, p_order_id);
  select * into o from public.orders where id = p_order_id for update;
  if o.status in ('cancelled', 'completed', 'no_show') and p_action <> 'arrived' then
    perform private.fail('invalid_transition', o.status::text || '->' || p_action);
  end if;
  case p_action
    when 'arrived' then
      if o.status = 'cancelled' then perform private.fail('invalid_transition'); end if;
      update public.orders set arrived_at = coalesce(arrived_at, now()) where id = p_order_id;
    when 'ready' then
      update public.orders set status = 'ready', ready_at = now(), version = version + 1 where id = p_order_id;
      perform private.enqueue_job(o.tenant_id, o.id, 'order_ready', 'client', now(),
                                  'order_ready:' || o.id, o.version + 1,
                                  jsonb_build_object('number', o.number, 'pickup_at', o.pickup_at));
    when 'completed' then
      if p_final_amount_cents is not null and p_final_amount_cents < 0 then
        perform private.fail('invalid_amount');
      end if;
      update public.orders
         set status = 'completed', completed_at = now(), arrived_at = coalesce(arrived_at, now()),
             final_amount_cents = coalesce(p_final_amount_cents, final_amount_cents, subtotal_cents)
       where id = p_order_id;
      -- Preparation is finished: free the rest of the occupied range.
      delete from public.resource_occupancies where order_id = p_order_id and lower(period) >= now();
      update public.resource_occupancies set period = tstzrange(lower(period), now(), '[)')
       where order_id = p_order_id and lower(period) < now() and upper(period) > now();
      perform private.withdraw_jobs(p_order_id, null);
    when 'no_show' then
      if now() < o.pickup_at then perform private.fail('invalid_transition', 'pickup time not reached'); end if;
      update public.orders set status = 'no_show' where id = p_order_id;
      perform private.withdraw_jobs(p_order_id, null);
    else
      perform private.fail('invalid_action', p_action);
  end case;
  return private.order_json(p_order_id);
end $$;

create function public.owner_record_payment(p_tenant uuid, p_order_id uuid, p_amount_cents bigint,
                                            p_method text, p_kind text, p_idempotency_key uuid,
                                            p_note text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_paid bigint;
begin
  perform private.assert_order_member(p_tenant, p_order_id);
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  if p_amount_cents is null or p_amount_cents <= 0 then perform private.fail('invalid_amount'); end if;
  if p_kind = 'refund' then
    select coalesce(sum(case when kind = 'payment' then amount_cents else -amount_cents end), 0)
      into v_paid from public.payments where order_id = p_order_id;
    if p_amount_cents > v_paid then perform private.fail('refund_exceeds_paid'); end if;
  end if;
  insert into public.payments (tenant_id, order_id, kind, amount_cents, method, note, created_by,
                               idempotency_key, is_demo)
  values (p_tenant, p_order_id, coalesce(p_kind, 'payment'), p_amount_cents, p_method, left(coalesce(p_note, ''), 300),
          (select auth.uid()), p_idempotency_key,
          (select is_demo from public.orders where id = p_order_id))
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;
  return private.order_json(p_order_id) || jsonb_build_object('payment_id', v_id, 'replayed', v_id is null);
end $$;

create function public.owner_create_block(p_tenant uuid, p_resource_id uuid, p_starts_at timestamptz,
                                          p_ends_at timestamptz, p_reason text, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_hash bytea;
  v_req public.order_requests;
  v_block uuid;
  v_result jsonb;
begin
  perform private.assert_member(p_tenant);
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  if p_ends_at <= p_starts_at then perform private.fail('invalid_period'); end if;
  if not exists (select 1 from public.resources where tenant_id = p_tenant and id = p_resource_id) then
    perform private.fail('resource_not_found');
  end if;
  v_hash := extensions.digest(p_resource_id::text || '|' || p_starts_at::text || '|' || p_ends_at::text, 'sha256');
  insert into public.order_requests (tenant_id, operation, idempotency_key, request_hash)
  values (p_tenant, 'block', p_idempotency_key, v_hash) on conflict do nothing;
  if not found then
    select * into v_req from public.order_requests
     where tenant_id = p_tenant and operation = 'block' and idempotency_key = p_idempotency_key;
    if v_req.request_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return v_req.result || jsonb_build_object('replayed', true);
  end if;

  insert into public.resource_blocks (tenant_id, resource_id, starts_at, ends_at, reason, created_by)
  values (p_tenant, p_resource_id, p_starts_at, p_ends_at, left(coalesce(p_reason, ''), 200), (select auth.uid()))
  returning id into v_block;
  begin
    insert into public.resource_occupancies (tenant_id, resource_id, period, block_id)
    values (p_tenant, p_resource_id, tstzrange(p_starts_at, p_ends_at, '[)'), v_block);
  exception when exclusion_violation then
    perform private.fail('resource_busy');
  end;
  v_result := jsonb_build_object('id', v_block, 'resource_id', p_resource_id,
                                 'starts_at', p_starts_at, 'ends_at', p_ends_at, 'reason', p_reason);
  update public.order_requests set result = v_result
   where tenant_id = p_tenant and operation = 'block' and idempotency_key = p_idempotency_key;
  return v_result || jsonb_build_object('replayed', false);
end $$;

create function public.owner_delete_block(p_tenant uuid, p_block_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  delete from public.resource_blocks where tenant_id = p_tenant and id = p_block_id;
  return jsonb_build_object('deleted', found);
end $$;

-- Owner edits to the live catalog. Price changes never touch existing orders:
-- order_items keep their snapshot price.
create function public.owner_update_product(p_tenant uuid, p_product_id uuid, p_price_cents bigint default null,
                                            p_is_active boolean default null, p_image_path text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.products;
begin
  perform private.assert_member(p_tenant);
  if p_price_cents is not null and p_price_cents < 0 then perform private.fail('invalid_amount'); end if;
  if p_image_path is not null and p_image_path not like p_tenant::text || '/owner/%' then
    perform private.fail('invalid_image_path');
  end if;
  update public.products
     set price_cents = coalesce(p_price_cents, price_cents),
         is_active = coalesce(p_is_active, is_active),
         image_path = coalesce(p_image_path, image_path),
         image_source = case when p_image_path is not null then 'owner' else image_source end
   where tenant_id = p_tenant and id = p_product_id
  returning * into v_row;
  if not found then perform private.fail('product_not_found'); end if;
  return to_jsonb(v_row);
end $$;

create function public.owner_register_push(p_tenant uuid, p_subscription jsonb, p_user_agent text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  insert into public.push_subscriptions (tenant_id, audience, user_id, endpoint, p256dh, auth, user_agent)
  values (p_tenant, 'owner', (select auth.uid()), p_subscription ->> 'endpoint',
          p_subscription #>> '{keys,p256dh}', p_subscription #>> '{keys,auth}', left(coalesce(p_user_agent, ''), 300))
  on conflict (tenant_id, endpoint) where audience = 'owner'
  do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
                revoked_at = null, failure_count = 0;
  return jsonb_build_object('subscribed', true);
end $$;

create function public.owner_unregister_push(p_tenant uuid, p_endpoint text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  update public.push_subscriptions set revoked_at = now()
   where tenant_id = p_tenant and audience = 'owner' and endpoint = p_endpoint
     and user_id = (select auth.uid());
  return jsonb_build_object('unsubscribed', found);
end $$;
