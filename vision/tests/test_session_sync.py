"""Station lifecycle: authoritative IDs, frame isolation and fail-closed task checks."""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from pydantic import ValidationError

from shared.contracts import Session
from vision import activities
from vision.activities import CurrentTasks
from vision.camera import Frame
from vision.perception import Match
from vision.session_sync import (
    SESSION_LEASE_SECONDS,
    StationSessionState,
    StationSessionSync,
    frame_activity,
)
from vision.stages.s00_session import SessionStage
from vision.stages.s50_status import StatusStage
from vision.tests.test_perception import SeatZones
from vision.tests.test_status import RecordingEmitter


def session(**changes):
    return Session.model_validate(
        dict(
            id=uuid4(),
            station_id="S1",
            current_activity_id="thumbs_up",
            started_at=datetime.now(UTC),
            ended_at=None,
            revision=0,
        )
        | changes
    )


class Query:
    def __init__(self, client):
        self.client = client
        self.active = False

    def select(self, *_):
        return self

    def eq(self, *_):
        return self

    def is_(self, *_):
        self.active = True
        return self

    def order(self, *_, **__):
        return self

    def limit(self, *_):
        return self

    def execute(self):
        if self.client.fail_read:
            raise ConnectionError("private transport detail")
        rows = self.client.rows
        if self.active:
            rows = [s for s in rows if s["ended_at"] is None]
        return SimpleNamespace(data=rows)


class Client:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.fail_read = self.fail_ack = False

    def table(self, _):
        return Query(self)

    def rpc(self, name, args):
        if self.fail_ack:
            raise ConnectionError("private transport detail")
        self.calls.append((name, args))
        return SimpleNamespace(execute=lambda: None)


def test_lease_pauses_old_frames_expiry_and_end():
    clock = [10.0]
    state = StationSessionState(lambda: clock[0])
    s = session()
    state.confirm(s)
    assert state.for_frame(9.9) is None
    assert state.for_frame(10) == s
    clock[0] = 12
    state.confirm(s)  # heartbeat does not discard frames for the same configuration
    assert state.for_frame(11) == s
    # A stalled poll (busy laptop) does not pause frames before the lease runs out.
    clock[0] = 12 + SESSION_LEASE_SECONDS - 0.1
    assert state.for_frame(clock[0]) == s
    clock[0] = 12 + SESSION_LEASE_SECONDS + 0.1
    assert state.for_frame(clock[0]) is None
    state.confirm(s.model_copy(update={"ended_at": datetime.now(UTC), "revision": 1}))
    assert state.for_frame(16) is None
    state.confirm(None)
    assert state.for_frame(16) is None


def test_sync_acknowledges_shared_identity_and_ended_session():
    s = session()
    client = Client([s.model_dump(mode="json")])
    state = StationSessionState(lambda: 10)
    sync = StationSessionSync(client, "S1", state)
    assert sync.check_once() == s
    assert state.for_frame(10) == s
    name, args = client.calls[-1]
    assert name == "report_station_session"
    assert args["p_session_id"] == str(s.id) and args["p_revision"] == 0
    assert args["p_status"] == "ready"
    client.rows[0].update(ended_at=datetime.now(UTC).isoformat(), revision=1)
    sync.check_once()
    assert state.for_frame(11) is None
    assert client.calls[-1][1]["p_status"] == "idle"
    assert client.calls[-1][1]["p_activity_id"] is None
    assert client.calls[-1][1]["p_session_id"] == str(s.id)


@pytest.mark.parametrize("failure", ["fail_read", "fail_ack", "unknown", "ambiguous"])
def test_sync_failures_never_keep_processing(failure, caplog):
    s = session()
    client = Client([s.model_dump(mode="json")])
    state = StationSessionState(lambda: 10)
    state.confirm(s)
    sync = StationSessionSync(client, "S1", state)
    if failure == "unknown":
        client.rows[0]["current_activity_id"] = "not_a_task"
        assert sync.check_once() is None
        assert client.calls[-1][1]["p_error"] == "unsupported_activity"
    else:
        if failure == "ambiguous":
            client.rows.append(session().model_dump(mode="json"))
        else:
            setattr(client, failure, True)
        with pytest.raises(ValueError if failure == "ambiguous" else ConnectionError):
            sync.check_once()
    assert state.for_frame(11) is None
    assert "private transport detail" not in caplog.text


