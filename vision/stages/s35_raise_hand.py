"""Raise-hand rule: a 0-1 confidence that each person has raised a hand.

The hand must also be an open palm facing the camera
(vision.gestures.hand_pose.open_palm_facing); a visible hand that is not scores 0.

Missing evidence is not failure. When the shoulders or wrists are too faint for MediaPipe
to judge, or the palm gate has no hand to look at, the match is not observable and its
score is None. A wrist that can be seen and is not raised, or a raised hand that is not an
open palm, is an observable failure: a low number that may count toward a stall.

The score comes from the person's pose points (see raise_confidence). The
status logic then requires the score to stay above the activity's thresholds,
which acts as the hold time. The person's single displayed hand is their
highest MediaPipe hand (image y grows downward, so the smallest wrist y).
"""

from __future__ import annotations

from vision import activities
from vision.activities import TASKS
from vision.gestures.hand_pose import open_palm_check
from vision.grouping import GROUPING
from vision.perception import Match
from vision.session_sync import frame_activity

FLAG = "vision.raise_hand"
ACTIVITY_ID = "raise_hand"
# A wrist this many shoulder widths above the shoulder line scores 1.0. With
# true (aspect-corrected) proportions, 1.0 is about the top of the head.
FULL_RAISE_SHOULDER_WIDTHS = 1.0
# Wrist and shoulders must be at least this visible to MediaPipe to count.
MIN_VISIBILITY = 0.5


def assess_raise(person) -> tuple[float | None, str, str]:
    """(score, explanation, reason_code) for how clearly a person's hand is raised.

    score is None when the pose cannot judge it (see below); otherwise 0 to 1.

    Uses the person's MediaPipe pose points:
    * height: how far the higher wrist is above the shoulder line, measured in
      shoulder widths so it works near and far. Level with the shoulders gives
      0; FULL_RAISE_SHOULDER_WIDTHS above (about the top of the head) gives 1.
    * visibility is a gate, not a multiplier: a wrist whose (or shoulders
      whose) MediaPipe visibility is below MIN_VISIBILITY does not count.
      Multiplying by visibility pulled clearly raised hands below the success
      threshold, because raised wrists often read 0.6-0.9.
    Returns (confidence, explanation).
    """
    from vision.people import LEFT_SHOULDER, LEFT_WRIST, RIGHT_SHOULDER, RIGHT_WRIST

    _, lsy, lsv = person.point(LEFT_SHOULDER)
    _, rsy, rsv = person.point(RIGHT_SHOULDER)
    shoulder_y = (lsy + rsy) / 2
    width = max(person.shoulder_width, 1e-3)
    best, detail = 0.0, "no wrist above the shoulders"
    judged = False  # at least one wrist (with both shoulders) was visible enough to judge
    for wrist in (LEFT_WRIST, RIGHT_WRIST):
        _, wy, wv = person.point(wrist)
        height = (shoulder_y - wy) / width  # image y grows downward
        geometry = min(max(height / FULL_RAISE_SHOULDER_WIDTHS, 0.0), 1.0)
        visibility = min(wv, lsv, rsv)
        if visibility < MIN_VISIBILITY:
            continue
        judged = True
        confidence = round(geometry, 3)
        if confidence > best:
            best = confidence
            detail = (
                f"wrist {height:.1f} shoulder widths above shoulders, visibility {visibility:.2f}"
            )
    if not judged:
        return None, "shoulders or wrists too faint to judge", "missing_pose_landmarks"
    return best, detail, "" if best > 0 else "observable_wrong"


def raise_confidence(person) -> tuple[float, str]:
    """How clearly a person's hand is raised, from 0 to 1, for display (the recognise stage).

    Unlike assess_raise, a pose that cannot be judged reads 0 here: the label only needs a
    number, and nothing here is scored as a task result.
    """
    score, detail = assess_raise(person)[:2]
    return (0.0 if score is None else score), detail


def highest_hand(hands):
    """The hand whose wrist is highest in the image, or None."""
    return min(hands, key=lambda h: h.wrist[1]) if hands else None


class RaiseHandStage:
    name = "raise_hand"
    rate_hz = None  # every frame, so the hold time is measured accurately

    def __init__(self, tasks=TASKS, zones=GROUPING) -> None:
        self.tasks = tasks
        self.zones = zones

    def process(self, frame, ctx) -> None:
        hands = ctx.get("hands", {})
        matches = ctx.setdefault("match", {})
        for pid in self.zones.ids(ctx):
            if frame_activity(self.tasks, pid, ctx) != ACTIVITY_ID:
                if getattr(matches.get(pid), "activity_id", None) == ACTIVITY_ID:
                    del matches[pid]  # task changed: drop the old raise-hand result
                continue
            person = ctx.get("people", {}).get(pid)
            if person is None:
                matches[pid] = Match(
                    ACTIVITY_ID, None, "person not visible", reason_code="person_not_visible"
                )
                continue
            score, detail, code = assess_raise(person)
            hand = highest_hand(hands.get(pid, []))
            if score is None:
                matches[pid] = Match(
                    ACTIVITY_ID, None, "cannot judge", detail=detail, hand=hand, reason_code=code
                )
                continue
            # A raised hand only counts as an open palm facing the camera, so a
            # raised fist or thumbs-up never completes raise_hand. If the palm cannot be
            # told (no hand found, or seen edge-on) there is nothing to judge it on:
            # missing evidence, not a failure. Only a hand that is clearly not an open palm
            # facing the camera scores 0.
            if score > 0:
                palm = open_palm_check(hand)
                if palm is None:
                    matches[pid] = Match(
                        ACTIVITY_ID,
                        None,
                        "cannot tell the palm",
                        detail=f"{detail}; palm evidence unavailable",
                        hand=hand,
                        reason_code="no_owned_hand" if hand is None else "palm_indeterminate",
                    )
                    continue
                if not palm:
                    score, detail, code = (
                        0.0,
                        f"{detail}; palm not open toward the camera",
                        "observable_wrong",
                    )
            matches[pid] = Match(ACTIVITY_ID, score, detail=detail, hand=hand, reason_code=code)

    def draw(self, image, ctx) -> None:
        """Drawn by s90_overlay."""


def create_stage() -> RaiseHandStage:
    activities.get(ACTIVITY_ID)  # fail fast if the activity is missing from activities.json
    return RaiseHandStage()
