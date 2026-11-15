"""Status rules, driven with fake scores and times (no camera)."""

import json

import pytest

from vision.activities import Activity
from vision.status import ExpressionTracker, SeatTracker

GESTURE = Activity("thumbs_up", "Thumbs up", "gesture", 0.78, 0.58, 30)


@pytest.fixture(autouse=True)
def _judged_time_only(monkeypatch):
    """These rules are the judged-time ones (#101); the time-on-task tests turn it on."""
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "0")


def run(tracker, steps):
    """steps: list of (t, score, hand, face). Returns the event types in order."""
    out = []
    for t, score, hand, face in steps:
        out += [e.type for e in tracker.update(t, score, hand, face)]
    return out


def ticks(start, end, score, hand=True, face=True, step=0.1):
    n = int(round((end - start) / step))
    return [(start + i * step, score, hand, face) for i in range(n + 1)]


def test_starts_idle_then_in_progress_when_seen():
    tr = SeatTracker("S1-L", GESTURE)
    assert tr.status == "idle"
    tr.update(0.0, None, True, True)
    assert tr.status == "in_progress"


def test_success_needs_the_hold_time_and_is_sticky():
    tr = SeatTracker("S1-L", GESTURE)
    assert run(tr, ticks(0, 0.8, 0.9)) == []
    assert run(tr, ticks(0.9, 1.2, 0.9)) == ["attempt_success"]
    assert tr.status == "done"
    assert run(tr, ticks(1.3, 5, 0.1)) == []  # done stays done
    assert tr.status == "done"


def test_review_band_emits_review_needed_once():
    tr = SeatTracker("S1-L", GESTURE)
    assert run(tr, ticks(0, 3, 0.65)) == ["review_needed"]
    assert tr.status == "review"
    assert run(tr, ticks(3.1, 6, 0.65)) == []


def test_one_miss_per_hand_appearance():
    tr = SeatTracker("S1-L", GESTURE)
    assert run(tr, ticks(0, 4, 0.2)) == ["attempt_miss"]  # long low attempt: one miss
    run(tr, ticks(4.1, 4.5, None, hand=False))  # hand leaves (face still visible)
    assert run(tr, ticks(4.6, 6, 0.2)) == ["attempt_miss"]  # new attempt


def test_no_miss_without_a_score():
    tr = SeatTracker("S1-L", GESTURE)
    assert run(tr, ticks(0, 5, None)) == []


def test_tracking_lost_after_three_seconds_and_pauses_timer():
    act = Activity("thumbs_up", "Thumbs up", "gesture", 0.78, 0.58, 5)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 2, None))  # 2 s active
    assert run(tr, ticks(2.1, 10, None, hand=False, face=False)) == ["tracking_lost"]
    assert tr.status == "tracking_lost"
    assert tr.active_seconds == pytest.approx(2.0, abs=0.15)  # lost time not counted
    run(tr, [(10.1, None, True, True)])
    assert tr.status == "in_progress"


def test_no_progress_after_active_time_without_review_score():
    act = Activity("thumbs_up", "Thumbs up", "gesture", 0.78, 0.58, 5)
    tr = SeatTracker("S1-L", act)
    events = run(tr, ticks(0, 6, 0.1))
    assert events == ["attempt_miss", "no_progress"]
    assert tr.status == "needs_help"


def test_no_progress_not_sent_if_review_was_reached():
    act = Activity("thumbs_up", "Thumbs up", "gesture", 0.78, 0.58, 5)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 0.5, 0.6))
    assert "no_progress" not in run(tr, ticks(0.6, 8, 0.1))


def test_raise_hand_scores_work_with_rule_thresholds():
    act = Activity("raise_hand", "Raise your hand", "rule", 1.0, 1.0, 30)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 0.5, 0.0))
    assert run(tr, ticks(0.6, 1.8, 1.0)) == ["attempt_success"]