def test_frames_pin_session_and_reset_completed_task_for_new_revision_and_uuid():
    clock = [10.0]
    state = StationSessionState(lambda: clock[0])
    s = session()
    state.confirm(s)
    pin = SessionStage(state)
    emitter = RecordingEmitter()
    tasks = CurrentTasks("raise_hand")  # local task must not override teacher session
    status = StatusStage(emitter=emitter, tasks=tasks, zones=SeatZones())
    image = np.zeros((480, 640, 3), np.uint8)

    def process(t, change_after_pin=None):
        clock[0] = t
        state.confirm(s)
        frame = Frame(image, t, int(t * 10))
        ctx = {"hands": {"S1-L": []}, "faces": {"S1-L": object()}}
        pin.process(frame, ctx)
        if change_after_pin:
            state.confirm(change_after_pin)
        assert frame_activity(tasks, "S1-L", ctx) == "thumbs_up"
        ctx["match"] = {"S1-L": Match("thumbs_up", 0.9)}
        status.process(frame, ctx)
        return ctx

    for i in range(20):
        ctx = process(10 + i / 10)
    assert ctx["status"]["S1-L"] == "done"
    assert {row["session_id"] for row in emitter.states} == {str(s.id)}
    assert emitter.events[0]["payload"]["session_revision"] == 0
    s = s.model_copy(update={"revision": 1})
    assert process(12)["status"]["S1-L"] == "in_progress"
    assert emitter.states[-1]["session_revision"] == 1
    new_session = session()
    process(12.1, change_after_pin=new_session)
    assert emitter.states[-1]["session_id"] == str(s.id)  # immutable per-frame scope
    state.confirm(s.model_copy(update={"ended_at": datetime.now(UTC), "revision": 2}))
    ctx = {}
    pin.process(Frame(image, 12.2, 123), ctx)
    counts = len(emitter.states), len(emitter.events)
    status.process(Frame(image, 12.2, 123), ctx)
    assert ctx["status"] == {} and ctx["match"] == {}
    assert counts == (len(emitter.states), len(emitter.events))
    s = new_session
    assert process(13)["status"]["S1-L"] == "in_progress"
    assert emitter.states[-1]["session_id"] == str(s.id)


def test_paused_task_stages_do_not_evaluate_or_initialize_emitter():
    from vision.stages.s30_gestures import GesturesStage
    from vision.stages.s35_raise_hand import RaiseHandStage

    ctx = {"session_managed": True, "session": None, "hands": {"S1-L": [object()]}}
    frame = Frame(np.zeros((2, 2, 3), np.uint8), 0, 0)
    for stage in [
        GesturesStage(zones=SeatZones()),
        RaiseHandStage(zones=SeatZones()),
        StatusStage(zones=SeatZones()),
    ]:
        stage.process(frame, ctx)
    assert ctx["match"] == {} and ctx["status"] == {}


def test_session_and_revision_contracts_are_strict():
    for revision in [-1, 1.5, True, "1"]:
        with pytest.raises(ValidationError):
            session(revision=revision)
    with pytest.raises(ValidationError):
        session(started_at=datetime(2026, 1, 1))
    with pytest.raises(ValidationError):
        session(extra_field="no")


def test_flag_off_keeps_local_tasks_and_legacy_writer_shape(monkeypatch):
    from vision.activity_sync import sync_from_env
    from vision.events import SupabaseSink
    from vision.tests.test_integration_parts import FakeClient

    monkeypatch.setenv("CUES_FLAG_VISION_SESSION_LIFECYCLE", "0")
    monkeypatch.setenv("CUES_FLAG_VISION_ACTIVITY_SYNC", "0")
    assert sync_from_env() is None
    assert frame_activity(CurrentTasks("raise_hand"), "S1-L", {}) == "raise_hand"
    client = FakeClient()
    sink = SupabaseSink(client)
    sink.write_seat_state({"seat_id": "S1-L", "session_revision": None})
    assert "session_revision" not in client.store["seat_state"][-1]
    sink.write_seat_state({"seat_id": "S1-L", "session_revision": 0})
    assert client.store["seat_state"][-1]["session_revision"] == 0


