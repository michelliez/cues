"""Mark as reviewed (migration 1500). Real PostgreSQL, temporary local cluster.

    LC_ALL=en_US.UTF-8 uv run pytest supabase/tests/test_review_marks.py

Never uses DATABASE_URL or hosted credentials. Skipped without initdb/pg_ctl/psql.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase/migrations"
MARKS = "20261114001500_review_marks.sql"
TEACHER = "00000000-0000-4000-8000-0000000000e1"
STRANGER = "00000000-0000-4000-8000-0000000000e2"
S_RUN = "00000000-0000-4000-8000-0000000000f1"  # S1, running
S_END = "00000000-0000-4000-8000-0000000000f2"  # S1, ended
S_OTHER = "00000000-0000-4000-8000-0000000000f3"  # S2, running (a different station)


def review(session, seat, activity, n):
    return f"""
      insert into public.teacher_reviews(id, created_at, session_id, seat_id, activity_id,
        priority, evaluation, decision, rationale, evidence_used)
      values (gen_random_uuid(), now() - interval '5 minutes', '{session}', '{seat}', '{activity}',
        'normal',
        jsonb_build_object('session_id','{session}','seat_id','{seat}','activity_id','{activity}',
          'escalation', jsonb_build_object('priority','normal','should_evaluate', true),
          'progress', jsonb_build_object('trend','stalled'), 'n', {n}),
        'teacher_review_warranted', 'Stalled.', '["current_progress"]');"""


def seat_state(session, seat, activity, status):
    return f"""insert into public.seat_state(seat_id, session_id, activity_id, status)
      values ('{seat}', '{session}', '{activity}', '{status}')
      on conflict (seat_id) do update set status = excluded.status,
        session_id = excluded.session_id, activity_id = excluded.activity_id;"""


@pytest.fixture(scope="module")
def db():
    if not all(shutil.which(tool) for tool in ("initdb", "pg_ctl", "psql")):
        pytest.skip("local PostgreSQL tools unavailable")
    with tempfile.TemporaryDirectory(prefix="cues-review-marks-") as directory:
        data = str(Path(directory) / "data")
        env = {
            **os.environ,
            "PGHOST": directory,
            "PGPORT": "55500",
            "PGDATABASE": "postgres",
            "PGUSER": os.environ.get("USER", ""),
        }

        def run(*args):
            return subprocess.run(args, capture_output=True, text=True, check=True)

        run("initdb", "-D", data, "-A", "trust", "--no-locale")
        run(
            "pg_ctl",
            "-D",
            data,
            "-l",
            str(Path(directory) / "postgres.log"),
            "-o",
            f"-k {directory} -p 55500 -h ''",
            "-w",
            "start",
        )

        def sql(statement, check=True):
            result = subprocess.run(
                ["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1"],
                input=statement,
                env=env,
                text=True,
                capture_output=True,
            )
            if check and result.returncode:
                raise AssertionError(result.stderr)
            return result

        try:
            sql("""
              create role anon; create role authenticated; create role service_role bypassrls;
              create schema auth;
              create table auth.users(id uuid primary key);
              create function auth.uid() returns uuid language sql as $$
                select (nullif(current_setting('request.jwt.claims',true),'')::jsonb
                  ->>'sub')::uuid $$;
              create function auth.role() returns text language sql as $$
                select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;
              create publication supabase_realtime;
            """)
            files = sorted(MIGRATIONS.glob("*.sql"))
            assert MARKS in [f.name for f in files]
            for file in files:
                if file.name < MARKS:
                    sql(file.read_text())
            sql(f"""
              insert into auth.users values ('{TEACHER}'),('{STRANGER}');
              insert into public.stations(id, name) values ('S1','One'),('S2','Two');
              insert into public.seats(id, station_id, display_name, is_simulated) values
                ('S1-P1','S1','Person 1',true),('S1-P2','S1','Person 2',true),
                ('S2-P1','S2','Person 1',true);
              insert into public.station_teachers(station_id, teacher_id) values ('S1','{TEACHER}');
              insert into public.activities(id, name, check_type, no_progress_seconds, config)
                values ('raise_hand','Raise your hand','rule',30,'{{}}'),
                       ('thumbs_up','Thumbs up','gesture',30,'{{}}')
                on conflict (id) do nothing;
              insert into public.sessions(id, station_id, current_activity_id, teacher_id, ended_at)
                values ('{S_END}','S1','raise_hand','{TEACHER}', now() - interval '1 hour');
              insert into public.sessions(id, station_id, current_activity_id, teacher_id)
                values ('{S_RUN}','S1','raise_hand','{TEACHER}'),
                       ('{S_OTHER}','S2','raise_hand','{STRANGER}');
            """)
            # Data from before the migration: a child who already finished still has a review.
            sql(
                review(S_RUN, "S1-P2", "raise_hand", 900)
                + seat_state(S_RUN, "S1-P2", "raise_hand", "done")
            )
            sql((MIGRATIONS / MARKS).read_text())
            yield sql
        finally:
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "stop")


def scalar(db, query):
    return db(query).stdout.strip()


def count(db, where):
    return int(scalar(db, f"select count(*) from public.teacher_reviews where {where};"))


def as_user(db, user, statement):
    claims = f'{{"sub":"{user}","role":"authenticated"}}' if user else "{}"
    return db(
        f"set role authenticated; select set_config('request.jwt.claims','{claims}',false); "
        + statement,
        check=False,
    )


def mark(db, user, session, seat):
    return as_user(db, user, f"select public.mark_seat_reviewed('{session}','{seat}');")


# --- the one-time cleanup --------------------------------------------------------------
def test_a_review_for_a_child_who_already_finished_was_closed_on_apply(db):
    assert (
        scalar(
            db,
            f"select status from public.teacher_reviews where session_id='{S_RUN}' "
            "and seat_id='S1-P2';",
        )
        == "expired"
    )


# --- marking a child as reviewed ---------------------------------------------------------
def test_marking_closes_that_childs_open_reviews_and_records_the_mark(db):
    db(
        review(S_RUN, "S1-P1", "raise_hand", 1)
        + review(S_RUN, "S1-P1", "thumbs_up", 2)
        + review(S_RUN, "S2-P9", "raise_hand", 3)
    )
    done = mark(db, TEACHER, S_RUN, "S1-P1")
    assert done.returncode == 0, done.stderr
    assert '"closed": 2' in done.stdout
    assert count(db, f"session_id='{S_RUN}' and seat_id='S1-P1' and status='pending'") == 0
    assert (
        count(
            db,
            f"session_id='{S_RUN}' and seat_id='S1-P1' and status='reviewed' "
            "and resolved_at >= created_at",
        )
        == 2
    )
    assert count(db, f"session_id='{S_RUN}' and seat_id='S2-P9' and status='pending'") == 1
    assert (
        scalar(
            db,
            f"select marked_by from public.seat_review_marks where session_id='{S_RUN}' "
            "and seat_id='S1-P1';",
        )
        == TEACHER
    )


def test_marking_again_moves_the_mark_forward_and_closes_nothing_new(db):
    before = scalar(
        db,
        f"select marked_at from public.seat_review_marks "
        f"where session_id='{S_RUN}' and seat_id='S1-P1';",
    )
    again = mark(db, TEACHER, S_RUN, "S1-P1")
    assert again.returncode == 0 and '"closed": 0' in again.stdout
    after = scalar(
        db,
        f"select marked_at > '{before}'::timestamptz from "
        f"public.seat_review_marks where session_id='{S_RUN}' and seat_id='S1-P1';",
    )
    assert after == "t"


def test_a_child_with_no_open_review_can_still_be_marked(db):
    # The mark is what resets the child to working, so it must not need a review.
    done = mark(db, TEACHER, S_RUN, "S1-P2")
    assert done.returncode == 0 and '"closed": 0' in done.stdout
    assert (
        scalar(
            db,
            f"select count(*) from public.seat_review_marks "
            f"where session_id='{S_RUN}' and seat_id='S1-P2';",
        )
        == "1"
    )


def test_only_a_signed_in_teacher_of_the_station_can_mark(db):
    assert "Authentication required" in mark(db, None, S_RUN, "S1-P1").stderr
    anon = db(f"set role anon; select public.mark_seat_reviewed('{S_RUN}','S1-P1');", check=False)
    assert anon.returncode and "permission denied" in anon.stderr
    outsider = mark(db, STRANGER, S_RUN, "S1-P1")
    assert outsider.returncode and "Not authorized for station" in outsider.stderr
    service = db(
        f"set role service_role; select public.mark_seat_reviewed('{S_RUN}','S1-P1');", check=False
    )
    assert service.returncode


def test_a_teacher_cannot_mark_another_stations_session_or_an_unknown_person(db):
    other = mark(db, TEACHER, S_OTHER, "S2-P1")
    assert other.returncode and "Not authorized for station" in other.stderr
    unknown = mark(db, TEACHER, S_RUN, "S2-P1")  # a seat of a different station
    assert unknown.returncode and "Unknown person" in unknown.stderr


def test_an_ended_session_cannot_be_marked(db):
    ended = mark(db, TEACHER, S_END, "S1-P1")
    assert ended.returncode and "Session unavailable" in ended.stderr


def test_browsers_cannot_read_or_write_marks_directly(db):
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert (
            scalar(
                db,
                f"select has_table_privilege('authenticated',"
                f"'public.seat_review_marks','{privilege}');",
            )
            == "f"
        )


# --- completing the task closes the review ----------------------------------------------
def test_completing_the_task_closes_that_childs_open_review_for_it(db):
    db(
        review(S_RUN, "S1-P1", "raise_hand", 10)
        + review(S_RUN, "S1-P1", "thumbs_up", 11)
        + review(S_RUN, "S1-P2", "raise_hand", 12)
    )
    db(seat_state(S_RUN, "S1-P1", "raise_hand", "needs_help"))
    assert count(db, f"session_id='{S_RUN}' and seat_id='S1-P1' and status='pending'") == 2
    db(seat_state(S_RUN, "S1-P1", "raise_hand", "done"))
    # Only that child's review for the completed task; another activity and child stay open.
    assert (
        count(
            db,
            f"session_id='{S_RUN}' and seat_id='S1-P1' and activity_id='raise_hand' "
            "and status='expired' and evaluation->>'n'='10'",
        )
        == 1
    )
    assert (
        count(
            db,
            f"session_id='{S_RUN}' and seat_id='S1-P1' and activity_id='thumbs_up' "
            "and status='pending'",
        )
        == 1
    )
    assert count(db, f"session_id='{S_RUN}' and seat_id='S1-P2' and status='pending'") == 1


def test_a_status_that_is_not_done_does_not_close_reviews(db):
    db(review(S_RUN, "S1-P2", "thumbs_up", 20))
    db(seat_state(S_RUN, "S1-P2", "thumbs_up", "review"))
    assert (
        count(
            db,
            f"session_id='{S_RUN}' and seat_id='S1-P2' and activity_id='thumbs_up' "
            "and status='pending'",
        )
        == 1
    )


# --- closed reviews stay closed ----------------------------------------------------------
def test_a_reviewed_review_cannot_be_reopened(db):
    refused = db(
        f"update public.teacher_reviews set status='pending', resolved_at=null "
        f"where session_id='{S_RUN}' and status='reviewed';",
        check=False,
    )
    assert refused.returncode and "review already resolved" in refused.stderr
