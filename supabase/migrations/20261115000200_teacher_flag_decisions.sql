-- Preserve a teacher's answer to a camera flag without inventing an agent review.
-- Requires 20261115000100's review-before-mark lock order.
begin;

create table public.teacher_flag_decisions (
  id uuid primary key,
  session_id uuid not null references public.sessions(id),
  seat_id text not null references public.seats(id),
  activity_id text not null references public.activities(id),
  session_revision integer not null check (session_revision >= 0),
  observed_at timestamptz not null,
  decision text not null check (decision in ('confirmed', 'dismissed')),
  decided_at timestamptz not null default clock_timestamp(),
  teacher_id uuid not null references auth.users(id),
  unique (session_id, seat_id, session_revision, observed_at)
);
create index teacher_flag_decisions_session_person
  on public.teacher_flag_decisions(session_id, seat_id, decided_at);
alter table public.teacher_flag_decisions enable row level security;
revoke all on public.teacher_flag_decisions from public, anon, authenticated, service_role;
grant select on public.teacher_flag_decisions to authenticated, service_role;
create policy own_session_flag_decisions on public.teacher_flag_decisions
  for select to authenticated using (exists (
    select 1 from public.sessions s
    where s.id = teacher_flag_decisions.session_id and s.teacher_id = auth.uid()
  ));

create function public.guard_teacher_flag_decision() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Teacher decisions are immutable';
end $$;
revoke all on function public.guard_teacher_flag_decision()
  from public, anon, authenticated, service_role;
create trigger teacher_flag_decision_immutable
  before update or delete on public.teacher_flag_decisions
  for each row execute function public.guard_teacher_flag_decision();

create function public.record_teacher_flag_decision(
  p_decision_id uuid, p_session_id uuid, p_seat_id text, p_activity_id text,
  p_expected_revision integer, p_observed_at timestamptz, p_decision text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  observation public.seat_state;
  saved public.teacher_flag_decisions;
  stamp timestamptz;
begin
  if uid is null or auth.role() is distinct from 'authenticated' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_decision_id is null or p_activity_id is null or p_decision is null
     or p_decision not in ('confirmed', 'dismissed') then
    raise exception 'Invalid teacher decision' using errcode = '22023';
  end if;
  select * into s from public.sessions where id = p_session_id for share;
  if s.id is null or s.teacher_id is distinct from uid then
    raise exception 'Review outside owned session' using errcode = '42501';
  end if;
  if not exists (select 1 from public.seats
                 where id = p_seat_id and station_id = s.station_id) then
    raise exception 'Unknown person for this station' using errcode = '22023';
  end if;
  -- Serialize decision requests without locking vision's seat_state row. Vision
  -- takes station/session locks while writing; holding its row could invert that
  -- order against a concurrent session change. Heartbeats may continue throughout.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_id::text || ':' || p_seat_id, 0));
  select * into observation from public.seat_state where seat_id = p_seat_id;
  select * into saved from public.teacher_flag_decisions where id = p_decision_id;
  if found then
    if saved.teacher_id is distinct from uid or saved.session_id is distinct from p_session_id
       or saved.seat_id is distinct from p_seat_id or saved.activity_id is distinct from p_activity_id
       or saved.session_revision is distinct from p_expected_revision
       or saved.observed_at is distinct from p_observed_at or saved.decision is distinct from p_decision then
      raise exception 'Request already used for a different decision' using errcode = '40001';
    end if;
    return to_jsonb(saved); -- No new mark, including a retry after the session ended.
  end if;
  if s.ended_at is not null or s.current_activity_id is distinct from p_activity_id
     or s.revision is distinct from p_expected_revision
     or observation.seat_id is null or observation.session_id is distinct from s.id
     or observation.activity_id is distinct from p_activity_id
     or observation.session_revision is distinct from s.revision
     or observation.status not in ('review', 'needs_help')
     or p_observed_at is null or p_observed_at < clock_timestamp() - interval '30 seconds'
     or p_observed_at > clock_timestamp() + interval '5 seconds'
     or observation.updated_at < p_observed_at
     or observation.updated_at < clock_timestamp() - interval '30 seconds'
     or exists (select 1 from public.seat_review_marks m
                where m.session_id = s.id and m.seat_id = p_seat_id
                  and m.marked_at >= p_observed_at) then
    raise exception 'Flag changed; refresh before deciding' using errcode = '40001';
  end if;
  stamp := clock_timestamp();
  insert into public.teacher_flag_decisions
    (id, session_id, seat_id, activity_id, session_revision, observed_at, decision, decided_at, teacher_id)
    values (p_decision_id, s.id, p_seat_id, p_activity_id, s.revision, p_observed_at, p_decision, stamp, uid)
    returning * into saved;
  -- A request may have arrived since the page rendered. Preserve the actual answer.
  -- As in the preceding repair, acquire review rows before the mark row.
  update public.teacher_reviews r set status = p_decision,
    resolved_at = greatest(stamp, r.created_at)
    where r.session_id = s.id and r.seat_id = p_seat_id
      and r.activity_id = p_activity_id and r.status = 'pending';
  insert into public.seat_review_marks(session_id, seat_id, marked_at, marked_by)
    values (s.id, p_seat_id, stamp, uid)
    on conflict (session_id, seat_id) do update
      set marked_at = excluded.marked_at, marked_by = excluded.marked_by
      where public.seat_review_marks.marked_at < excluded.marked_at;
  return to_jsonb(saved);
end $$;
revoke all on function public.record_teacher_flag_decision(uuid,uuid,text,text,integer,timestamptz,text)
  from public, anon, service_role;
grant execute on function public.record_teacher_flag_decision(uuid,uuid,text,text,integer,timestamptz,text)
  to authenticated;

commit;