def test_lifecycle_without_credentials_stays_paused(monkeypatch):
    from vision import supabase_client
    from vision.activity_sync import sync_from_env

    monkeypatch.setenv("CUES_FLAG_VISION_SESSION_LIFECYCLE", "1")
    monkeypatch.setattr(supabase_client, "get_client", lambda: None)
    assert sync_from_env() is None


def test_session_stage_is_loaded_first_only_when_enabled(monkeypatch):
    from vision import flags
    from vision.pipeline import discover_stages

    for name in flags.load_registry():
        if name.startswith("vision."):
            monkeypatch.setenv(flags.env_name(name), "0")
    assert "session" not in [stage.name for stage in discover_stages()]
    monkeypatch.setenv("CUES_FLAG_VISION_SESSION_LIFECYCLE", "1")
    assert discover_stages()[0].name == "session"


def test_stopping_sync_cannot_reactivate_a_late_response():
    s = session()
    state = StationSessionState(lambda: 10)
    sync = StationSessionSync(Client([s.model_dump(mode="json")]), "S1", state)
    sync.stop()
    assert sync.check_once() is None
    assert state.for_frame(11) is None


def test_gesture_stage_scores_nothing_while_session_is_paused():
    from types import SimpleNamespace

    from vision.stages.s30_gestures import GesturesStage

    class OnePerson:
        def ids(self, ctx):
            return ["S1-P1"]

    stage = GesturesStage(zones=OnePerson())
    ctx = {"session_managed": True, "session": None, "hands": {"S1-P1": [object()]}}
    stage.process(SimpleNamespace(timestamp=0.0), ctx)
    assert ctx["match"] == {}


def test_managed_session_stores_expression_context_events():
    # Regression: the session_revision tag made every expression_context event fail
    # validation, which also aborted the rest of the status stage for that frame.
    clock = [10.0]
    state = StationSessionState(lambda: clock[0])
    s = session(revision=3)
    pin = SessionStage(state)
    emitter = RecordingEmitter()
    status = StatusStage(emitter=emitter, tasks=CurrentTasks("thumbs_up"), zones=SeatZones())
    image = np.zeros((480, 640, 3), np.uint8)
    for i in range(80):
        clock[0] = t = 10 + i / 10
        state.confirm(s)
        frame = Frame(image, t, i)
        ctx = {
            "hands": {"S1-L": []},
            "faces": {"S1-L": object()},
            "expression": {"S1-L": {"sadness": 0.8, "neutral": 0.2}},
        }
        pin.process(frame, ctx)
        ctx["match"] = {"S1-L": Match("thumbs_up", 0.1)}
        status.process(frame, ctx)
    expression = [e for e in emitter.events if e["type"] == "expression_context"]
    assert len(expression) == 1
    assert expression[0]["payload"]["session_revision"] == 3
    assert expression[0]["payload"]["label"] == "sadness"


