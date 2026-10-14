-- Read helpers shared by the UI and the AI assistant.

-- Public catalog snapshot of one tenant (no personal data).
create function public.public_catalog(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.tenants;
begin
  t := private.public_tenant(p_slug);
  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status,
                                 'timezone', t.timezone, 'currency', t.currency, 'profile', t.profile),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name) order by c.sort_order)
                            from public.product_categories c where c.tenant_id = t.id and c.is_active), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', p.id, 'key', p.key, 'name', p.name, 'description', p.description,
                            'category', c.name, 'unit', p.unit, 'price_cents', p.price_cents,
                            'qty_step', p.qty_step, 'min_qty', p.min_qty, 'max_qty', p.max_qty,
                            'prep_name', pp.name, 'prep_base_minutes', pp.base_minutes) order by c.sort_order, p.sort_order)
                          from public.products p
                          join public.product_categories c on c.tenant_id = p.tenant_id and c.id = p.category_id
                          join public.prep_profiles pp on pp.tenant_id = p.tenant_id and pp.id = p.prep_profile_id
                          where p.tenant_id = t.id and p.is_active), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'opens', to_char(w.opens_at, 'HH24:MI'),
                         'closes', to_char(w.closes_at, 'HH24:MI')) order by w.weekday, w.opens_at)
                       from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('day', e.day, 'is_closed', e.is_closed,
                              'opens', to_char(e.opens_at, 'HH24:MI'), 'closes', to_char(e.closes_at, 'HH24:MI'),
                              'note', e.note) order by e.day)
                            from public.schedule_exceptions e
                            where e.tenant_id = t.id and e.day >= private.local_day(now(), t.timezone)), '[]'::jsonb));
end $$;
revoke execute on function public.public_catalog(text) from public, anon, authenticated;
grant execute on function public.public_catalog(text) to service_role;

-- The exact interval the stats/schedule use, for UI labels and the assistant.
create function public.owner_period_bounds(p_tenant uuid, p_period text default 'today',
                                           p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.assert_member(p_tenant);
  return private.period_bounds((select timezone from public.tenants where id = p_tenant), p_period, p_from, p_to);
end $$;
revoke execute on function public.owner_period_bounds(uuid, text, date, date) from public, anon;
grant execute on function public.owner_period_bounds(uuid, text, date, date) to authenticated, service_role;
