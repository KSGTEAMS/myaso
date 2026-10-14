-- Row Level Security and strict grants.
--
-- Supabase grants ALL on new public tables and EXECUTE on new functions to
-- anon/authenticated by default. We revoke everything first and then grant
-- back the minimum, column by column where personal data is involved.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid) to anon, authenticated;

-- service_role (Edge Functions, pipeline) works with everything.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.resources enable row level security;
alter table public.prep_profiles enable row level security;
alter table public.prep_profile_resources enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.working_hours enable row level security;
alter table public.schedule_exceptions enable row level security;
alter table public.tenant_publications enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.resource_blocks enable row level security;
alter table public.resource_occupancies enable row level security;
alter table public.payments enable row level security;
alter table public.order_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;

create function private.is_public_tenant(p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.tenants where id = p_tenant and status in ('preview', 'live')) $$;
revoke execute on function private.is_public_tenant(uuid) from public;
grant execute on function private.is_public_tenant(uuid) to anon, authenticated;
grant usage on schema private to anon;

-- ---------- Public catalog (no personal data) ----------
grant select (id, slug, name, status, timezone, currency, locale, pickup_step_minutes, min_notice_minutes,
              horizon_days, cancel_notice_minutes, max_order_lines, profile, config_version)
  on public.tenants to anon, authenticated;
create policy tenants_public_read on public.tenants for select to anon, authenticated
  using (status in ('preview', 'live') or (auth.role() = 'authenticated' and private.is_member(id)));

grant select on public.product_categories, public.products, public.prep_profiles,
                public.working_hours, public.schedule_exceptions to anon, authenticated;
create policy categories_public_read on public.product_categories for select to anon, authenticated
  using (private.is_public_tenant(tenant_id) or private.is_member(tenant_id));
create policy products_public_read on public.products for select to anon, authenticated
  using ((is_active and private.is_public_tenant(tenant_id)) or private.is_member(tenant_id));
create policy prep_profiles_public_read on public.prep_profiles for select to anon, authenticated
  using (private.is_public_tenant(tenant_id) or private.is_member(tenant_id));
create policy hours_public_read on public.working_hours for select to anon, authenticated
  using (private.is_public_tenant(tenant_id) or private.is_member(tenant_id));
create policy exceptions_public_read on public.schedule_exceptions for select to anon, authenticated
  using (private.is_public_tenant(tenant_id) or private.is_member(tenant_id));

-- ---------- Owner-only data (authenticated members) ----------
grant select on public.resources, public.prep_profile_resources, public.order_items,
                public.resource_blocks, public.resource_occupancies, public.payments,
                public.tenant_publications to authenticated;
grant select (id, tenant_id, number, status, pickup_at, customer_name, customer_phone, customer_email, note,
              subtotal_cents, final_amount_cents, currency, source, is_demo, version, arrived_at, ready_at,
              completed_at, cancelled_at, cancel_reason, created_at, updated_at)
  on public.orders to authenticated;   -- access_token_hash is never readable
grant select (tenant_id, user_id, role, created_at) on public.tenant_members to authenticated;
grant select (id, tenant_id, audience, endpoint, created_at, revoked_at, last_success_at)
  on public.push_subscriptions to authenticated;
grant select (id, tenant_id, order_id, kind, audience, run_at, status, attempts, sent_at, last_error, created_at)
  on public.notification_jobs to authenticated;

create policy members_read_own on public.tenant_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy resources_member_read on public.resources for select to authenticated
  using (private.is_member(tenant_id));
create policy ppr_member_read on public.prep_profile_resources for select to authenticated
  using (private.is_member(tenant_id));
create policy publications_member_read on public.tenant_publications for select to authenticated
  using (private.is_member(tenant_id));
create policy orders_member_read on public.orders for select to authenticated
  using (private.is_member(tenant_id));
create policy order_items_member_read on public.order_items for select to authenticated
  using (private.is_member(tenant_id));
create policy blocks_member_read on public.resource_blocks for select to authenticated
  using (private.is_member(tenant_id));
create policy occupancies_member_read on public.resource_occupancies for select to authenticated
  using (private.is_member(tenant_id));
create policy payments_member_read on public.payments for select to authenticated
  using (private.is_member(tenant_id));
create policy push_member_read on public.push_subscriptions for select to authenticated
  using (audience = 'owner' and user_id = (select auth.uid()) and private.is_member(tenant_id));
create policy jobs_member_read on public.notification_jobs for select to authenticated
  using (private.is_member(tenant_id));
-- order_requests: no policy at all -> invisible to anon and authenticated.

-- ---------- RPC grants ----------
-- Owner cabinet: membership is checked inside every function.
grant execute on function
  public.owner_tenants(),
  public.owner_stats(uuid, text, date, date),
  public.owner_schedule(uuid, date, date),
  public.owner_get_order(uuid, uuid),
  public.owner_find_orders(uuid, text, int),
  public.owner_create_order(uuid, jsonb, timestamptz, jsonb, uuid),
  public.owner_reschedule_order(uuid, uuid, timestamptz, uuid),
  public.owner_cancel_order(uuid, uuid, text),
  public.owner_update_order_status(uuid, uuid, text, bigint),
  public.owner_record_payment(uuid, uuid, bigint, text, text, uuid, text),
  public.owner_create_block(uuid, uuid, timestamptz, timestamptz, text, uuid),
  public.owner_delete_block(uuid, uuid),
  public.owner_update_product(uuid, uuid, bigint, boolean, text),
  public.owner_register_push(uuid, jsonb, text),
  public.owner_unregister_push(uuid, text)
to authenticated;
-- Everything else in public (place_order, get_pickup_slots, *_by_token,
-- rate_limit_hit, llm_budget_*, outbox, publish_tenant, ...) is service_role only.
