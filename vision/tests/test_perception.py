"""Perception building blocks, tested with fake MediaPipe / HSEmotion results."""

import time
from types import SimpleNamespace as NS

import numpy as np
import pytest

from vision import activities
from vision.activities import CurrentTasks
from vision.camera import Frame
from vision.gestures import templates as tpl
from vision.gestures.matcher import Matcher, calibrate_rejection
from vision.gestures.normalize import normalize
from vision.perception import Face, Hand, Match
from vision.stages.s10_hands import hands_from_result
from vision.stages.s20_faces import faces_from_result
from vision.stages.s30_gestures import GesturesStage, MatcherCache
from vision.stages.s40_expression import LABELS, ExpressionStage, RollingAverage
from vision.watch import format_seat

RNG = np.random.default_rng(0)


class SeatZones:
    """Test double for the grouping interface: two people, left and right halves.

    Detections within 0.05 of the middle belong to nobody.
    """

    mode = "people"

    def ids(self, ctx=None):
        return ["S1-L", "S1-R"]

    def assign(self, x):
        if abs(x - 0.5) < 0.05 or not 0 <= x <= 1:
            return None
        return "S1-L" if x < 0.5 else "S1-R"

    def hand_owner(self, points, ctx=None):
        return self.assign(float(points[0, 0]))

    def face_owner(self, cx, cy, box=None, ctx=None):
        return self.assign(cx)


def hand_points(offset=(0.25, 0.5), scale=0.1, shape_seed=1):
    """A plausible 21-point hand: fixed shape, placed at offset with given size."""
    shape = np.random.default_rng(shape_seed).normal(0, 1, (21, 3))
    shape[0] = 0
    shape[9] = [0, -1.0, 0]  # middle knuckle straight above the wrist, length 1
    pts = shape * scale
    pts[:, 0] += offset[0]
    pts[:, 1] += offset[1]
    return pts.astype(np.float32)


def mp_hand_result(hands):
    return NS(
        hand_landmarks=[
            [NS(x=float(x), y=float(y), z=float(z)) for x, y, z in pts] for pts, _ in hands
        ],
        handedness=[[NS(category_name=side)] for _, side in hands],
    )


# ---- normalisation -------------------------------------------------------
def test_normalize_ignores_position_and_size():
    a = normalize(hand_points((0.2, 0.5), 0.1))
    b = normalize(hand_points((0.7, 0.3), 0.25))
    assert a.shape == (63,)
    assert np.allclose(a, b, atol=1e-5)


def test_normalize_mirrors_left_hand():
    right = hand_points()
    left = right.copy()
    left[:, 0] = 2 * left[0, 0] - left[:, 0]  # mirror around the wrist
    assert np.allclose(normalize(right, "Right"), normalize(left, "Left"), atol=1e-5)


def test_normalize_rejects_degenerate_hand():
    with pytest.raises(ValueError):
        normalize(np.zeros((21, 3)))


# ---- templates + matcher -------------------------------------------------
def test_templates_round_trip(tmp_path):
    t = tpl.Templates("custom_gesture_01")
    t.add("target", [np.ones(63)])
    t.add("rest", [np.zeros(63)])
    tpl.save(t, tmp_path)
    loaded = tpl.load("custom_gesture_01", tmp_path)
    assert loaded.target == [[1.0] * 63] and loaded.rest == [[0.0] * 63]
    assert tpl.delete("custom_gesture_01", tmp_path)
    assert tpl.load("custom_gesture_01", tmp_path).target == []


def test_templates_reject_bad_ids_and_labels(tmp_path):
    with pytest.raises(ValueError):
        tpl.path_for("../etc", tmp_path)
    with pytest.raises(ValueError):
        tpl.Templates("x").add("maybe", [np.ones(63)])


def make_matcher(with_rest=True):
    target_shape = normalize(hand_points(shape_seed=1))
    rest_shape = normalize(hand_points(shape_seed=2))
    t = tpl.Templates("g")
    t.add("target", [target_shape + RNG.normal(0, 0.02, 63) for _ in range(5)])
    if with_rest:
        t.add("rest", [rest_shape + RNG.normal(0, 0.02, 63) for _ in range(5)])
    return Matcher.from_templates(t), target_shape, rest_shape


def test_matcher_scores_target_high_and_other_low():
    m, target, rest = make_matcher()
    assert m.score(target) > 0.8
    assert m.score(rest) < 0.2


def test_new_genuine_attempts_pass_the_default_success_threshold():
    m, target, _ = make_matcher()
    attempts = [target + RNG.normal(0, 0.02, 63) for _ in range(50)]
    scores = [m.score(a) for a in attempts]
    assert np.median(scores) >= 0.78


