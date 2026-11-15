"""open_palm success threshold 0.60, from measured correct palms (0.589-0.698, median 0.636)."""

import pytest

from agent.progress import ProgressEvaluator
from shared.contracts import Activity
from vision import activities
from vision.status import SUCCESS_HOLD_SECONDS, SeatTracker


def run(activity_id, score, seconds=SUCCESS_HOLD_SECONDS + 0.5):
    """Feed a steady score for a bit longer than the hold; return the event types."""
    tracker = SeatTracker("S1-P1", activities.get(activity_id))
    events = []
    steps = int(seconds / 0.1) + 1
    for i in range(steps):
        events += [e.type for e in tracker.update(i * 0.1, score, hand=True, face=True)]
    return tracker.status, events


def test_open_palm_thresholds_are_valid_and_raise_hand_is_unchanged():
    palm = activities.get("open_palm")
    assert (palm.success_threshold, palm.review_threshold) == (0.6, 0.5)
    assert palm.review_threshold < palm.success_threshold  # the band stays below success
    hand = activities.get("raise_hand")
    assert (hand.success_threshold, hand.review_threshold) == (0.7, 0.4)
    for item in activities.load_activities().values():  # every entry still validates
        Activity(
            id=item.id,
            name=item.id,
            check_type=item.check_type,
            no_progress_seconds=item.no_progress_seconds,
            success_threshold=item.success_threshold,
            review_threshold=item.review_threshold,
        )


@pytest.mark.parametrize("score", [0.60, 0.636, 0.698])
def test_open_palm_at_or_above_the_threshold_completes_after_the_hold(score):
    status, events = run("open_palm", score)
    assert status == "done" and "attempt_success" in events
    # Not before the one-second hold.
    early_status, early = run("open_palm", score, seconds=SUCCESS_HOLD_SECONDS - 0.3)
    assert early_status != "done" and "attempt_success" not in early


@pytest.mark.parametrize("score", [0.599, 0.589, 0.5, 0.0])
def test_open_palm_below_the_threshold_or_a_closed_fist_never_completes(score):
    status, events = run("open_palm", score, seconds=5)
    assert status != "done" and "attempt_success" not in events


def test_the_progress_evaluator_uses_the_same_threshold():
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from shared.contracts import SeatState

    palm = activities.get("open_palm")
    contract = Activity(
        id=palm.id,
        name="Open palm",
        check_type=palm.check_type,
        no_progress_seconds=palm.no_progress_seconds,
        success_threshold=palm.success_threshold,
        review_threshold=palm.review_threshold,
    )

    def trend(score):
        start = datetime(2026, 11, 15, tzinfo=UTC)
        state = SeatState(
            seat_id="S1-P1",
            session_id=UUID(int=1),
            status="in_progress",
            activity_id="open_palm",
            tracking_valid=True,
            task_score=score,
            updated_at=start,
        )
        return ProgressEvaluator(contract).update(state, now=start + timedelta(seconds=0)).trend

    assert trend(0.60) == "completed"
    assert trend(0.59) != "completed"
    assert trend(0.0) != "completed"
