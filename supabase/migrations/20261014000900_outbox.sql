-- Notification outbox worker API (service role only; called by the
-- `notify-dispatch` Edge Function from Supabase Cron).

create function public.claim_notification_jobs(p_worker text, p_limit int default 20,
                                               p_lease_seconds int default 60)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_jobs jsonb;
begin
  -- Exhausted jobs whose lease expired become failed.
  update public.notification_jobs set status = 'failed', lease_until = null,
         last_error = coalesce(last_error, 'max attempts reached')
   where status = 'processing' and lease_until < now() and attempts >= max_attempts;

  -- Withdraw jobs that no longer match their order (rescheduled, cancelled,
  -- completed) before anybody claims them.
  update public.notification_jobs j set status = 'cancelled', last_error = 'stale', lease_until = null
    from public.orders o
   where o.id = j.order_id and j.status in ('pending', 'processing')
     and (j.lease_until is null or j.lease_until < now())
     and j.kind in ('pickup_reminder', 'order_ready')
     and (o.status in ('cancelled', 'completed', 'no_show') or (j.order_version is not null and j.order_version <> o.version));

  with picked as (
    select id from public.notification_jobs
     where ((status = 'pending' and run_at <= now())
         or (status = 'processing' and lease_until < now()))
       and attempts < max_attempts
     order by run_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  ), claimed as (
    update public.notification_jobs j
       set status = 'processing', attempts = j.attempts + 1, locked_by = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds)
      from picked where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'tenant_id', c.tenant_id, 'order_id', c.order_id, 'kind', c.kind,
      'audience', c.audience, 'attempts', c.attempts, 'payload', c.payload,
      'tenant', (select jsonb_build_object('slug', t.slug, 'name', t.name, 'timezone', t.timezone)
                   from public.tenants t where t.id = c.tenant_id),
      'order', case when c.order_id is null then null else
                 (select jsonb_build_object('number', o.number, 'pickup_at', o.pickup_at, 'status', o.status)
                    from public.orders o where o.id = c.order_id) end,
      'targets', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint,
                            'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                    from public.push_subscriptions s
                   where s.tenant_id = c.tenant_id and s.revoked_at is null and s.audience = c.audience
                     and (c.audience = 'owner' or s.order_id = c.order_id)))), '[]'::jsonb)
    into v_jobs
  from claimed c;
  return v_jobs;
end $$;

create function public.complete_notification_job(p_job_id bigint, p_worker text, p_delivered int)
returns boolean
language sql security definer set search_path = ''
as $$
  update public.notification_jobs
     set status = case when p_delivered > 0 then 'sent' else 'skipped' end,
         sent_at = now(), lease_until = null,
         last_error = case when p_delivered > 0 then null else 'no active subscriptions' end
   where id = p_job_id and locked_by = p_worker and status = 'processing'
  returning true
$$;

create function public.fail_notification_job(p_job_id bigint, p_worker text, p_error text,
                                             p_retry_seconds int default 60)
returns boolean
language sql security definer set search_path = ''
as $$
  update public.notification_jobs
     set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
         run_at = now() + make_interval(secs => p_retry_seconds * power(2, greatest(attempts - 1, 0))::int),
         lease_until = null, last_error = left(p_error, 500)
   where id = p_job_id and locked_by = p_worker and status = 'processing'
  returning true
$$;

create function public.push_delivery_result(p_subscription_id uuid, p_ok boolean, p_gone boolean)
returns void
language sql security definer set search_path = ''
as $$
  update public.push_subscriptions
     set last_success_at = case when p_ok then now() else last_success_at end,
         failure_count = case when p_ok then 0 else failure_count + 1 end,
         revoked_at = case when p_gone or failure_count >= 9 then now() else revoked_at end
   where id = p_subscription_id
$$;
