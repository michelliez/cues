"""Gesture matching: a match score per seat for that seat's current gesture task.

Reads ctx["hands"] and writes ctx["match"] = {seat_id: Match}. Examples are
re-read when their file changes, so a gesture recorded while the service runs
is used within a second.
"""

from __future__ import annotations

import cv2

from vision import activities
from vision.activities import TASKS
from vision.gestures import templates as tpl
from vision.gestures.matcher import Matcher
from vision.gestures.normalize import normalize
from vision.grouping import GROUPING
from vision.people import person_color as seat_color
from vision.perception import Match
from vision.session_sync import frame_activity

FLAG = "vision.gestures"


class MatcherCache:
    """Loads a Matcher per activity and reloads it when its template file changes."""

    def __init__(self, directory=None) -> None:
        self.directory = directory
        self._cache: dict[str, tuple[float, Matcher | None, str]] = {}

    def get(self, activity_id: str) -> tuple[Matcher | None, str]:
        path = tpl.path_for(activity_id, self.directory)
        mtime = path.stat().st_mtime if path.exists() else -1.0
        cached = self._cache.get(activity_id)
        if cached and cached[0] == mtime:
            return cached[1], cached[2]
        templates = tpl.load(activity_id, self.directory)
        if templates.stale:
            reason = (
                "examples are out of date: re-record "
                f"(python -m vision.record {activity_id} target)"
            )
            self._cache[activity_id] = (mtime, None, reason)
            return None, reason
        try:
            matcher, reason = Matcher.from_templates(templates), ""
        except ValueError:
            matcher = None
            reason = f"no examples recorded (python -m vision.record {activity_id} target)"
        self._cache[activity_id] = (mtime, matcher, reason)
        return matcher, reason


def score_gesture(activity, hands, cache: MatcherCache, exclude_palm: bool = False):
    """Best (score, hand, reason, detail) for one gesture activity over a person's hands.

    * Built-in gestures (activity.builtin, e.g. "Thumb_Up"): the MediaPipe
      Gesture Recognizer's score for that label. No recorded examples needed.
    * Recorded gestures: nearest-neighbour match against the teacher's
      examples. With exclude_palm, hands whose palm faces the camera are
      skipped (used by recognise mode).
    score is None when it cannot be judged (no hand, no recogniser evidence, or no
    examples). A hand that is there and clearly not the gesture scores a low number.
    """
    if not hands:
        return None, None, "no hand detected", ""
    if activity.builtin:
        if not any(h.gestures for h in hands):
            # Landmarks only: the recogniser said nothing, so this gesture can't be judged.
            return None, hands[0], "no recogniser result", ""
        score, hand = max(
            ((h.gestures.get(activity.builtin, 0.0), h) for h in hands), key=lambda x: x[0]
        )
        return round(float(score), 3), hand, "", f"{activity.builtin} {score:.2f} (recogniser)"
    matcher, reason = cache.get(activity.id)
    if matcher is None:
        return None, None, reason, ""
    if exclude_palm:
        from vision.gestures.hand_pose import palm_side

        hands = [h for h in hands if palm_side(h.landmarks, h.handedness) != "palm"]
        if not hands:
            return 0.0, None, "", "palm facing the camera"
    scored = []
    for h in hands:
        try:
            v = normalize(h.landmarks, h.handedness)
        except ValueError:  # degenerate landmarks: skip this hand, keep scoring others
            continue
        scored.append((matcher.score(v), v, h))
    if not scored:
        return None, None, "hand unreadable", ""
    score, best, hand = max(scored, key=lambda item: item[0])  # one hand per person
    d_target, d_rest = matcher.distances(best)
    detail = (
        f"nearest target {d_target:.2f}, nearest rest {d_rest:.2f}, "
        f"score reaches 0 at {matcher.rejection_threshold:.2f}"
    )
    return score, hand, "", detail


class GesturesStage:
    name = "gestures"
    rate_hz = None

    def __init__(self, tasks=TASKS, zones=GROUPING, cache: MatcherCache | None = None) -> None:
        self.tasks = tasks
        self.zones = zones
        self.cache = cache or MatcherCache()

    def process(self, frame, ctx) -> None:
        # Cleared first, so a frame that fails part-way never leaves a task "scorable".
        ctx["scorable"] = {}
        hands = ctx.get("hands", {})
        hands_on = "hands" in ctx  # the hands stage ran (vision.hands on)
        result: dict[str, Match] = {}
        # Per gesture task: can Cues score it at all this frame? Built-in gestures need the
        # hands stage; recorded ones also need usable examples. The status stage counts
        # no-progress time only for tasks it can score, so "can't tell" is never a failure.
        scorable: dict[str, bool] = {}
        for seat in self.zones.ids(ctx):
            activity_id = frame_activity(self.tasks, seat, ctx)
            if activity_id is None:  # session paused or ended: no task to score
                continue
            activity = activities.get(activity_id)
            if activity.check_type != "gesture":
                continue
            if activity_id not in scorable:
                scorable[activity_id] = hands_on and (
                    activity.builtin is not None or self.cache.get(activity_id)[0] is not None
                )
            if seat not in hands:
                # No hand owned by this person: nothing to judge, so missing evidence.
                result[seat] = Match(
                    activity_id,
                    None,
                    "no hand detected",
                    reason_code="no_owned_hand",
                )
                continue
            score, hand, reason, detail = score_gesture(activity, hands[seat], self.cache)
            if score is None:
                code = (
                    "no_recogniser_evidence"
                    if reason == "no recogniser result"
                    else "hand_unreadable"
                    if reason == "hand unreadable"
                    else "no_examples"
                )
            else:
                code = "observable_wrong" if score < activity.review_threshold else ""
            result[seat] = Match(
                activity_id, score, reason, detail=detail, hand=hand, reason_code=code
            )
        ctx["match"] = result
        ctx["scorable"] = scorable

    def draw(self, image, ctx) -> None:
        from vision import overlay

        if not overlay.debug():
            return
        h, w = image.shape[:2]
        for seat, match in ctx.get("match", {}).items():
            anchor = self.zones.anchor(seat, ctx, w, h, row=2)
            if anchor is None:
                continue
            score = "--" if match.score is None else f"{match.score:.2f}"
            text = f"{match.activity_id}: {score}"
            cv2.putText(image, text, anchor, cv2.FONT_HERSHEY_SIMPLEX, 0.6, seat_color(seat), 2)


def create_stage() -> GesturesStage:
    return GesturesStage()