# ---- expression ----------------------------------------------------------
def dist(**probs):
    base = dict.fromkeys(
        ["anger", "contempt", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"],
        0.0,
    )
    base.update(probs)
    return base


def test_expression_event_after_five_seconds_once_per_episode():
    ex = ExpressionTracker()
    out = []
    for i in range(70):  # 7 s of sadness at 0.6
        out += ex.update(i * 0.1, dist(sadness=0.6, neutral=0.4))
    assert len(out) == 1
    e = out[0]
    assert e.type == "expression_context"
    assert e.payload["label"] == "sadness"
    assert e.payload["supporting_only"] is True
    assert e.payload["duration_seconds"] >= 5.0


def test_expression_below_threshold_or_positive_never_fires():
    ex = ExpressionTracker()
    for i in range(100):
        assert ex.update(i * 0.1, dist(sadness=0.4, happiness=0.6)) == []


def test_expression_resets_when_signal_drops():
    ex = ExpressionTracker()
    for i in range(30):
        ex.update(i * 0.1, dist(anger=0.7))
    ex.update(3.1, dist(neutral=0.9))  # drops before 5 s
    assert [e for i in range(40) for e in ex.update(3.2 + i * 0.1, dist(anger=0.7))] == []


# ---- stage: contract objects through the emitter --------------------------
class RecordingEmitter:
    def __init__(self):
        import uuid

        self.session_id = uuid.uuid4()
        self.station_id = "S1"
        self.events = []
        self.states = []

    def emit(self, event):
        self.events.append(json.loads(event.model_dump_json()))

    def update_seat_state(self, state):
        self.states.append(json.loads(state.model_dump_json()))

    def close(self):
        pass


def test_status_stage_emits_shared_contract_events():
    import numpy as np

    from vision.activities import CurrentTasks
    from vision.camera import Frame
    from vision.perception import Match
    from vision.stages.s50_status import StatusStage
    from vision.tests.test_perception import SeatZones

    em = RecordingEmitter()
    stage = StatusStage(emitter=em, tasks=CurrentTasks("thumbs_up"), zones=SeatZones())
    img = np.zeros((480, 640, 3), np.uint8)
    for i in range(20):  # 2 s of a good thumbs-up in S1-L
        ctx = {
            "match": {"S1-L": Match("thumbs_up", 0.9)},
            "hands": {"S1-L": []},
            "faces": {"S1-L": object()},
        }
        stage.process(Frame(img, i * 0.1, i), ctx)
    assert [e["type"] for e in em.events] == ["attempt_success"]
    ev = em.events[0]
    assert ev["seat_id"] == "S1-L" and ev["station_id"] == "S1"
    assert ev["activity_id"] == "thumbs_up" and ev["score"] == pytest.approx(0.9)
    assert ctx["status"]["S1-L"] == "done"
    assert any("EVENT attempt_success S1-L thumbs_up" in line for line in ctx["events"])
    left = [s for s in em.states if s["seat_id"] == "S1-L"]
    assert left[-1]["status"] == "done"
    assert left[-1]["tracking_valid"] is True
    assert {s["seat_id"] for s in em.states} == {"S1-L", "S1-R"}


def _three_second():
    from vision import activities

    activities.load_activities.cache_clear()
    act = activities.get("thumbs_up")
    activities.load_activities.cache_clear()
    return act


def test_a_gesture_flags_after_three_seconds_of_judged_time(monkeypatch, tmp_path):
    from vision import activities

    monkeypatch.setattr(activities, "CUSTOM_FILE", tmp_path / "none.json")
    monkeypatch.delenv("CUES_GESTURE_NO_PROGRESS_SECONDS", raising=False)
    monkeypatch.delenv("CUES_NO_PROGRESS_SECONDS", raising=False)
    tr = SeatTracker("S1-L", _three_second())
    assert "no_progress" not in run(tr, ticks(0, 2.8, 0.1))
    assert "no_progress" in run(tr, ticks(2.9, 3.2, 0.1))
    assert tr.status == "needs_help"
    # No hand found (score None: the task is not observable for this person) is missing
    # evidence, not the child doing nothing: it counts toward nothing.
    tr = SeatTracker("S1-L", _three_second())
    assert run(tr, ticks(0, 10, None, hand=False)) == []
    assert tr.judged_seconds == 0
    # A judged 0.0 (a hand that is clearly not the gesture) is a failure and does count.
    tr = SeatTracker("S1-L", _three_second())
    assert "no_progress" in run(tr, ticks(0, 3.2, 0.0, hand=True))


def test_a_hand_cues_cannot_score_never_counts_as_no_progress():
    # Regression (review of #101): a recorded gesture with no examples, or the gestures
    # stage off, gives score None with a hand up. That is not the child's failure.
    act = Activity("custom_wave", "Wave", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    assert run(tr, ticks(0, 10, None, hand=True)) == []
    assert tr.status == "in_progress"


def test_after_mark_as_reviewed_a_child_is_not_flagged_again_within_seconds():
    from vision.status import REFLAG_AFTER_REVIEW_SECONDS

    act = Activity("thumbs_up", "Thumbs up", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 3.2, 0.1))
    assert tr.status == "needs_help"
    assert tr.acknowledge(3.3)
    assert "no_progress" not in run(tr, ticks(3.3, 3.3 + REFLAG_AFTER_REVIEW_SECONDS - 0.5, 0.1))
    assert "no_progress" in run(
        tr,
        ticks(
            3.3 + REFLAG_AFTER_REVIEW_SECONDS - 0.4, 3.3 + REFLAG_AFTER_REVIEW_SECONDS + 0.3, 0.1
        ),
    )


def test_raise_hand_still_waits_thirty_seconds():
    act = Activity("raise_hand", "Raise your hand", "rule", 1.0, 1.0, 30)
    tr = SeatTracker("S1-L", act)
    assert "no_progress" not in run(tr, ticks(0, 29.5, 0.0))
    assert "no_progress" in run(tr, ticks(29.6, 30.3, 0.0))


def test_a_task_cues_cannot_score_never_flags_even_with_hands_down():
    # From the re-review of #101: "judged" is decided per task, not per frame. A recorded
    # gesture with no examples (or gestures or hands off) flagged children with hands
    # down after 3s, and hand drop-outs slowly added up.
    act = Activity("custom_wave", "Wave", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    steps = ticks(0, 10, None, hand=False)
    out = []
    for t, score, hand, face in steps:
        out += [e.type for e in tr.update(t, score, hand, face, judgeable=False)]
    assert out == [] and tr.status == "in_progress"


# vision.flag_on_time_on_task: past the wait on the task, a child who has not finished
# needs review, whether or not Cues could score their hand.


def test_time_on_task_flags_a_hand_cues_cannot_score(monkeypatch):
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "1")
    act = Activity("pointing", "Pointing", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    assert "no_progress" not in run(tr, ticks(0, 2.8, None, hand=True))
    assert "no_progress" in run(tr, ticks(2.9, 3.3, None, hand=True))
    assert tr.status == "needs_help"


def test_time_on_task_flags_after_a_brief_near_match(monkeypatch):
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "1")
    act = Activity("pointing", "Pointing", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 0.5, 0.65))  # one moment in the review band, not held
    assert "no_progress" in run(tr, ticks(0.6, 3.3, 0.1))
    assert tr.status == "needs_help"


def test_time_on_task_still_waits_after_mark_as_reviewed(monkeypatch):
    from vision.status import REFLAG_AFTER_REVIEW_SECONDS

    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "1")
    act = Activity("pointing", "Pointing", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 3.3, None))
    assert tr.acknowledge(3.4)
    end = 3.4 + REFLAG_AFTER_REVIEW_SECONDS
    assert "no_progress" not in run(tr, ticks(3.4, end - 0.5, None))
    assert "no_progress" in run(tr, ticks(end - 0.4, end + 0.3, None))


def test_time_on_task_never_flags_a_finished_child(monkeypatch):
    monkeypatch.setenv("CUES_FLAG_VISION_FLAG_ON_TIME_ON_TASK", "1")
    act = Activity("pointing", "Pointing", "gesture", 0.78, 0.58, 3)
    tr = SeatTracker("S1-L", act)
    run(tr, ticks(0, 1.5, 0.9))
    assert tr.status == "done"
    assert "no_progress" not in run(tr, ticks(1.6, 6, None))
    assert tr.status == "done"