def test_rest_examples_lower_the_score_of_rest_like_hands():
    with_rest, _, rest = make_matcher(with_rest=True)
    without_rest, _, _ = make_matcher(with_rest=False)
    assert with_rest.score(rest) <= without_rest.score(rest)


def test_calibration_floor_and_scale():
    assert calibrate_rejection(np.zeros((1, 63))) == 0.5
    spread = np.array([[0.0] * 63, [1.0] + [0.0] * 62])
    assert calibrate_rejection(spread) == pytest.approx(5.0)  # SCALE x median spread 1.0


def test_calibration_is_capped_by_distance_to_rest():
    target = np.array([[0.0] * 63, [1.0] + [0.0] * 62])  # spread 1.0 -> 5.0 uncapped
    rest = np.array([[3.0] + [0.0] * 62])  # nearest target 2.0 away -> cap 1.6
    assert calibrate_rejection(target, rest) == pytest.approx(1.6)


def test_attempts_from_a_different_take_still_score_well():
    """Two takes of the same gesture, each with near-identical frames inside."""
    base = normalize(hand_points(shape_seed=1))
    take_a = base + RNG.normal(0, 0.03, 63)
    take_b = base + RNG.normal(0, 0.03, 63)
    t = tpl.Templates("g")
    t.add("target", [take_a + RNG.normal(0, 0.003, 63) for _ in range(20)])
    t.add("target", [take_b + RNG.normal(0, 0.003, 63) for _ in range(20)])
    t.add("rest", [normalize(hand_points(shape_seed=2))])
    m = Matcher.from_templates(t)
    live = base + RNG.normal(0, 0.03, 63)  # a third, new attempt
    assert m.score(live) >= 0.7
    assert m.score(normalize(hand_points(shape_seed=2))) < 0.2


def test_matcher_needs_target_examples():
    with pytest.raises(ValueError):
        Matcher.from_templates(tpl.Templates("empty"))


# ---- activities ----------------------------------------------------------
def test_activities_load_with_own_thresholds():
    acts = activities.load_activities()
    assert {"thumbs_up", "raise_hand", "custom_gesture_01"} <= set(acts)
    assert acts["raise_hand"].check_type == "rule"
    assert acts["thumbs_up"].review_threshold < acts["thumbs_up"].success_threshold


def test_current_tasks_overrides():
    tasks = CurrentTasks("thumbs_up")
    tasks.set_override("S1-R", "custom_gesture_01")
    assert tasks.for_seat("S1-L") == "thumbs_up"
    assert tasks.for_seat("S1-R") == "custom_gesture_01"
    tasks.set_override("S1-R", None)
    assert tasks.for_seat("S1-R") == "thumbs_up"
    with pytest.raises(KeyError):
        tasks.set_class_task("juggling")


# ---- stages with fake model results ---------------------------------------
def test_hands_are_assigned_to_seats_and_dead_band_dropped():
    result = mp_hand_result(
        [
            (hand_points((0.2, 0.5)), "Right"),
            (hand_points((0.8, 0.5)), "Left"),
            (hand_points((0.51, 0.5)), "Right"),  # in the dead band
        ]
    )
    by_seat = hands_from_result(result, SeatZones())
    assert set(by_seat) == {"S1-L", "S1-R"}
    assert by_seat["S1-R"][0].handedness == "Left"


def test_faces_keep_largest_per_seat_with_padded_crop():
    rgb = np.zeros((480, 640, 3), np.uint8)
    box = lambda x, y, w, h: NS(bounding_box=NS(origin_x=x, origin_y=y, width=w, height=h))  # noqa: E731
    result = NS(detections=[box(50, 100, 60, 60), box(100, 100, 120, 120), box(450, 80, 100, 100)])
    faces = faces_from_result(result, rgb, SeatZones())
    assert set(faces) == {"S1-L", "S1-R"}
    x0, y0, x1, y1 = faces["S1-L"].box
    assert (x1 - x0, y1 - y0) == (144, 144)  # 120 + 10% padding each side
    assert faces["S1-L"].crop.shape == (144, 144, 3)


def test_gesture_stage_scores_current_task(tmp_path):
    m_target = normalize(hand_points(shape_seed=1))
    t = tpl.Templates("custom_gesture_01")
    t.add("target", [m_target + RNG.normal(0, 0.02, 63) for _ in range(4)])
    tpl.save(t, tmp_path)
    tasks = CurrentTasks("custom_gesture_01")
    stage = GesturesStage(tasks=tasks, zones=SeatZones(), cache=MatcherCache(tmp_path))
    ctx = {"hands": {"S1-L": [Hand(hand_points((0.2, 0.5), shape_seed=1), "Right", "S1-L")]}}
    stage.process(None, ctx)
    assert ctx["match"]["S1-L"].score > 0.8
    assert "nearest target" in ctx["match"]["S1-L"].detail
    # No hand there: an explicit not-observable match (missing evidence), never a 0.0 score.
    assert ctx["match"]["S1-R"].score is None
    assert ctx["match"]["S1-R"].observable is False