def test_a_sync_pause_keeps_each_persons_status_until_a_new_revision():
    # Regression: one frame without a session (the lease lapsed while the laptop was busy)
    # reset every tracker, so a flagged or finished child went back to working and the
    # no-progress timer started over.
    clock = [10.0]
    state = StationSessionState(lambda: clock[0])
    s = session(current_activity_id="thumbs_up")
    pin = SessionStage(state)
    emitter = RecordingEmitter()
    status = StatusStage(emitter=emitter, tasks=CurrentTasks("thumbs_up"), zones=SeatZones())
    image = np.zeros((480, 640, 3), np.uint8)

    def process(t, confirm=True, current=None):
        clock[0] = t
        if confirm:
            state.confirm(current or s)
        frame = Frame(image, t, int(t * 10))
        ctx = {"hands": {"S1-L": []}, "faces": {"S1-L": object()}}
        pin.process(frame, ctx)
        ctx["match"] = {"S1-L": Match("thumbs_up", 0.9)}
        status.process(frame, ctx)
        return ctx

    for i in range(20):
        ctx = process(10 + i / 10)
    assert ctx["status"]["S1-L"] == "done"
    state.invalidate()  # the sync lapsed
    paused = process(12.1, confirm=False)
    assert paused["status"] == {}
    writes = len(emitter.states)
    assert process(12.2, confirm=False)["status"] == {} and len(emitter.states) == writes
    # Back, same session and revision: still done, not working again.
    assert process(12.5)["status"]["S1-L"] == "done"
    # The teacher restarts the activity (new revision): everyone starts over.
    s = s.model_copy(update={"revision": s.revision + 1})
    assert process(13)["status"]["S1-L"] == "in_progress"


class _Run:
    """One station camera on S1-L under a managed session, frame by frame."""

    def __init__(self):
        self.clock = [10.0]
        self.state = StationSessionState(lambda: self.clock[0])
        self.session = session(current_activity_id="thumbs_up")
        self.pin = SessionStage(self.state)
        self.emitter = RecordingEmitter()
        self.zones = SeatZones()
        self.status = StatusStage(
            emitter=self.emitter, tasks=CurrentTasks("thumbs_up"), zones=self.zones
        )
        self.image = np.zeros((480, 640, 3), np.uint8)

    def frame(self, t, score=None, confirm=True, expression=None):
        self.clock[0] = t
        if confirm:
            self.state.confirm(self.session)
        else:
            self.state.invalidate()
        frame = Frame(self.image, t, int(t * 100))
        ctx = {"hands": {"S1-L": []}, "faces": {"S1-L": object()}}
        if expression:
            ctx["expression"] = {"S1-L": expression}
        self.pin.process(frame, ctx)
        if score is not None:
            ctx["match"] = {"S1-L": Match("thumbs_up", score)}
        self.status.process(frame, ctx)
        return ctx

    def events(self, kind):
        return [e for e in self.emitter.events if e["type"] == kind]


def test_a_pause_does_not_count_toward_a_hold():
    # Regression (review of #100): kept trackers measured holds in wall time, so one
    # frame after a 5s pause set done, review or expression_context unseen.
    run = _Run()
    run.frame(10.0, score=0.99)
    run.frame(10.1, score=0.99)
    for i in range(50):
        run.frame(10.2 + i / 10, score=None, confirm=False)
    assert run.frame(15.3, score=0.99)["status"]["S1-L"] == "in_progress"
    assert run.events("attempt_success") == []
    # The observed 0.1s before the pause still counts: 0.9s more of holding is enough.
    for i in range(10):
        ctx = run.frame(15.4 + i / 10, score=0.99)
    assert ctx["status"]["S1-L"] == "done"


def test_review_and_expression_holds_also_skip_the_pause():
    run = _Run()
    sad = {"sadness": 0.9, "neutral": 0.1}
    run.frame(10.0, score=0.6, expression=sad)
    run.frame(10.1, score=0.6, expression=sad)
    for i in range(50):
        run.frame(10.2 + i / 10, confirm=False)
    assert run.frame(15.3, score=0.6, expression=sad)["status"]["S1-L"] == "in_progress"
    assert run.events("review_needed") == [] and run.events("expression_context") == []


def test_a_flagged_person_keeps_review_through_a_pause_and_a_new_session_resets():
    run = _Run()
    for i in range(25):
        ctx = run.frame(10 + i / 10, score=0.6)
    assert ctx["status"]["S1-L"] == "review"
    for i in range(30):
        run.frame(12.5 + i / 10, confirm=False)
    assert run.frame(15.6, score=0.2)["status"]["S1-L"] == "review"
    run.session = session(current_activity_id="thumbs_up")  # a new session, same revision
    assert run.frame(15.7, score=0.2)["status"]["S1-L"] == "in_progress"


