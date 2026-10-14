-- Pipeline entry points (service role only). business.json is the input of
-- the pipeline; after publishing, the database is the runtime source of truth.

create function public.tenant_readiness(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
  v_problems text[] := '{}';
begin
  select * into t from public.tenants where slug = p_slug;
  if not found then perform private.fail('tenant_not_found'); end if;
  if not private.is_valid_timezone(t.timezone) then v_problems := v_problems || 'invalid_timezone'; end if;
  if not exists (select 1 from public.products where tenant_id = t.id and is_active) then
    v_problems := v_problems || 'no_active_products';
  end if;
  if exists (select 1 from public.products p where p.tenant_id = t.id and p.is_active
             and not exists (select 1 from public.prep_profile_resources ppr
                             join public.resources r on r.tenant_id = ppr.tenant_id and r.id = ppr.resource_id
                             where ppr.prep_profile_id = p.prep_profile_id and r.is_active)) then
    v_problems := v_problems || 'product_without_resource';
  end if;
  if not exists (select 1 from public.working_hours where tenant_id = t.id) then
    v_problems := v_problems || 'no_working_hours';
  end if;
  if coalesce(t.profile #>> '{contacts,phone}', '') = '' then v_problems := v_problems || 'no_contact_phone'; end if;
  if coalesce(t.profile #>> '{contacts,address}', '') = '' then v_problems := v_problems || 'no_pickup_address'; end if;
  if not exists (select 1 from public.tenant_members where tenant_id = t.id and role = 'owner') then
    v_problems := v_problems || 'no_owner';
  end if;
  if not exists (select 1 from private.pickup_candidates(t.id, private.local_day(now(), t.timezone),
                                                        private.local_day(now(), t.timezone) + t.horizon_days)) then
    v_problems := v_problems || 'no_pickup_moments_in_horizon';
  end if;
  return jsonb_build_object('slug', t.slug, 'status', t.status, 'ready', cardinality(v_problems) = 0,
                            'problems', to_jsonb(v_problems));
end $$;

create function public.publish_tenant(p_payload jsonb, p_mode text default 'preview') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_prev_hash text;
  v_status public.tenant_status;
  v_version int;
  v_readiness jsonb;
  v_purged int := 0;
  o jsonb := p_payload -> 'ordering';
begin
  if p_mode not in ('preview', 'live') then perform private.fail('invalid_mode'); end if;
  if coalesce(p_payload ->> 'config_hash', '') = '' then perform private.fail('config_hash_required'); end if;

  insert into public.tenants as t (slug, name, timezone, currency, locale, pickup_step_minutes,
         min_notice_minutes, horizon_days, cancel_notice_minutes, max_order_lines, profile, status)
  values (p_payload ->> 'slug', p_payload ->> 'name', p_payload ->> 'timezone', p_payload ->> 'currency',
          p_payload ->> 'locale', (o ->> 'pickup_step_minutes')::int, (o ->> 'min_notice_minutes')::int,
          (o ->> 'horizon_days')::int, (o ->> 'cancel_notice_minutes')::int, (o ->> 'max_order_lines')::int,
          p_payload -> 'profile', 'preview')
  on conflict (slug) do update set
    name = excluded.name, timezone = excluded.timezone, currency = excluded.currency,
    locale = excluded.locale, pickup_step_minutes = excluded.pickup_step_minutes,
    min_notice_minutes = excluded.min_notice_minutes, horizon_days = excluded.horizon_days,
    cancel_notice_minutes = excluded.cancel_notice_minutes, max_order_lines = excluded.max_order_lines,
    profile = excluded.profile,
    status = case when t.status = 'draft' then 'preview'::public.tenant_status else t.status end
  returning id, status into v_tenant, v_status;
  select config_hash into v_prev_hash from public.tenants where id = v_tenant;

  -- Resources: upsert by key; removed ones are deactivated, never deleted, so
  -- historical orders and occupancies keep their references.
  insert into public.resources (tenant_id, key, name, kind, sort_order, is_active)
  select v_tenant, r ->> 'key', r ->> 'name', r ->> 'kind', ord::int, true
  from jsonb_array_elements(p_payload -> 'resources') with ordinality as x(r, ord)
  on conflict (tenant_id, key) do update set name = excluded.name, kind = excluded.kind,
    sort_order = excluded.sort_order, is_active = true;
  update public.resources set is_active = false
   where tenant_id = v_tenant
     and key not in (select r ->> 'key' from jsonb_array_elements(p_payload -> 'resources') r);

  insert into public.prep_profiles (tenant_id, key, name, base_minutes, per_kg_minutes, per_unit_minutes,
                                    buffer_minutes, is_active)
  select v_tenant, p ->> 'key', p ->> 'name', (p ->> 'base_minutes')::int,
         coalesce((p ->> 'per_kg_minutes')::numeric, 0), coalesce((p ->> 'per_unit_minutes')::numeric, 0),
         coalesce((p ->> 'buffer_minutes')::int, 0), true
  from jsonb_array_elements(p_payload -> 'prep_profiles') p
  on conflict (tenant_id, key) do update set name = excluded.name, base_minutes = excluded.base_minutes,
    per_kg_minutes = excluded.per_kg_minutes, per_unit_minutes = excluded.per_unit_minutes,
    buffer_minutes = excluded.buffer_minutes, is_active = true;
  update public.prep_profiles set is_active = false
   where tenant_id = v_tenant
     and key not in (select p ->> 'key' from jsonb_array_elements(p_payload -> 'prep_profiles') p);

  delete from public.prep_profile_resources where tenant_id = v_tenant;
  insert into public.prep_profile_resources (tenant_id, prep_profile_id, resource_id)
  select v_tenant, pp.id, r.id
  from jsonb_array_elements(p_payload -> 'prep_profiles') p
  cross join lateral jsonb_array_elements_text(p -> 'resources') rk(key)
  join public.prep_profiles pp on pp.tenant_id = v_tenant and pp.key = p ->> 'key'
  join public.resources r on r.tenant_id = v_tenant and r.key = rk.key;

  insert into public.product_categories (tenant_id, key, name, sort_order, is_active)
  select v_tenant, c ->> 'key', c ->> 'name', ord::int, true
  from jsonb_array_elements(p_payload -> 'categories') with ordinality as x(c, ord)
  on conflict (tenant_id, key) do update set name = excluded.name, sort_order = excluded.sort_order, is_active = true;
  update public.product_categories set is_active = false
   where tenant_id = v_tenant
     and key not in (select c ->> 'key' from jsonb_array_elements(p_payload -> 'categories') c);

  insert into public.products (tenant_id, key, category_id, prep_profile_id, name, description, unit,
                               price_cents, qty_step, min_qty, max_qty, badges, image_path, image_source,
                               is_active, sort_order)
  select v_tenant, p ->> 'key', c.id, pp.id, p ->> 'name', coalesce(p ->> 'description', ''), p ->> 'unit',
         (p ->> 'price_cents')::bigint, (p ->> 'qty_step')::numeric, (p ->> 'min_qty')::numeric,
         (p ->> 'max_qty')::numeric,
         coalesce((select array_agg(b) from jsonb_array_elements_text(p -> 'badges') b), '{}'),
         p ->> 'image_path', 'pipeline', coalesce((p ->> 'is_active')::boolean, true), ord::int
  from jsonb_array_elements(p_payload -> 'products') with ordinality as x(p, ord)
  join public.product_categories c on c.tenant_id = v_tenant and c.key = p ->> 'category'
  join public.prep_profiles pp on pp.tenant_id = v_tenant and pp.key = p ->> 'prep'
  on conflict (tenant_id, key) do update set
    category_id = excluded.category_id, prep_profile_id = excluded.prep_profile_id,
    name = excluded.name, description = excluded.description, unit = excluded.unit,
    price_cents = excluded.price_cents, qty_step = excluded.qty_step, min_qty = excluded.min_qty,
    max_qty = excluded.max_qty, badges = excluded.badges, is_active = excluded.is_active,
    sort_order = excluded.sort_order,
    -- Photos uploaded by the owner in the cabinet survive republishing.
    image_path = case when public.products.image_source = 'owner' then public.products.image_path
                      else excluded.image_path end;
  update public.products set is_active = false
   where tenant_id = v_tenant
     and key not in (select p ->> 'key' from jsonb_array_elements(p_payload -> 'products') p);

  delete from public.working_hours where tenant_id = v_tenant;
  insert into public.working_hours (tenant_id, weekday, opens_at, closes_at)
  select v_tenant, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time
  from jsonb_array_elements(p_payload -> 'hours') h;

  delete from public.schedule_exceptions where tenant_id = v_tenant;
  insert into public.schedule_exceptions (tenant_id, day, is_closed, opens_at, closes_at, note)
  select v_tenant, (e ->> 'day')::date, coalesce((e ->> 'is_closed')::boolean, false),
         (e ->> 'opens')::time, (e ->> 'closes')::time, coalesce(e ->> 'note', '')
  from jsonb_array_elements(coalesce(p_payload -> 'exceptions', '[]'::jsonb)) e;

  update public.tenants
     set config_version = config_version + case when v_prev_hash is distinct from p_payload ->> 'config_hash' then 1 else 0 end,
         config_hash = p_payload ->> 'config_hash'
   where id = v_tenant
  returning config_version into v_version;

  if p_mode = 'live' then
    v_readiness := public.tenant_readiness(p_payload ->> 'slug');
    if not (v_readiness ->> 'ready')::boolean then
      perform private.fail('not_ready_for_live', v_readiness ->> 'problems');
    end if;
    if v_status <> 'live' then
      -- Going live removes everything that was marked as demo.
      with d as (delete from public.orders where tenant_id = v_tenant and is_demo returning 1)
      select count(*) into v_purged from d;
      update public.tenants set status = 'live', live_at = now() where id = v_tenant;
      v_status := 'live';
    end if;
  end if;

  insert into public.tenant_publications (tenant_id, version, config_hash, mode, summary)
  values (v_tenant, v_version, p_payload ->> 'config_hash', p_mode,
          jsonb_build_object('products', jsonb_array_length(p_payload -> 'products'),
                             'resources', jsonb_array_length(p_payload -> 'resources'),
                             'demo_orders_purged', v_purged));

  return jsonb_build_object('tenant_id', v_tenant, 'slug', p_payload ->> 'slug', 'status', v_status,
                            'config_version', v_version, 'demo_orders_purged', v_purged,
                            'changed', v_prev_hash is distinct from p_payload ->> 'config_hash');
end $$;

create function public.add_tenant_member(p_slug text, p_user_id uuid, p_role text default 'owner')
returns jsonb
language sql security definer set search_path = ''
as $$
  insert into public.tenant_members (tenant_id, user_id, role)
  select id, p_user_id, p_role from public.tenants where slug = p_slug
  on conflict (tenant_id, user_id) do update set role = excluded.role
  returning jsonb_build_object('tenant_id', tenant_id, 'user_id', user_id, 'role', role)
$$;

-- Demo data for preview tenants: clearly flagged, never notifies, purged on
-- going live. Future orders go through the real order core, so they occupy
-- resources exactly like real orders; past completed orders are history.
create function public.generate_demo_orders(p_slug text, p_future int default 6, p_past int default 8)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.tenants;
  v_names text[] := array['Демо · Анна', 'Демо · Илья', 'Демо · Мария', 'Демо · Олег', 'Демо · Светлана',
                          'Демо · Тимур', 'Демо · Ксения', 'Демо · Павел'];
  v_products uuid[];
  v_slots timestamptz[];
  v_created int := 0;
  v_past int := 0;
  v_order uuid;
  v_res jsonb;
  i int;
  p record;
begin
  select * into t from public.tenants where slug = p_slug;
  if not found then perform private.fail('tenant_not_found'); end if;
  if t.status <> 'preview' then perform private.fail('demo_only_in_preview'); end if;
  if exists (select 1 from public.orders where tenant_id = t.id and is_demo) then
    return jsonb_build_object('created', 0, 'reason', 'demo data already present');
  end if;

  select array_agg(id order by sort_order) into v_products
    from public.products where tenant_id = t.id and is_active;
  select array_agg(pickup_at order by pickup_at) into v_slots
    from private.pickup_candidates(t.id, private.local_day(now(), t.timezone) + 1,
                                   private.local_day(now(), t.timezone) + least(t.horizon_days, 7));

  for i in 1 .. least(p_future, coalesce(array_length(v_slots, 1), 0) / 3) loop
    select * into p from public.products where id = v_products[1 + (i % array_length(v_products, 1))];
    begin
      v_res := private.create_order_core(t.id,
        jsonb_build_array(jsonb_build_object('product_id', p.id, 'quantity', p.min_qty + p.qty_step * (i % 3))),
        v_slots[1 + i * 3], jsonb_build_object('name', v_names[1 + (i % 8)], 'phone', '+7999000' || lpad(i::text, 4, '0'),
                                               'note', 'Демонстрационный заказ'),
        extensions.gen_random_uuid(), 'demo', true);
      v_created := v_created + 1;
    exception when sqlstate 'P0001' then
      null; -- slot did not fit this product's preparation; skip
    end;
  end loop;

  for i in 1 .. p_past loop
    select * into p from public.products where id = v_products[1 + (i % array_length(v_products, 1))];
    insert into public.orders (tenant_id, pickup_at, customer_name, customer_phone, note, subtotal_cents,
                               final_amount_cents, currency, source, is_demo, status, arrived_at, completed_at,
                               created_at)
    values (t.id, now() - make_interval(days => i, hours => 2), v_names[1 + (i % 8)],
            '+7999100' || lpad(i::text, 4, '0'), 'Демонстрационный заказ',
            round(p.price_cents * p.min_qty)::bigint, round(p.price_cents * p.min_qty * 1.04)::bigint,
            t.currency, 'demo', true,
            case when i % 7 = 0 then 'no_show'::public.order_status else 'completed'::public.order_status end,
            case when i % 7 = 0 then null else now() - make_interval(days => i, hours => 2) end,
            case when i % 7 = 0 then null else now() - make_interval(days => i, hours => 2) end,
            now() - make_interval(days => i + 1))
    returning id into v_order;
    insert into private.order_counters (tenant_id, last_value) values (t.id, 1)
    on conflict (tenant_id) do update set last_value = private.order_counters.last_value + 1;
    update public.orders set number = (select last_value from private.order_counters where tenant_id = t.id)
     where id = v_order;
    insert into public.order_items (tenant_id, order_id, product_id, prep_profile_id, product_name, unit,
                                    unit_price_cents, quantity, line_total_cents)
    values (t.id, v_order, p.id, p.prep_profile_id, p.name, p.unit, p.price_cents, p.min_qty,
            round(p.price_cents * p.min_qty)::bigint);
    if i % 7 <> 0 then
      insert into public.payments (tenant_id, order_id, amount_cents, method, received_at, is_demo, idempotency_key, note)
      values (t.id, v_order, round(p.price_cents * p.min_qty * 1.04)::bigint,
              case when i % 2 = 0 then 'card' else 'cash' end, now() - make_interval(days => i, hours => 2),
              true, extensions.gen_random_uuid(), 'Демо-оплата');
    end if;
    v_past := v_past + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'past', v_past);
end $$;
