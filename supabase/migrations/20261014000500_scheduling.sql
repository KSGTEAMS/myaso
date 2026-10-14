-- Scheduling primitives. All local-time math is done in the tenant timezone;
-- local wall-clock timestamps are converted with AT TIME ZONE so DST and
-- date boundaries are handled by PostgreSQL itself.

-- Local calendar day of an instant in the tenant timezone.
create function private.local_day(p_ts timestamptz, p_tz text) returns date
language sql immutable set search_path = ''
as $$ select (p_ts at time zone p_tz)::date $$;

-- Pickup windows for one local day: date exceptions replace weekly hours.
create function private.pickup_windows(p_tenant uuid, p_day date)
returns table (opens timestamptz, closes timestamptz)
language sql stable security definer set search_path = ''
as $$
  with t as (select timezone from public.tenants where id = p_tenant),
  ex as (
    select e.* from public.schedule_exceptions e
    where e.tenant_id = p_tenant and e.day = p_day
  )
  select ((p_day + e.opens_at)::timestamp at time zone t.timezone),
         ((p_day + e.closes_at)::timestamp at time zone t.timezone)
  from ex e, t
  where not exists (select 1 from ex where is_closed) and not e.is_closed
  union all
  select ((p_day + w.opens_at)::timestamp at time zone t.timezone),
         ((p_day + w.closes_at)::timestamp at time zone t.timezone)
  from public.working_hours w, t
  where w.tenant_id = p_tenant
    and w.weekday = extract(isodow from p_day)::int
    and not exists (select 1 from ex)
$$;

-- Candidate pickup moments on the tenant grid between two local dates,
-- respecting minimum notice and booking horizon.
create function private.pickup_candidates(p_tenant uuid, p_from date, p_to date)
returns table (pickup_at timestamptz, window_opens timestamptz, window_closes timestamptz)
language sql stable security definer set search_path = ''
as $$
  select g.local_ts at time zone t.timezone, w.opens, w.closes
  from public.tenants t
  cross join lateral generate_series(p_from, p_to, interval '1 day') d(day)
  cross join lateral private.pickup_windows(t.id, d.day::date) w
  cross join lateral generate_series(
      (w.opens at time zone t.timezone),
      (w.closes at time zone t.timezone) - make_interval(mins => 1),
      make_interval(mins => t.pickup_step_minutes)) g(local_ts)
  where t.id = p_tenant
    and (g.local_ts at time zone t.timezone) >= now() + make_interval(mins => t.min_notice_minutes)
    and (g.local_ts at time zone t.timezone) <= now() + make_interval(days => t.horizon_days)
  order by 1
$$;

-- Price and validate requested lines. Input: [{"product_id": uuid, "quantity": number}].
-- Prices, names and prep profiles come from the catalog, never from the client.
create function private.price_lines(p_tenant uuid, p_items jsonb)
returns table (product_id uuid, prep_profile_id uuid, product_name text, unit text,
               unit_price_cents bigint, quantity numeric, line_total_cents bigint)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_max int;
  v_count int;
  v_bad record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform private.fail('empty_order');
  end if;
  select max_order_lines into v_max from public.tenants where id = p_tenant;
  v_count := jsonb_array_length(p_items);
  if v_count > v_max then
    perform private.fail('too_many_lines', v_count::text);
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where jsonb_typeof(e -> 'quantity') <> 'number'
                or (e ->> 'product_id') !~ '^[0-9a-f-]{36}$') then
    perform private.fail('invalid_line');
  end if;
  if (select count(distinct e ->> 'product_id') from jsonb_array_elements(p_items) e) <> v_count then
    perform private.fail('duplicate_product');
  end if;

  for v_bad in
    select e ->> 'product_id' as pid, (e ->> 'quantity')::numeric as qty, p.id as found,
           p.is_active, p.min_qty, p.max_qty, p.qty_step
    from jsonb_array_elements(p_items) e
    left join public.products p on p.tenant_id = p_tenant and p.id = (e ->> 'product_id')::uuid
  loop
    if v_bad.found is null or not v_bad.is_active then
      perform private.fail('product_unavailable', v_bad.pid);
    end if;
    if v_bad.qty < v_bad.min_qty or v_bad.qty > v_bad.max_qty or mod(v_bad.qty, v_bad.qty_step) <> 0 then
      perform private.fail('invalid_quantity', v_bad.pid);
    end if;
  end loop;

  return query
    select p.id, p.prep_profile_id, p.name, p.unit, p.price_cents,
           (e ->> 'quantity')::numeric,
           round(p.price_cents * (e ->> 'quantity')::numeric)::bigint
    from jsonb_array_elements(p_items) e
    join public.products p on p.tenant_id = p_tenant and p.id = (e ->> 'product_id')::uuid
    order by p.sort_order, p.name;
