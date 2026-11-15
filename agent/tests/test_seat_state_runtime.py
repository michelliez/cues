from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from agent.deep_agent import create_cues_deep_agent
from agent.escalation import DEMO_ESCALATION_CONFIG
from agent.progress_history import ProgressHistoryStore
from agent.seat_state_runtime import (
    SeatStatePipeline,
    SeatStateRuntime,
    SupabaseSeatStateSource,
)
from agent.teacher_review import TeacherReviewStore
from shared.contracts import Activity, SeatState

START = datetime(2026, 11, 14, tzinfo=UTC)


def activity(activity_id="task", check_type="rule"):
    return Activity(
        id=activity_id,
        name=activity_id,
        check_type=check_type,
        success_threshold=0.9 if check_type == "gesture" else None,
        no_progress_seconds=30,
    )


# A stall is built from observable low scores: 0.0 is a judged failure, while None means
# the task could not be judged (missing evidence), which never accumulates toward a stall.
def snapshot(seconds, *, seat="A", activity_id="task", score=0.0, **changes):
    return SeatState.model_validate(
        {
            "session_id": UUID(int=1),
            "seat_id": seat,
            "activity_id": activity_id,
            "status": "in_progress",
            "tracking_valid": True,
            "task_score": score,
            "updated_at": START + timedelta(seconds=seconds),
        }
        | changes
    )


class RecordingAgent:
    def __init__(self, *, fail_seat=None):
        self.contexts = []
        self.fail_seat = fail_seat

    def run(self, context):
        if context.request.seat_id == self.fail_seat:
            raise RuntimeError("provider unavailable")
        self.contexts.append(context)
        return SimpleNamespace(assessment="ok", pending_review=None)


def pipeline(activities=None, agent=None):
    history = ProgressHistoryStore()
    return SeatStatePipeline(
        activities or [activity()],
        agent or RecordingAgent(),
        history,
        progress_window_seconds=2,
        escalation_config=DEMO_ESCALATION_CONFIG,
        clock=lambda: START + timedelta(seconds=20),
    )


def feed(target, rows):
    return [target.process_row(row, now=row.updated_at) for row in rows]


def test_improving_state_does_not_route():
    target = pipeline([activity(check_type="gesture")])
    results = feed(target, [snapshot(i, score=s) for i, s in enumerate([0.2, 0.34, 0.49])])
    assert results[-1].progress.trend == "improving"
    assert results[-1].request is None
    assert target.agent.contexts == []


def test_stalled_state_routes_through_enricher_and_agent():
    target = pipeline()
    results = feed(target, [snapshot(i) for i in range(5)])
    routed = results[-1]
    assert routed.progress.trend == "stalled"
    assert routed.escalation.should_evaluate
    assert routed.request is not None and routed.agent_result is not None
    assert target.agent.contexts[0].activity.id == "task"
    assert target.agent.contexts[0].request is routed.request


def test_demo_rule_stall_logs_transitions_without_per_observation_spam(caplog):
    import logging

    caplog.set_level(logging.INFO, logger="agent.seat_state_runtime")
    target = pipeline([activity("raise_hand")])
    results = feed(target, [snapshot(i, activity_id="raise_hand", score=0) for i in range(10)])
    assert results[2].progress.trend == "stalled"
    assert results[4].request is not None
    assert results[6].escalation.reason == "prolonged_stalled_progress"
    assert "tracking=True score=0.0" in caplog.text
    assert "progress=unknown->stalled" in caplog.text
    assert "escalation=stalled_progress route=evaluate" in caplog.text
    assert "Agent evaluation started" in caplog.text
    transitions = [r for r in caplog.records if "vision_status=" in r.message]
    assert len(transitions) == 4  # initial, stalled, normal, prolonged


def test_new_owned_session_restarts_completed_stream():
    target = pipeline([activity("raise_hand")])
    completed = target.process_row(snapshot(0, activity_id="raise_hand", status="done"), now=START)
    assert completed.progress.trend == "completed"
    rows = [
        snapshot(i, activity_id="raise_hand", score=0, session_id=UUID(int=2)) for i in range(1, 11)
    ]
    results = feed(target, rows)
    assert results[2].progress.trend == "stalled"
    assert results[4].request.session_id == UUID(int=2)


