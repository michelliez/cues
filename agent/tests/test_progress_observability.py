"""ProgressEvaluator: missing evidence is unknown, judged failure can stall, for every task type."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from agent.progress import ProgressEvaluator
from shared.contracts import Activity, SeatState

START = datetime(2026, 11, 15, tzinfo=UTC)


def activity(check_type):
    return Activity(
        id="task",
        name="Task",
        check_type=check_type,
        success_threshold=0.7,
        review_threshold=0.4,
        no_progress_seconds=30,
    )


def sample(seconds, score, **changes):
    return SeatState.model_validate(
        dict(
            session_id=UUID(int=1),
            seat_id="S1-P1",
            activity_id="task",
            status="in_progress",
            task_score=score,
            tracking_valid=True,
            updated_at=START + timedelta(seconds=seconds),
        )
        | changes
    )


def feed(evaluator, scores, **changes):
    return [
        evaluator.update(sample(i, score, **changes), now=START + timedelta(seconds=i))
        for i, score in enumerate(scores)
    ]


KINDS = ("rule", "gesture")  # raise_hand is a rule task, open_palm a gesture task


def test_task_observable_follows_the_score_and_zero_is_judged():
    assert sample(0, 0.0).task_observable is True  # 0.0 is a failure, not missing evidence
    assert sample(0, None).task_observable is False
    assert sample(0, 0.0).task_score == 0.0  # no 0.0 / None truthiness mix-up


@pytest.mark.parametrize("kind", KINDS)
def test_repeated_observable_low_scores_stall(kind):
    result = feed(ProgressEvaluator(activity(kind)), [0.0] * 7)[-1]
    assert result.trend == "stalled"
    assert result.stalled_seconds > 0


@pytest.mark.parametrize("kind", KINDS)
def test_missing_evidence_is_unknown_never_a_failure(kind):
    results = feed(ProgressEvaluator(activity(kind)), [None] * 12)
    assert {r.trend for r in results} == {"unknown"}
    assert results[-1].stalled_seconds == 0


@pytest.mark.parametrize("kind", KINDS)
def test_missing_evidence_in_the_middle_clears_the_window(kind):
    evaluator = ProgressEvaluator(activity(kind))
    feed(evaluator, [0.0] * 7)
    assert evaluator.state.trend == "stalled"
    result = evaluator.update(sample(7, None), now=START + timedelta(seconds=7))
    assert result.trend == "unknown"  # not judged: the earlier stall does not carry on


@pytest.mark.parametrize("kind", KINDS)
def test_tracking_invalid_is_unknown_not_failure(kind):
    results = feed(ProgressEvaluator(activity(kind)), [0.0] * 8, tracking_valid=False)
    assert {r.trend for r in results} == {"unknown"}
    lost = feed(ProgressEvaluator(activity(kind)), [0.0] * 8, status="tracking_lost")
    assert {r.trend for r in lost} == {"unknown"}


@pytest.mark.parametrize("kind", KINDS)
def test_a_correct_gesture_still_completes(kind):
    evaluator = ProgressEvaluator(activity(kind))
    if kind == "gesture":
        assert feed(evaluator, [0.9])[0].trend == "completed"  # threshold completes
    else:
        done = evaluator.update(sample(0, 0.9, status="done"), now=START)
        assert done.trend == "completed"  # rule tasks complete on the done status
    assert evaluator.update(sample(1, None), now=START + timedelta(seconds=1)).trend == "completed"