end $$;

-- Lines grouped by prep profile: each group occupies one resource for
-- `minutes + buffer` ending at pickup. Rounded up to 5 minutes.
create function private.prep_groups(p_tenant uuid, p_lines jsonb)
returns table (prep_profile_id uuid, minutes int, buffer_minutes int, eligible int)
language sql stable security definer set search_path = ''
as $$
  with l as (
    select (x ->> 'prep_profile_id')::uuid as prep_profile_id, x ->> 'unit' as unit,
           (x ->> 'quantity')::numeric as quantity
    from jsonb_array_elements(p_lines) x
  )
  select pp.id,
         greatest(5, (ceil((pp.base_minutes
            + pp.per_kg_minutes * coalesce(sum(l.quantity) filter (where l.unit = 'kg'), 0)
            + pp.per_unit_minutes * coalesce(sum(l.quantity) filter (where l.unit = 'pcs'), 0)) / 5.0) * 5)::int),
         pp.buffer_minutes,
         (select count(*)::int from public.prep_profile_resources r
            join public.resources res on res.tenant_id = r.tenant_id and res.id = r.resource_id
           where r.prep_profile_id = pp.id and res.is_active)
  from l
  join public.prep_profiles pp on pp.tenant_id = p_tenant and pp.id = l.prep_profile_id
  group by pp.id, pp.base_minutes, pp.per_kg_minutes, pp.per_unit_minutes, pp.buffer_minutes
  order by 4, 2 desc
$$;

create function private.group_period(p_pickup timestamptz, p_minutes int, p_buffer int)
returns tstzrange
language sql immutable set search_path = ''
as $$ select tstzrange(p_pickup - make_interval(mins => p_minutes + p_buffer), p_pickup, '[)') $$;

-- A group fits a pickup window when preparation does not start in the past
-- and, if the whole preparation fits inside one window, it happens that day
-- while the shop is open. Longer (multi-day) preparation may run overnight.
create function private.group_fits(p_period tstzrange, p_opens timestamptz, p_closes timestamptz)
returns boolean
language sql stable set search_path = ''
as $$
  select lower(p_period) >= now()
     and (upper(p_period) - lower(p_period) > p_closes - p_opens or lower(p_period) >= p_opens)
$$;

-- Free eligible resources for a period, ordered by preference.
create function private.free_resources(p_tenant uuid, p_profile uuid, p_period tstzrange,
                                       p_prefer uuid default null, p_skip uuid[] default '{}')
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select r.id
  from public.prep_profile_resources ppr
  join public.resources r on r.tenant_id = ppr.tenant_id and r.id = ppr.resource_id
  where ppr.tenant_id = p_tenant and ppr.prep_profile_id = p_profile and r.is_active
    and not (r.id = any (p_skip))
    and not exists (
      select 1 from public.resource_occupancies o
      where o.tenant_id = p_tenant and o.resource_id = r.id and o.period && p_period)
  order by (r.id = p_prefer) desc nulls last, r.sort_order, r.name
$$;

-- Greedy assignment of distinct free resources to every group (groups of one
-- order overlap in time, so they can never share a resource). Returns null
-- when the pickup moment cannot be served.
create function private.plan_assignment(p_tenant uuid, p_groups jsonb, p_pickup timestamptz,
                                        p_opens timestamptz, p_closes timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  g jsonb;
  v_period tstzrange;
  v_res uuid;
  v_used uuid[] := '{}';
  v_out jsonb := '[]'::jsonb;
begin
  for g in select * from jsonb_array_elements(p_groups) loop
    v_period := private.group_period(p_pickup, (g ->> 'minutes')::int, (g ->> 'buffer_minutes')::int);
    if p_opens is not null and not private.group_fits(v_period, p_opens, p_closes) then
      return null;
    end if;
    select f into v_res from private.free_resources(p_tenant, (g ->> 'prep_profile_id')::uuid, v_period, null, v_used) f limit 1;
    if v_res is null then
      return null;
    end if;
    v_used := v_used || v_res;
    v_out := v_out || jsonb_build_object('prep_profile_id', g ->> 'prep_profile_id', 'resource_id', v_res,
                                         'starts_at', lower(v_period), 'ends_at', upper(v_period));
  end loop;
  return v_out;
end $$;
