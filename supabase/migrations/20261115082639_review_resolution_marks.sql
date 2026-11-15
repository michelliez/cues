-- A teacher's review answer acknowledges the camera flag in the same transaction.
-- Reuse the existing mark readers in vision and the agent; never fabricate a camera
-- observation or overwrite the teacher's confirmed/dismissed answer with 'reviewed'.
begin;

-- Resolve review rows before acquiring the mark row, matching the answer RPC's
-- order. Otherwise a concurrent mark and answer can each hold the row the other
-- needs (mark -> review versus review -> mark).
create or replace function public.mark_seat_reviewed(p_session_id uuid, p_seat_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  closed integer;
  stamp timestamptz;
begin
  if uid is null or auth.role() is distinct from 'authenticated' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into s from public.sessions where id = p_session_id for share;
  if s.id is null or s.ended_at is not null or s.station_id is null then
    raise exception 'Session unavailable' using errcode = '22023';
  end if;
  perform public.require_station_teacher(s.station_id);
  if not exists (select 1 from public.seats
                 where id = p_seat_id and station_id = s.station_id) then
    raise exception 'Unknown person for this station' using errcode = '22023';
  end if;
  update public.teacher_reviews r
    set status = 'reviewed', resolved_at = greatest(pg_catalog.clock_timestamp(), r.created_at)
    where r.session_id = p_session_id and r.seat_id = p_seat_id and r.status = 'pending';
  get diagnostics closed = row_count;
  insert into public.seat_review_marks(session_id, seat_id, marked_at, marked_by)
    values (p_session_id, p_seat_id, pg_catalog.clock_timestamp(), uid)
    on conflict (session_id, seat_id)
    do update set marked_at = excluded.marked_at, marked_by = excluded.marked_by
    returning marked_at into stamp;
  return jsonb_build_object('closed', closed, 'marked_at', stamp);
end $$;
revoke all on function public.mark_seat_reviewed(uuid, text) from public, anon, service_role;
grant execute on function public.mark_seat_reviewed(uuid, text) to authenticated;

create function public.acknowledge_resolved_teacher_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.seat_review_marks(session_id, seat_id, marked_at, marked_by)
    select new.session_id, new.seat_id, new.resolved_at, auth.uid()
    from public.sessions s
    where s.id = new.session_id and s.ended_at is null
      and s.current_activity_id = new.activity_id
    on conflict (session_id, seat_id) do update
      set marked_at = excluded.marked_at, marked_by = excluded.marked_by
      where public.seat_review_marks.marked_at < excluded.marked_at;
  return null;
end $$;
revoke all on function public.acknowledge_resolved_teacher_review()
  from public, anon, authenticated, service_role;

create trigger teacher_review_answer_marks_seat
  after update of status on public.teacher_reviews
  for each row when (old.status = 'pending' and new.status in ('confirmed', 'dismissed'))
  execute function public.acknowledge_resolved_teacher_review();

commit;
