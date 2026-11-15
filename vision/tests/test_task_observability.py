"""Task observability: missing evidence (score None) is not a failure (score 0.0).

A tracked person can still be unjudgeable on the task (wrist out of frame, no hand found).
Only a judged, clearly wrong attempt is a low number.
"""

import numpy as np

from vision.activities import CurrentTasks
from vision.camera import Frame
from vision.people import LEFT_WRIST, RIGHT_WRIST, PeopleGrouping, Person
from vision.perception import Hand, Match
from vision.stages.s30_gestures import GesturesStage
from vision.stages.s35_raise_hand import RaiseHandStage, assess_raise
from vision.tests.hands import PERSONS_RIGHT, open_palm
from vision.tests.test_people import people_ctx, pose

IMG = np.zeros((480, 640, 3), np.uint8)


def raise_match(lm, hands=None):
    ctx, _ = people_ctx(lm)
    pid = next(iter(ctx["people"]))
    ctx["hands"] = {pid: hands} if hands else {}
    RaiseHandStage(tasks=CurrentTasks("raise_hand"), zones=PeopleGrouping()).process(
        Frame(IMG, 0.0, 1), ctx
    )
    return ctx["match"][pid], pid


def palm_hand(pid, gestures):
    return Hand(open_palm(0.2, 0.25), PERSONS_RIGHT, pid, gestures)


# ---- raise_hand ------------------------------------------------------------
def test_raise_hand_visible_wrist_not_raised_is_an_observable_failure():
    match, _ = raise_match(pose(0.5))  # both wrists down, fully visible
    assert match.observable is True
    assert match.score == 0.0  # a real, countable 0.0
    assert match.reason_code == "observable_wrong"


def test_raise_hand_faint_shoulders_or_wrists_cannot_be_judged():
    lm = pose(0.5, wrist_up=True)
    lm[[LEFT_WRIST, RIGHT_WRIST], 3] = 0.3  # the person is tracked; only the wrists are faint
    match, _ = raise_match(lm)
    assert match.observable is False
    assert match.score is None  # missing evidence, not 0.0
    assert match.reason_code == "missing_pose_landmarks"
    # The display-only helper is untouched: it still needs a number.
    assert assess_raise(Person("S1-P1", (0, 0, 1, 1), pose(0.5, vis=0.4)))[0] is None


def test_raise_hand_raised_wrist_with_no_hand_to_check_the_palm_is_missing_evidence():
    match, _ = raise_match(pose(0.5, wrist_up=True))  # pose is clear; no hand found
    assert match.observable is False and match.score is None
    assert match.reason_code == "no_owned_hand"


def test_raise_hand_raised_but_not_an_open_palm_is_an_observable_failure():
    ctx, _ = people_ctx(pose(0.5, wrist_up=True))
    pid = next(iter(ctx["people"]))
    fist = palm_hand(pid, {"Open_Palm": 0.1, "Closed_Fist": 0.8})
    ctx["hands"] = {pid: [fist]}
    RaiseHandStage(tasks=CurrentTasks("raise_hand"), zones=PeopleGrouping()).process(
        Frame(IMG, 0.0, 1), ctx
    )
    match = ctx["match"][pid]
    assert match.observable is True and match.score == 0.0
    assert match.reason_code == "observable_wrong"


def test_raise_hand_raised_open_palm_still_completes():
    ctx, _ = people_ctx(pose(0.5, wrist_up=True))
    pid = next(iter(ctx["people"]))
    ctx["hands"] = {pid: [palm_hand(pid, {"Open_Palm": 0.95})]}
    RaiseHandStage(tasks=CurrentTasks("raise_hand"), zones=PeopleGrouping()).process(
        Frame(IMG, 0.0, 1), ctx
    )
    match = ctx["match"][pid]
    assert match.observable is True and match.score > 0.9


# ---- open_palm -------------------------------------------------------------
def palm_ctx(hands):
    ctx, _ = people_ctx(pose(0.5))
    pid = next(iter(ctx["people"]))
    ctx["hands"] = {pid: hands(pid)} if hands else {}
    GesturesStage(tasks=CurrentTasks("open_palm"), zones=PeopleGrouping()).process(
        Frame(IMG, 0.0, 1), ctx
    )
    return ctx["match"][pid]


def test_open_palm_owned_hand_that_is_not_an_open_palm_is_an_observable_failure():
    match = palm_ctx(lambda pid: [palm_hand(pid, {"Closed_Fist": 0.9})])
    assert match.observable is True
    assert match.score == 0.0  # judged wrong, countable
    assert match.reason_code == "observable_wrong"


def test_open_palm_no_owned_hand_cannot_be_judged():
    match = palm_ctx(None)
    assert match.observable is False and match.score is None
    assert match.reason_code == "no_owned_hand"


def test_open_palm_hand_without_recogniser_evidence_cannot_be_judged():
    match = palm_ctx(lambda pid: [palm_hand(pid, {})])  # landmarks only
    assert match.observable is False and match.score is None
    assert match.reason_code == "no_recogniser_evidence"


def test_open_palm_correct_gesture_scores_high():
    match = palm_ctx(lambda pid: [palm_hand(pid, {"Open_Palm": 0.93})])
    assert match.observable is True and match.score >= 0.7


# ---- the invariant ---------------------------------------------------------
def test_match_observability_follows_the_score_and_never_hides_a_zero():
    assert Match("raise_hand", 0.0).observable is True  # 0.0 is judged, not missing
    assert Match("raise_hand", None).observable is False
    unjudged = Match("raise_hand", 0.5, observable=False)  # missing evidence wins
    assert unjudged.score is None
