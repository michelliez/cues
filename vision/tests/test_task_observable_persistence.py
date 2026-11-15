"""task_observable travels: scorer -> SeatState -> Supabase -> agent reader -> evaluator."""

import json
from unittest.mock import MagicMock
from uuid import UUID

import numpy as np
import pytest
from pydantic import ValidationError

from shared.contracts import SeatState
from vision.activities import CurrentTasks
from vision.camera import Frame
from vision.gestures.hand_pose import open_palm_check
from vision.people import PeopleGrouping
from vision.perception import Hand
from vision.stages.s35_raise_hand import RaiseHandStage
from vision.stages.s50_status import StatusStage
from vision.tests.hands import PERSONS_RIGHT, open_palm
from vision.tests.test_people import people_ctx, pose
from vision.tests.test_status import RecordingEmitter

IMG = np.zeros((480, 640, 3), np.uint8)


def state(**over):
    base = dict(
        seat_id="S1-P1",
        session_id=UUID(int=1),
        status="in_progress",
        updated_at="2026-11-15T00:00:00Z",
        tracking_valid=True,
    )
    return SeatState(**(base | over))


# ---- the contract ----------------------------------------------------------
def test_seat_state_observability_is_explicit_and_follows_the_score_when_unset():
    assert state(task_score=0.0).task_observable is True  # 0.0 is judged, not missing
    assert state(task_score=None).task_observable is False
    assert state(task_score=0.0, task_observable=True).task_observable is True
    assert state(task_score=None, task_observable=False).task_observable is False
    assert json.loads(state(task_score=0.0).model_dump_json())["task_observable"] is True


def test_seat_state_refuses_an_observability_that_contradicts_the_score():
    with pytest.raises(ValidationError):
        state(task_score=None, task_observable=True)  # observable needs a score
    with pytest.raises(ValidationError):
        state(task_score=0.0, task_observable=False)  # missing evidence is never a number


# ---- palm evidence: missing is not wrong -------------------------------------
def test_palm_check_separates_missing_evidence_from_a_wrong_palm():
    assert open_palm_check(None) is None  # no hand
    good = Hand(open_palm(0.2, 0.25), PERSONS_RIGHT, "S1-P1", {"Open_Palm": 0.95})
    assert open_palm_check(good) is True
    fist = Hand(open_palm(0.2, 0.25), PERSONS_RIGHT, "S1-P1", {"Open_Palm": 0.1})
    assert open_palm_check(fist) is False  # clearly not an open palm
    edge_on = np.array(open_palm(0.2, 0.25))
    edge_on[17] = edge_on[5]  # the two knuckles in line: seen edge-on
    assert open_palm_check(Hand(edge_on, PERSONS_RIGHT, "S1-P1", {"Open_Palm": 0.95})) is None


def raise_hand_match(hands):
    ctx, _ = people_ctx(pose(0.5, wrist_up=True))
    pid = next(iter(ctx["people"]))
    ctx["hands"] = {pid: hands(pid)} if hands else {}
    RaiseHandStage(tasks=CurrentTasks("raise_hand"), zones=PeopleGrouping()).process(
        Frame(IMG, 0.0, 1), ctx
    )
    return ctx["match"][pid]


def test_raise_hand_with_an_edge_on_hand_is_missing_evidence_not_a_wrong_palm():
    def edge_on(pid):
        lm = np.array(open_palm(0.2, 0.25))
        lm[17] = lm[5]
        return [Hand(lm, PERSONS_RIGHT, pid, {"Open_Palm": 0.95})]

    match = raise_hand_match(edge_on)
    assert match.observable is False and match.score is None
    assert match.reason_code == "palm_indeterminate"


# ---- vision writes it, and unobservable time is not judged time ---------------
def run_status(match_for, task, frames=14):
    emitter = RecordingEmitter()
    stage = StatusStage(emitter=emitter, tasks=CurrentTasks(task), zones=PeopleGrouping())
    for i in range(frames):
        ctx, _ = people_ctx(pose(0.5), t=i * 0.1)
        pid = next(iter(ctx["people"]))
        ctx["match"] = {pid: match_for(task)}
        ctx["hands"] = {}
        ctx["scorable"] = {task: True}  # scorable in general; says nothing about this person
        stage.process(Frame(IMG, i * 0.1, i), ctx)
    return emitter, stage


@pytest.mark.parametrize("task", ["raise_hand", "open_palm"])
def test_status_writes_task_observable_false_with_a_null_score_and_counts_no_judged_time(task):
    from vision.perception import Match

    emitter, stage = run_status(lambda t: Match(t, None, reason_code="no_owned_hand"), task)
    last = emitter.states[-1]
    assert last["task_observable"] is False and last["task_score"] is None
    assert all(tr.judged_seconds == 0 for tr in stage._trackers.values())


@pytest.mark.parametrize("task", ["raise_hand", "open_palm"])
def test_status_writes_task_observable_true_with_a_zero_score_and_counts_judged_time(task):
    from vision.perception import Match

    emitter, stage = run_status(lambda t: Match(t, 0.0, reason_code="observable_wrong"), task)
    last = emitter.states[-1]
    assert last["task_observable"] is True and last["task_score"] == 0.0  # 0.0 kept, not dropped
    assert all(tr.judged_seconds > 0 for tr in stage._trackers.values())


# ---- Supabase and the agent reader work before and after the column exists ---------
def test_the_writer_falls_back_when_the_column_is_not_applied_yet():
    from vision.events import SupabaseSink

    client = MagicMock()
    table = client.table.return_value
    calls = []

    def upsert(payload, on_conflict):
        calls.append(dict(payload))
        if "task_observable" in payload:
            raise RuntimeError("Could not find the 'task_observable' column (PGRST204)")
        return MagicMock()

    table.upsert.side_effect = upsert
    sink = SupabaseSink(client)
    row = {"seat_id": "S1-P1", "task_score": 0.0, "task_observable": True, "status": "in_progress"}
    sink.write_seat_state(row)  # first write retries without the column
    sink.write_seat_state(row)  # and stops sending it
    assert [("task_observable" in c) for c in calls] == [True, False, False]


def test_the_agent_reader_falls_back_when_the_column_is_not_applied_yet():
    from agent.seat_state_runtime import SupabaseSeatStateSource

    source = SupabaseSeatStateSource(MagicMock(), station_provider=lambda: "S1")
    queries = []

    def table(name):
        query = MagicMock()
        if name == "seat_state":
            fields = {}

            def select(value):
                fields["v"] = value
                queries.append(value)
                return query

            query.select.side_effect = select
            query.eq.return_value = query

            def execute():
                if "task_observable" in fields["v"]:
                    raise RuntimeError("column seat_state.task_observable does not exist")
                return MagicMock(data=[{"seat_id": "S1-P1"}])

            query.execute.side_effect = execute
        return query

    source.client.table.side_effect = table
    rows = source._seat_state_rows("session")
    assert rows == [{"seat_id": "S1-P1"}]
    assert "task_observable" in queries[0] and "task_observable" not in queries[1]
    source._seat_state_rows("session")
    assert "task_observable" not in queries[-1]  # remembered