def test_gesture_stage_reports_missing_examples(tmp_path):
    stage = GesturesStage(
        tasks=CurrentTasks("custom_gesture_01"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )
    ctx = {"hands": {"S1-L": [Hand(hand_points(), "Right", "S1-L")]}}
    stage.process(None, ctx)
    assert ctx["match"]["S1-L"].score is None
    assert "no examples" in ctx["match"]["S1-L"].reason


def test_gesture_stage_skips_rule_tasks(tmp_path):
    stage = GesturesStage(
        tasks=CurrentTasks("raise_hand"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )
    ctx = {"hands": {"S1-L": [Hand(hand_points(), "Right", "S1-L")]}}
    stage.process(None, ctx)
    assert ctx["match"] == {}


class FakeRecognizer:
    def __init__(self, probs):
        self.probs = np.asarray(probs, dtype=np.float32)

    def predict_emotions(self, crop, logits=False):
        return "x", self.probs


def test_expression_keeps_all_eight_native_classes():
    probs = [0.01, 0.01, 0.02, 0.04, 0.21, 0.61, 0.08, 0.02]
    stage = ExpressionStage(recognizer=FakeRecognizer(probs), zones=SeatZones())
    face = Face((0, 0, 10, 10), np.zeros((10, 10, 3), np.uint8), "S1-L")
    ctx = {"faces": {"S1-L": face}}
    stage.process(Frame(np.zeros((1, 1, 3), np.uint8), time.monotonic(), 1), ctx)
    dist = ctx["expression"]["S1-L"]
    assert tuple(dist) == LABELS
    assert dist["neutral"] == pytest.approx(0.61)
    assert sum(dist.values()) == pytest.approx(1.0, abs=1e-3)


def test_rolling_average_smooths_and_expires():
    avg = RollingAverage(window=2.0)
    avg.add(np.array([1.0, 0.0]), now=0.0)
    avg.add(np.array([0.0, 1.0]), now=1.0)
    assert np.allclose(avg.mean(now=1.0), [0.5, 0.5])
    assert np.allclose(avg.mean(now=2.5), [0.0, 1.0])
    assert avg.mean(now=10.0) is None


# ---- watch output --------------------------------------------------------
def test_watch_format_matches_the_agreed_printout():
    text = format_seat(
        "S1-L",
        "thumbs_up",
        Match("thumbs_up", 0.81),
        {"neutral": 0.61, "happiness": 0.21, "sadness": 0.04, "fear": 0.01},
    )
    assert text == (
        "Seat: S1-L\nTask: thumbs_up\nMatch score: 0.81\nExpression:\n"
        "  neutral: 0.61\n  happiness: 0.21\n  sadness: 0.04"
    )


def test_watch_format_without_hand_or_face():
    text = format_seat("S1-R", "thumbs_up", None, None)
    assert "no hand" in text and "no face" in text


@pytest.mark.hardware
def test_real_models_run_on_a_blank_frame(monkeypatch):
    """Loads the real MediaPipe and HSEmotion models; no camera needed."""
    from vision.stages.s10_hands import HandsStage
    from vision.stages.s20_faces import FacesStage

    frame = Frame(np.zeros((480, 640, 3), np.uint8), time.monotonic(), 1)
    ctx = {}
    HandsStage(zones=SeatZones()).process(frame, ctx)
    FacesStage(zones=SeatZones()).process(frame, ctx)
    ctx["faces"]["S1-L"] = Face((0, 0, 224, 224), np.zeros((224, 224, 3), np.uint8), "S1-L")
    ExpressionStage(zones=SeatZones()).process(frame, ctx)
    assert ctx["hands"] == {}
    assert set(ctx["expression"]["S1-L"]) == set(LABELS)


class FakeCap:
    def read(self):
        return True, np.zeros((480, 640, 3), np.uint8)


class FakeHandDetector:
    def __init__(self, hands):
        self.result = mp_hand_result(hands)

    def recognize(self, image):  # Gesture Recognizer API, as the recorder uses
        return self.result


def test_recorder_collects_poses_without_preview():
    from vision.record import Recorder

    hand = (hand_points((0.5, 0.5)), "Right")
    rec = Recorder(FakeCap(), FakeHandDetector([hand]), False, make_image=lambda rgb: rgb)
    vectors, frames = rec.run(0.35, "test", record=True, fps=10)
    assert frames > 0
    assert 3 <= len(vectors) <= 5  # about 10 per second, not every frame
    assert vectors[0].shape == (63,)


def test_recorder_countdown_collects_nothing():
    from vision.record import Recorder

    hand = (hand_points((0.5, 0.5)), "Right")
    rec = Recorder(FakeCap(), FakeHandDetector([hand]), False, make_image=lambda rgb: rgb)
    vectors, _ = rec.run(0.1, "Get ready")
    assert vectors == []


def test_standard_frame_keeps_the_full_16_9_view():
    from vision.camera import FRAME_HEIGHT, FRAME_WIDTH, standard_frame

    assert (FRAME_WIDTH, FRAME_HEIGHT) == (960, 540)
    wide = np.zeros((720, 1280, 3), np.uint8)
    wide[:, :8] = 255  # a mark at the far left edge
    out = standard_frame(wide)
    assert out.shape == (540, 960, 3)
    assert out[:, :4].min() > 200  # the left edge was kept, not cropped away


def test_standard_frame_crops_a_4_3_camera_instead_of_stretching():
    from vision.camera import standard_frame

    tall = np.zeros((480, 640, 3), np.uint8)
    tall[60:420, :] = 255  # the central 16:9 band is white, top and bottom black
    out = standard_frame(tall)
    assert out.shape == (540, 960, 3)
    assert out.min() == 255  # only the centre band kept: no black bars squeezed in


def test_recorder_keeps_a_hand_in_the_middle_of_the_frame():
    from vision.record import AllHands, pick_hand

    result = mp_hand_result([(hand_points((0.5, 0.5)), "Right")])
    assert pick_hand(hands_from_result(result, AllHands()).get("any", [])) is not None


def test_gesture_match_keeps_the_best_hand_only(tmp_path):
    target = normalize(hand_points(shape_seed=1))
    t = tpl.Templates("custom_gesture_01")
    t.add("target", [target + RNG.normal(0, 0.02, 63) for _ in range(4)])
    tpl.save(t, tmp_path)
    stage = GesturesStage(
        tasks=CurrentTasks("custom_gesture_01"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )
    good = Hand(hand_points((0.2, 0.5), shape_seed=1), "Right", "S1-L")
    other = Hand(hand_points((0.3, 0.5), shape_seed=2), "Right", "S1-L")
    ctx = {"hands": {"S1-L": [other, good]}}
    stage.process(None, ctx)
    assert ctx["match"]["S1-L"].hand is good


def test_thumbs_up_is_built_in_and_needs_no_recording(tmp_path):
    from vision import activities

    assert activities.get("thumbs_up").builtin == "Thumb_Up"
    stage = GesturesStage(
        tasks=CurrentTasks("thumbs_up"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )  # no examples recorded
    hand = Hand(hand_points((0.2, 0.5)), "Right", "S1-L", {"Thumb_Up": 0.88, "None": 0.1})
    other = Hand(hand_points((0.3, 0.5)), "Right", "S1-L", {"Thumb_Up": 0.2})
    ctx = {"hands": {"S1-L": [other, hand]}}
    stage.process(None, ctx)
    match = ctx["match"]["S1-L"]
    assert match.score == pytest.approx(0.88) and match.hand is hand


def test_hands_carry_recogniser_gesture_scores():
    result = mp_hand_result([(hand_points((0.2, 0.5)), "Right")])
    result.gestures = [
        [NS(category_name="Thumb_Up", score=0.9), NS(category_name="None", score=0.1)]
    ]
    hands = hands_from_result(result, SeatZones())
    assert hands["S1-L"][0].gestures == {"Thumb_Up": 0.9, "None": 0.1}


def test_recording_a_built_in_gesture_is_refused():
    from vision.record import main

    with pytest.raises(SystemExit, match="built-in"):
        main(["thumbs_up", "target"])


def test_gesture_stage_says_which_tasks_it_can_score(tmp_path):
    # Hands down, recorded gesture with no examples: Cues cannot judge it at all.
    stage = GesturesStage(
        tasks=CurrentTasks("custom_gesture_01"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )
    ctx = {"hands": {}}
    stage.process(None, ctx)
    assert ctx["scorable"] == {"custom_gesture_01": False}
    # A built-in gesture is scorable whenever the hands stage ran, even with hands down.
    stage = GesturesStage(
        tasks=CurrentTasks("thumbs_up"), zones=SeatZones(), cache=MatcherCache(tmp_path)
    )
    ctx = {"hands": {}}
    stage.process(None, ctx)
    assert ctx["scorable"] == {"thumbs_up": True}
    # The hands stage off (no "hands" in ctx): nothing can be scored.
    ctx = {}
    stage.process(None, ctx)
    assert ctx["scorable"] == {"thumbs_up": False}