def simulate_polling(target, *, poll_seconds, fetch_seconds, fixed_rate, until=40):
    """Vision rewrites a stuck child's row every 1.03s; the agent polls Supabase."""
    results = []
    started = 0.0
    while started < until:
        read_at = started + fetch_seconds
        observation = int((started + fetch_seconds / 2) / 1.03) * 1.03
        result = target.process_row(
            snapshot(observation, activity_id="raise_hand", status="needs_help", score=0),
            now=START + timedelta(seconds=read_at),
        )
        if result is not None:
            results.append(result)
        wait = max(0.0, poll_seconds - fetch_seconds) if fixed_rate else poll_seconds
        started = read_at + wait
    return results


def test_demo_polling_does_not_skip_one_second_vision_heartbeats():
    # Measured hosted Supabase reads take 0.5-0.8s per poll, not 0.1s.
    for fetch_seconds in (0.1, 0.5, 0.8):
        results = simulate_polling(
            pipeline([activity("raise_hand")]),
            poll_seconds=0.5,
            fetch_seconds=fetch_seconds,
            fixed_rate=True,
        )
        assert all(r.progress.trend == "stalled" for r in results[3:])
        assert any(r.escalation.reason == "prolonged_stalled_progress" for r in results)


def test_dev_profile_escalates_a_stuck_child_despite_slow_supabase_reads():
    # Regression: a 2s gap limit plus a full 1s sleep after a 0.5-0.8s read skipped
    # a vision row every few polls, so the stall timer never reached 10s and the
    # To review tab stayed empty while the person row said Needs Review.
    for fetch_seconds, fixed_rate in ((0.5, False), (0.8, False), (0.8, True), (1.2, True)):
        target = SeatStatePipeline(
            [activity("raise_hand")],
            RecordingAgent(),
            ProgressHistoryStore(),
            clock=lambda: START,
        )
        simulate_polling(
            target, poll_seconds=1.0, fetch_seconds=fetch_seconds, fixed_rate=fixed_rate
        )
        assert len(target.agent.contexts) >= 1, (fetch_seconds, fixed_rate)
        assert target.agent.contexts[0].request.escalation.reason == "stalled_progress"


def test_two_missed_heartbeats_still_reset_the_stall_window():
    target = pipeline([activity("raise_hand")])
    rows = [snapshot(t, activity_id="raise_hand", score=0) for t in (0, 1, 2, 3, 6.5, 7.5)]
    results = feed(target, rows)
    assert results[3].progress.trend == "stalled"
    assert results[4].progress.trend == "unknown"


def test_run_forever_polls_at_a_fixed_rate():
    waits = []
    clock = iter([0.0, 0.7, 1.0, 2.4, 2.4, 2.4])

    class Source:
        def fetch(self):
            return []

    class Stop:
        def __init__(self):
            self.calls = 0

        def is_set(self):
            return self.calls >= 3

        def wait(self, seconds):
            self.calls += 1
            waits.append(round(seconds, 2))

    runtime = SeatStateRuntime(Source(), pipeline(), poll_seconds=1.0)
    runtime.monotonic = lambda: next(clock)
    runtime.run_forever(Stop())
    # A 0.7s read waits 0.3s; a read slower than the period does not wait at all.
    assert waits == [0.3, 0.0, 1.0]


def test_tracking_loss_never_routes_or_turns_null_score_into_failure():
    target = pipeline()
    results = feed(
        target,
        [
            snapshot(i, tracking_valid=False, status="tracking_lost", task_score=None)
            for i in range(8)
        ],
    )
    assert all(result.progress.trend == "unknown" for result in results)
    assert all(not result.escalation.should_evaluate for result in results)
    assert target.agent.contexts == []


def test_exact_unchanged_row_is_not_processed_twice():
    target = pipeline()
    row = snapshot(0)
    assert target.process_row(row, now=row.updated_at) is not None
    assert target.process_row(row, now=row.updated_at) is None
    history = target.history.get_recent_progress_history(UUID(int=1), "A", "task")
    assert len(history) == 1


