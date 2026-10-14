-- Order lifecycle. Every public operation is one SQL function = one
-- transaction: either everything (order, lines, occupancies, outbox jobs,
-- idempotency record) commits, or nothing does.

create function private.base64url(p bytea) returns text
language sql immutable set search_path = ''
as $$ select translate(rtrim(encode(p, 'base64'), '='), E'+/\n', '-_') $$;

-- Deterministic per-order secret: HMAC(server secret, order id + idempotency key).
-- Only its SHA-256 is stored; a retry with the same key re-derives the same token.
create function private.derive_token(p_order uuid, p_key uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select private.base64url(extensions.hmac(p_order::text || ':' || p_key::text,
                                           private.setting('booking_token_secret'), 'sha256'))
$$;

create function private.token_hash(p_token text) returns bytea
language sql immutable set search_path = ''
as $$ select extensions.digest(coalesce(p_token, ''), 'sha256') $$;

create function private.normalize_phone(p text) returns text
language sql immutable set search_path = ''
as $$ select '+' || regexp_replace(coalesce(p, ''), '\D', '', 'g') $$;

create function private.validate_customer(p jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_phone text := private.normalize_phone(p ->> 'phone');
  v_email text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  v_note text := btrim(coalesce(p ->> 'note', ''));
begin
  if length(v_name) < 2 or length(v_name) > 80 then perform private.fail('invalid_name'); end if;
  if v_phone !~ '^\+[0-9]{10,15}$' then perform private.fail('invalid_phone'); end if;
  if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    perform private.fail('invalid_email');
  end if;
  if length(v_note) > 500 then perform private.fail('note_too_long'); end if;
  return jsonb_build_object('name', v_name, 'phone', v_phone, 'email', v_email, 'note', v_note);
end $$;

create function private.enqueue_job(p_tenant uuid, p_order uuid, p_kind text, p_audience text,
                                    p_run_at timestamptz, p_dedupe text, p_version int,
                                    p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_skip boolean;
begin
  -- Preview tenants and demo orders never produce real notifications.
  select t.status = 'preview' or coalesce(o.is_demo, false) into v_skip
  from public.tenants t left join public.orders o on o.tenant_id = t.id and o.id = p_order
  where t.id = p_tenant;

  insert into public.notification_jobs (tenant_id, order_id, kind, audience, run_at, status,
                                        dedupe_key, order_version, payload, last_error)
  values (p_tenant, p_order, p_kind, p_audience, p_run_at,
          case when v_skip then 'skipped' else 'pending' end,
          p_dedupe, p_version, p_payload,
          case when v_skip then 'preview_or_demo' end)
  on conflict (tenant_id, dedupe_key) do nothing;
end $$;

-- Pending jobs that belonged to an older version (or a cancelled order) are
-- withdrawn so a reschedule never sends the old time.
create function private.withdraw_jobs(p_order uuid, p_before_version int) returns void
language sql security definer set search_path = ''
as $$
  update public.notification_jobs
     set status = 'cancelled', last_error = 'superseded', lease_until = null
   where order_id = p_order and status in ('pending', 'processing')
     and kind in ('pickup_reminder', 'order_ready')
     and (p_before_version is null or order_version < p_before_version)
$$;

create function private.schedule_order_jobs(p_order uuid, p_event text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order;
  perform private.enqueue_job(o.tenant_id, o.id, p_event, 'owner', now(),
                              p_event || ':' || o.id || ':v' || o.version, o.version,
                              jsonb_build_object('number', o.number, 'pickup_at', o.pickup_at));
  if p_event <> 'order_cancelled' and o.pickup_at - interval '2 hours' > now() + interval '5 minutes' then
    perform private.enqueue_job(o.tenant_id, o.id, 'pickup_reminder', 'client',
                                o.pickup_at - interval '2 hours',
                                'pickup_reminder:' || o.id || ':v' || o.version, o.version,
                                jsonb_build_object('number', o.number, 'pickup_at', o.pickup_at));
  end if;
end $$;

-- Public view of one order (for the customer who holds its token, or the owner).
create function private.order_json(p_order uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'pickup_at', o.pickup_at,
    'customer_name', o.customer_name, 'customer_phone', o.customer_phone,
    'customer_email', o.customer_email, 'note', o.note,
    'subtotal_cents', o.subtotal_cents, 'final_amount_cents', o.final_amount_cents,
    'currency', o.currency, 'is_demo', o.is_demo, 'source', o.source, 'version', o.version,
    'arrived_at', o.arrived_at, 'ready_at', o.ready_at, 'completed_at', o.completed_at,
    'cancelled_at', o.cancelled_at, 'created_at', o.created_at,
    'change_deadline', o.pickup_at - make_interval(mins => t.cancel_notice_minutes),
    'can_change', o.status = 'confirmed' and now() <= o.pickup_at - make_interval(mins => t.cancel_notice_minutes),
    'tenant', jsonb_build_object('slug', t.slug, 'name', t.name, 'timezone', t.timezone),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product_id', i.product_id, 'name', i.product_name, 'unit', i.unit,
        'unit_price_cents', i.unit_price_cents, 'quantity', i.quantity,
        'line_total_cents', i.line_total_cents) order by i.product_name)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'preparation', coalesce((select jsonb_agg(jsonb_build_object(
        'resource_id', oc.resource_id, 'resource_name', r.name,
        'starts_at', lower(oc.period), 'ends_at', upper(oc.period)) order by lower(oc.period))
      from public.resource_occupancies oc
      join public.resources r on r.tenant_id = oc.tenant_id and r.id = oc.resource_id
      where oc.order_id = o.id), '[]'::jsonb),
    'paid_cents', coalesce((select sum(case when p.kind = 'payment' then p.amount_cents else -p.amount_cents end)
      from public.payments p where p.order_id = o.id), 0))
  from public.orders o join public.tenants t on t.id = o.tenant_id
  where o.id = p_order
$$;

-- Insert occupancies for every group, trying eligible resources in order and
-- relying on the EXCLUDE constraint for correctness under concurrency.
create function private.occupy(p_tenant uuid, p_order uuid, p_groups jsonb, p_pickup timestamptz,
                               p_opens timestamptz, p_closes timestamptz,
                               p_prefer jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  g jsonb;
  v_period tstzrange;
  v_res uuid;
  v_done boolean;
  v_used uuid[] := '{}';
begin
  for g in select * from jsonb_array_elements(p_groups) loop
    v_period := private.group_period(p_pickup, (g ->> 'minutes')::int, (g ->> 'buffer_minutes')::int);
    if p_opens is not null and not private.group_fits(v_period, p_opens, p_closes) then
      perform private.fail('slot_unavailable', 'preparation does not fit opening hours');
    end if;
    if lower(v_period) < now() - interval '1 minute' and p_opens is null then
      perform private.fail('slot_unavailable', 'preparation would start in the past');
    end if;
    v_done := false;
    for v_res in
      select f from private.free_resources(p_tenant, (g ->> 'prep_profile_id')::uuid, v_period,
                                           (p_prefer ->> (g ->> 'prep_profile_id'))::uuid, v_used) f
    loop
      begin
        insert into public.resource_occupancies (tenant_id, resource_id, period, order_id, prep_profile_id)
        values (p_tenant, v_res, v_period, p_order, (g ->> 'prep_profile_id')::uuid);
        v_done := true;
        v_used := v_used || v_res;
        exit;
      exception when exclusion_violation then
        -- Lost a race for this resource; try the next eligible one.
        null;
      end;
    end loop;
    if not v_done then
      perform private.fail('slot_taken');
    end if;
  end loop;
end $$;

create function private.order_groups(p_order uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
  from private.prep_groups(
    (select tenant_id from public.orders where id = p_order),
    (select jsonb_agg(jsonb_build_object('prep_profile_id', i.prep_profile_id, 'unit', i.unit,
                                         'quantity', i.quantity))
       from public.order_items i where i.order_id = p_order)) g
$$;

-- Find the opening window that contains a pickup moment on the tenant grid.
create function private.grid_window(p_tenant uuid, p_pickup timestamptz)
returns table (window_opens timestamptz, window_closes timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.window_opens, c.window_closes
  from public.tenants t,
       private.pickup_candidates(t.id, private.local_day(p_pickup, t.timezone),
                                 private.local_day(p_pickup, t.timezone)) c
  where t.id = p_tenant and c.pickup_at = p_pickup
  limit 1
$$;

create function private.create_order_core(p_tenant uuid, p_items jsonb, p_pickup timestamptz,
                                          p_customer jsonb, p_key uuid, p_source text,
                                          p_check_grid boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.tenants;
  v_customer jsonb;
  v_hash bytea;
  v_req public.order_requests;
  v_lines jsonb;
  v_groups jsonb;
  v_opens timestamptz;
  v_closes timestamptz;
  v_order uuid;
  v_number int;
  v_token text;
begin
  if p_key is null then perform private.fail('idempotency_key_required'); end if;
  if p_pickup is null then perform private.fail('pickup_required'); end if;
  select * into t from public.tenants where id = p_tenant;
  v_customer := private.validate_customer(p_customer);
  v_hash := extensions.digest(jsonb_build_object(
      'items', (select jsonb_agg(jsonb_build_object('product_id', e ->> 'product_id',
                                                    'quantity', (e ->> 'quantity')::numeric)
                                 order by e ->> 'product_id')
                from jsonb_array_elements(p_items) e),
      'pickup_at', p_pickup, 'customer', v_customer)::text, 'sha256');

  insert into public.order_requests (tenant_id, operation, idempotency_key, request_hash)
  values (p_tenant, 'create', p_key, v_hash)
  on conflict do nothing;
  if not found then
    select * into v_req from public.order_requests
     where tenant_id = p_tenant and operation = 'create' and idempotency_key = p_key;
    if v_req.request_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return private.order_json(v_req.order_id)
           || jsonb_build_object('access_token', private.derive_token(v_req.order_id, p_key), 'replayed', true);
  end if;

  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v_lines from private.price_lines(p_tenant, p_items) l;
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_groups from private.prep_groups(p_tenant, v_lines) g;
  if exists (select 1 from jsonb_array_elements(v_groups) g where (g ->> 'eligible')::int = 0) then
    perform private.fail('no_resource_for_product');
  end if;

  if p_check_grid then
    select w.window_opens, w.window_closes into v_opens, v_closes from private.grid_window(p_tenant, p_pickup) w;
    if v_opens is null then perform private.fail('slot_unavailable', 'not a pickup moment'); end if;
  elsif p_pickup < now() then
    perform private.fail('slot_unavailable', 'pickup in the past');
  end if;

  insert into public.orders (tenant_id, number, pickup_at, customer_name, customer_phone, customer_email,
                             note, subtotal_cents, currency, source, is_demo)
  values (p_tenant, null, p_pickup, v_customer ->> 'name', v_customer ->> 'phone', v_customer ->> 'email',
          v_customer ->> 'note', (select sum((l ->> 'line_total_cents')::bigint) from jsonb_array_elements(v_lines) l),
          t.currency, p_source, t.status = 'preview' or p_source = 'demo')
  returning id into v_order;
  -- number is assigned below after occupancy
  -- succeeded, so the per-tenant counter lock is held only briefly.

  insert into public.order_items (tenant_id, order_id, product_id, prep_profile_id, product_name, unit,
                                  unit_price_cents, quantity, line_total_cents)
  select p_tenant, v_order, (l ->> 'product_id')::uuid, (l ->> 'prep_profile_id')::uuid, l ->> 'product_name',
         l ->> 'unit', (l ->> 'unit_price_cents')::bigint, (l ->> 'quantity')::numeric,
         (l ->> 'line_total_cents')::bigint
  from jsonb_array_elements(v_lines) l;

  perform private.occupy(p_tenant, v_order, v_groups, p_pickup, v_opens, v_closes);

  insert into private.order_counters (tenant_id, last_value) values (p_tenant, 1)
  on conflict (tenant_id) do update set last_value = private.order_counters.last_value + 1
  returning last_value into v_number;

  v_token := private.derive_token(v_order, p_key);
  update public.orders set number = v_number, access_token_hash = private.token_hash(v_token)
   where id = v_order;
  update public.order_requests set order_id = v_order
   where tenant_id = p_tenant and operation = 'create' and idempotency_key = p_key;

  perform private.schedule_order_jobs(v_order, 'order_created');
  return private.order_json(v_order) || jsonb_build_object('access_token', v_token, 'replayed', false);
end $$;

create function private.reschedule_core(p_order uuid, p_pickup timestamptz, p_key uuid,
                                        p_check_grid boolean, p_enforce_deadline boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  t public.tenants;
  v_hash bytea;
  v_req public.order_requests;
  v_prefer jsonb;
  v_opens timestamptz;
  v_closes timestamptz;
  v_result jsonb;
begin
  if p_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into o from public.orders where id = p_order for update;
  if not found then perform private.fail('order_not_found'); end if;
  select * into t from public.tenants where id = o.tenant_id;

  v_hash := extensions.digest(p_order::text || '|' || p_pickup::text, 'sha256');
  insert into public.order_requests (tenant_id, operation, idempotency_key, request_hash, order_id)
  values (o.tenant_id, 'reschedule', p_key, v_hash, p_order)
  on conflict do nothing;
  if not found then
    select * into v_req from public.order_requests
     where tenant_id = o.tenant_id and operation = 'reschedule' and idempotency_key = p_key;
    if v_req.request_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return private.order_json(p_order) || jsonb_build_object('replayed', true);
  end if;

  if o.status <> 'confirmed' then perform private.fail('not_reschedulable', o.status::text); end if;
  if p_enforce_deadline and now() > o.pickup_at - make_interval(mins => t.cancel_notice_minutes) then
    perform private.fail('too_late_to_change');
  end if;

  if p_check_grid then
    select w.window_opens, w.window_closes into v_opens, v_closes from private.grid_window(o.tenant_id, p_pickup) w;
    if v_opens is null then perform private.fail('slot_unavailable', 'not a pickup moment'); end if;
  elsif p_pickup < now() then
    perform private.fail('slot_unavailable', 'pickup in the past');
  end if;

  select coalesce(jsonb_object_agg(prep_profile_id, resource_id), '{}'::jsonb) into v_prefer
    from public.resource_occupancies where order_id = p_order;
  -- Release the old occupancy inside this transaction. If the new moment is
  -- not available, private.fail aborts the transaction and the original
  -- occupancy is restored untouched.
  delete from public.resource_occupancies where order_id = p_order;
  perform private.occupy(o.tenant_id, p_order, private.order_groups(p_order), p_pickup, v_opens, v_closes, v_prefer);

  update public.orders set pickup_at = p_pickup, version = version + 1 where id = p_order;
  perform private.withdraw_jobs(p_order, o.version + 1);
  perform private.schedule_order_jobs(p_order, 'order_rescheduled');

  v_result := private.order_json(p_order);
  update public.order_requests set result = v_result
   where tenant_id = o.tenant_id and operation = 'reschedule' and idempotency_key = p_key;
  return v_result || jsonb_build_object('replayed', false);
end $$;

create function private.cancel_core(p_order uuid, p_reason text, p_enforce_deadline boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  o public.orders;
  t public.tenants;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then perform private.fail('order_not_found'); end if;
  if o.status = 'cancelled' then
    return private.order_json(p_order) || jsonb_build_object('replayed', true);
  end if;
  if o.status not in ('confirmed', 'ready') then perform private.fail('not_cancellable', o.status::text); end if;
  select * into t from public.tenants where id = o.tenant_id;
  if p_enforce_deadline and now() > o.pickup_at - make_interval(mins => t.cancel_notice_minutes) then
    perform private.fail('too_late_to_change');
  end if;

  delete from public.resource_occupancies where order_id = p_order;
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = left(coalesce(p_reason, ''), 300),
         version = version + 1
   where id = p_order;
  perform private.withdraw_jobs(p_order, null);
  perform private.schedule_order_jobs(p_order, 'order_cancelled');
  return private.order_json(p_order) || jsonb_build_object('replayed', false);
end $$;

-- Customer-side access check: the token is compared by hash only.
create function private.order_by_token(p_order uuid, p_token text) returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.orders
   where id = p_order and access_token_hash = private.token_hash(p_token);
  if v_id is null then perform private.fail('order_not_found'); end if;
  return v_id;
end $$;