def test_an_id_released_during_a_pause_does_not_pass_its_status_on():
    run = _Run()
    for i in range(25):
        ctx = run.frame(10 + i / 10, score=0.6)
    assert ctx["status"]["S1-L"] == "review"
    run.zones.ids = lambda ctx=None: ["S1-R"]  # S1-L released while paused
    run.frame(12.6, confirm=False)
    run.zones.ids = lambda ctx=None: ["S1-L", "S1-R"]  # someone new gets S1-L
    assert run.frame(12.7, score=0.2)["status"]["S1-L"] == "in_progress"


def test_the_session_lease_ends_before_another_camera_can_take_the_station():
    from vision.station_lease import TTL_SECONDS

    assert SESSION_LEASE_SECONDS <= TTL_SECONDS - 2


def test_a_camera_stall_inside_the_lease_does_not_complete_a_hold():
    # From the re-review of #100: frames stop for 5s while the session lease stays
    # valid. Two frames must not make a success or a review.
    run = _Run()
    run.frame(10.0, score=0.99)
    assert run.frame(15.0, score=0.99)["status"]["S1-L"] == "in_progress"
    run2 = _Run()
    run2.frame(10.0, score=0.6)
    assert run2.frame(12.5, score=0.6)["status"]["S1-L"] == "in_progress"
    assert run.events("attempt_success") == [] and run2.events("review_needed") == []


def test_the_session_lease_starts_when_the_check_began():
    clock = [10.0]
    state = StationSessionState(lambda: clock[0])
    s = session()
    clock[0] = 13.5  # the reads after the writer claim at 10.0 were slow
    state.confirm(s, checked_at=10.0)
    clock[0] = 10.0 + SESSION_LEASE_SECONDS - 0.1
    assert state.for_frame(13.5) == s
    clock[0] = 10.0 + SESSION_LEASE_SECONDS + 0.1
    assert state.for_frame(13.5) is None  # measured from 10.0, not 13.5


def test_the_status_stage_counts_no_progress_only_for_a_scorable_task(monkeypatch, tmp_path):
    monkeypatch.setattr(activities, "CUSTOM_FILE", tmp_path / "none.json")
    monkeypatch.delenv("CUES_GESTURE_NO_PROGRESS_SECONDS", raising=False)
    monkeypatch.delenv("CUES_NO_PROGRESS_SECONDS", raising=False)
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "0")
    activities.load_activities.cache_clear()

    def hands_down(scorable, judged=False):
        """5s with a face in view. judged: a hand is up and scored 0.0 (a real failure);
        otherwise there is no hand and no score (missing evidence)."""
        from vision.perception import Match

        run = _Run()
        ctx = None
        for i in range(50):
            t = 10 + i / 10
            run.clock[0] = t
            run.state.confirm(run.session)
            frame = Frame(run.image, t, i)
            ctx = {"hands": {"S1-L": [object()]} if judged else {}, "faces": {"S1-L": object()}}
            if scorable is not None:
                ctx["scorable"] = {"thumbs_up": scorable}
            run.pin.process(frame, ctx)  # starts each frame's matches empty
            if judged:
                ctx["match"] = {"S1-L": Match("thumbs_up", 0.0)}
            run.status.process(frame, ctx)
        return ctx["status"]["S1-L"]

    # Cues can score Thumbs up and the person gave a judged 0.0: 3s counts.
    assert hands_down(True, judged=True) == "needs_help"
    # No hand found is missing evidence, even though the task is scorable in general.
    assert hands_down(True) == "in_progress"
    assert (
        hands_down(False, judged=True) == "in_progress"
    )  # it cannot (no hands stage, no examples)
    assert hands_down(None, judged=True) == "in_progress"  # the gestures stage did not run at all
    # The opt-in mode still counts observed task time, with tracking loss excluded.
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "1")
    assert hands_down(False) == "needs_help"
    assert hands_down(None) == "needs_help"
    activities.load_activities.cache_clear()