def test_activity_change_partitions_progress_state():
    target = pipeline([activity("task"), activity("other")])
    feed(target, [snapshot(i) for i in range(3)])
    changed = target.process_row(snapshot(3, activity_id="other"), now=START + timedelta(seconds=3))
    assert changed.progress.trend == "unknown"
    assert len(target._evaluators) == 2


def test_expression_only_elevates_existing_stall():
    without = pipeline()
    plain = feed(without, [snapshot(i) for i in range(6)])[-1]
    with_expression = pipeline()
    rows = [snapshot(i) for i in range(5)] + [
        snapshot(
            5,
            expression_context={
                "label": "sadness",
                "probability": 0.62,
                "duration_seconds": 5,
                "supporting_only": True,
            },
        )
    ]
    supported = feed(with_expression, rows)[-1]
    assert plain.escalation.priority == "normal"
    assert supported.escalation.priority == "elevated"
    isolated = pipeline().process_row(rows[-1], now=rows[-1].updated_at)
    assert not isolated.escalation.should_evaluate


class FakeSource:
    def __init__(self, rows):
        self.rows = rows

    def fetch(self):
        return self.rows


def test_one_bad_seat_does_not_corrupt_another(caplog):
    target = pipeline()
    runtime = SeatStateRuntime(FakeSource([{"seat_id": "bad"}, snapshot(0, seat="good")]), target)
    results = runtime.run_once()
    assert [result.snapshot.seat_id for result in results] == ["good"]
    assert "SeatState processing failed for seat bad" in caplog.text


def test_agent_failure_for_one_seat_does_not_stop_next_seat(caplog):
    agent = RecordingAgent(fail_seat="bad")
    target = pipeline(agent=agent)
    # Warm both streams until the next row becomes eligible.
    feed(target, [snapshot(i, seat=seat) for i in range(4) for seat in ("bad", "good")])
    target.clock = lambda: START + timedelta(seconds=4)
    runtime = SeatStateRuntime(
        FakeSource([snapshot(4, seat="bad"), snapshot(4, seat="good")]), target
    )
    results = runtime.run_once()
    assert [result.snapshot.seat_id for result in results] == ["good"]
    assert agent.contexts[0].request.seat_id == "good"
    assert "RuntimeError" in caplog.text


def test_supabase_source_selects_only_contract_fields():
    response = SimpleNamespace(data=[snapshot(0).model_dump(mode="json")])
    query = SimpleNamespace(execute=lambda: response)

    class Table:
        def __init__(self):
            self.fields = None

        def select(self, fields):
            self.fields = fields
            return query

    table = Table()
    client = SimpleNamespace(table=lambda name: table if name == "seat_state" else None)
    import pytest

    with pytest.raises(RuntimeError, match="station provider"):
        SupabaseSeatStateSource(client).fetch()
    rows = SupabaseSeatStateSource(client, station_provider=lambda: None).fetch()
    assert rows == []
    assert table.fields is None


class ActionModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_orchestrator_reaches_existing_review_storage_action_path():
    model = ActionModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "request_teacher_review",
                        "id": "review",
                        "args": {
                            "rationale": "Repeated stalled progress warrants teacher review.",
                            "evidence_used": ["current_progress"],
                        },
                    }
                ],
            )
        ]
    )
    history = ProgressHistoryStore()
    reviews = TeacherReviewStore()
    agent = create_cues_deep_agent(model, history, reviews=reviews)
    target = SeatStatePipeline(
        [activity()],
        agent,
        history,
        progress_window_seconds=2,
        escalation_config=DEMO_ESCALATION_CONFIG,
    )
    result = feed(target, [snapshot(i) for i in range(5)])[-1]
    assert result.agent_result.pending_review is not None
    assert reviews.get_pending_reviews() == [result.agent_result.pending_review]


def test_revision_restart_clears_completion_and_routes_again():
    target = pipeline()
    feed(target, [snapshot(0, status="done", session_revision=0)])
    results = feed(target, [snapshot(i, score=0, session_revision=1) for i in range(1, 8)])
    assert results[-1].progress.trend == "stalled"
    assert any(result.request is not None for result in results)


def test_station_source_filters_session_revision_and_foreign_seats():
    from unittest.mock import MagicMock

    client = MagicMock()
    rows = [
        snapshot(3, seat="S2-P1", session_revision=1).model_dump(mode="json"),
        snapshot(3, seat="S1-P1", session_revision=1).model_dump(mode="json"),
        snapshot(3, seat="S2-P2", session_revision=0).model_dump(mode="json"),
    ]
    session = {"id": str(UUID(int=1)), "current_activity_id": "task", "revision": 1}
    active = client.table.return_value.select.return_value.eq.return_value.is_
    active.return_value.execute.return_value.data = [session]
    query = client.table.return_value.select.return_value.eq.return_value.execute
    query.side_effect = [
        SimpleNamespace(data=[{"id": "S2-P1"}, {"id": "S2-P2"}]),
        SimpleNamespace(data=rows),
    ]
    assert SupabaseSeatStateSource(client, lambda: "S2").fetch() == [rows[0]]


# ---- "Mark as reviewed" restarts stall detection ----------------------------------
def test_a_marked_child_must_stall_again_before_a_new_review_is_routed():
    target = pipeline()
    first = feed(target, [snapshot(i) for i in range(6)])
    assert any(result.request is not None for result in first)  # stalled: a review is routed
    key = (UUID(int=1), "A")
    # The existing marks are only recorded the first time (a restarted worker is not reset).
    target.apply_review_marks({})
    # The teacher marks the child reviewed.
    target.apply_review_marks({key: START + timedelta(seconds=6)})
    # The same stalled stream does not route again at once: the timer starts from scratch.
    after = feed(target, [snapshot(6 + i) for i in range(3)])
    assert not any(result.request is not None for result in after if result)
    assert after[0].progress.trend == "unknown"
    # A fresh stall, a few seconds later, routes a new review.
    later = feed(target, [snapshot(9 + i) for i in range(6)])
    assert any(result.request is not None for result in later if result)


def test_marks_that_already_exist_when_the_worker_starts_do_not_reset_anyone():
    target = pipeline()
    old = {(UUID(int=1), "A"): START - timedelta(minutes=5)}
    target.apply_review_marks(old)  # first call: recorded, not acted on
    results = feed(target, [snapshot(i) for i in range(6)])
    assert any(result.request is not None for result in results)
    target.apply_review_marks(old)  # the same old mark again: still nothing
    assert target.router is not None
    again = feed(target, [snapshot(6 + i) for i in range(2)])
    assert again[-1] is not None and again[-1].progress.trend == "stalled"  # not reset


def test_a_mark_for_another_child_leaves_this_one_alone():
    target = pipeline()
    feed(target, [snapshot(i) for i in range(6)])
    target.apply_review_marks({})
    target.apply_review_marks({(UUID(int=1), "B"): START + timedelta(seconds=6)})
    after = feed(target, [snapshot(6 + i) for i in range(2)])
    assert after[-1] is not None and after[-1].progress.trend == "stalled"


def test_the_source_reads_the_active_sessions_marks():
    from unittest.mock import MagicMock

    client = MagicMock()
    session = {"id": str(UUID(int=1)), "current_activity_id": "task", "revision": 0}
    active = client.table.return_value.select.return_value.eq.return_value.is_
    active.return_value.execute.return_value.data = [session]
    seats = client.table.return_value.select.return_value.eq.return_value.execute
    seats.side_effect = [
        SimpleNamespace(data=[{"id": "S1-P1"}]),
        SimpleNamespace(data=[]),
        SimpleNamespace(data=[{"seat_id": "S1-P1", "marked_at": "2026-11-14T00:00:06+00:00"}]),
    ]
    source = SupabaseSeatStateSource(client, lambda: "S1")
    assert source.fetch_marks() == {}  # nothing fetched yet: no session known
    source.fetch()
    assert source.fetch_marks() == {(UUID(int=1), "S1-P1"): START + timedelta(seconds=6)}


def test_a_missing_marks_table_does_not_stop_the_runtime(caplog):
    class Source:
        def fetch(self):
            return [snapshot(1)]

        def fetch_marks(self):
            raise RuntimeError("relation does not exist")

    runtime = SeatStateRuntime(Source(), pipeline())
    runtime.run_once()
    runtime.run_once()
    assert caplog.text.count("Review marks unavailable") == 1  # said once, not every second
