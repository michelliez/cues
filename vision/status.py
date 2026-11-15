"""Task status for one seat: turns scores over time into statuses and events.

The SeatTracker gets one update per frame: the time, the seat's match score for
its current task, and whether a hand and a face are visible. It returns the
events that the update caused. It never decides to alert the teacher; the rules
engine does that from these events.

Statuses (shared.contracts.SeatStatus):
    idle          -> no hand or face seen yet for this task
    in_progress   -> the child is visible and working on the task
    review        -> the score stayed in the review band; the teacher should check
    done          -> the score stayed at or above the success threshold
    needs_help    -> no score reached the review band within no_progress_seconds
    tracking_lost -> no hand and no face for TRACKING_LOST_SECONDS

Rules, in the order they are checked on each update:
1. Tracking loss. No hand and no face for TRACKING_LOST_SECONDS sets
   tracking_lost and emits `tracking_lost` once. While tracking is lost the
   no-progress timer pauses and no misses are counted, so a camera problem
   never counts as a student failure.
2. Success. A score >= success_threshold held for SUCCESS_HOLD_SECONDS sets
   done and emits `attempt_success`. done stays until the task changes.
3. Review. A score in [review_threshold, success_threshold) held for
   REVIEW_HOLD_SECONDS sets review and emits `review_needed` once per task.
4. Miss. While a hand is visible, a score below review_threshold held for
   MISS_HOLD_SECONDS emits `attempt_miss`. Only one miss is counted per
   continuous stretch of the hand being in view (one "attempt"); the hand must
   leave and come back for the next miss. This stops a resting hand from
   producing a stream of misses.
5. No progress. If no score has reached review_threshold after
   no_progress_seconds of active (not tracking-lost) time, sets needs_help and
   emits `no_progress` once.

A score of None (task not observable: no recorded examples yet, no hand found, a wrist out
of frame) means "cannot judge": it counts toward nothing. A score of 0.0 is a judged failure.

Separately, ExpressionTracker emits `expression_context` when anger, fear or
sadness stays at or above EXPRESSION_MIN_PROBABILITY for EXPRESSION_MIN_SECONDS.
That event is supporting context only; it never changes the task status.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from vision import flags
from vision.activities import Activity

TRACKING_LOST_SECONDS = 3.0
SUCCESS_HOLD_SECONDS = 1.0
REVIEW_HOLD_SECONDS = 2.0
# After the teacher's Mark as reviewed, a child is flagged for no progress again only
# after at least this long (or the task's own wait, if longer).
REFLAG_AFTER_REVIEW_SECONDS = 15.0
MISS_HOLD_SECONDS = 1.0
MAX_STEP_SECONDS = 0.5  # cap on time credited per update, so a stall does not jump timers

NEGATIVE_LABELS = ("anger", "fear", "sadness")
EXPRESSION_MIN_PROBABILITY = 0.5
EXPRESSION_MIN_SECONDS = 5.0


@dataclass
class StatusEvent:
    """An event the tracker produced, before it becomes a shared contract Event."""

    type: str
    score: float | None = None
    payload: dict[str, Any] = field(default_factory=dict)


class SeatTracker:
    def __init__(self, seat_id: str, activity: Activity) -> None:
        self.seat_id = seat_id
        self.activity = activity
        self.status = "idle"
        self._status_before_loss: str | None = None
        self.active_seconds = 0.0  # time on task, excluding tracking loss
        # Time the task could be judged and was not done: only frames with a score (the task
        # was observable for this person). Missing evidence (no hand found, wrist out of
        # frame, no recogniser result, no recorded examples, gestures off) is not the child's
        # failure and does not count, even when the task is scorable in general.
        self.judged_seconds = 0.0
        # The wait before needs_help. Longer after the teacher's Mark as reviewed, so the
        # child they just checked in with is not flagged again within seconds.
        self._no_progress_wait = activity.no_progress_seconds
        # vision.flag_on_time_on_task: flag after the wait of plain time on task (tracking
        # loss excluded), whether or not Cues could judge each frame, so a child is never
        # left on "working" because their hand could not be scored. Off: judged time only.
        self._time_on_task = flags.enabled("vision.flag_on_time_on_task")
        # Time on a task Cues can watch at all (judgeable), score or not. A stage that is
        # off or a recorded gesture with no examples never counts, flag on or off.
        self.watchable_seconds = 0.0
        self.best_score: float | None = None
        self._last_t: float | None = None
        self._unseen_since: float | None = None
        self._band: str | None = None  # "success", "review" or "low"
        self._band_since: float | None = None
        self._band_best: float = 0.0
        self._review_sent = False
        self._no_progress_sent = False
        self._hand_in_view = False
        self._miss_counted = False
        # When the teacher last marked this child reviewed (only newer marks act).
        self.acknowledged_at = None

    def acknowledge(self, marked_at=None) -> bool:
        """The teacher checked in with this child ("Mark as reviewed").

        The child goes back to working and the timers start again: time on task, the
        no-progress timer and the review timer, so a new needs_help or review_needed
        comes only after a fresh stall. A completed task stays completed.
        Returns True when the child was reset.
        """
        self.acknowledged_at = marked_at
        if self.status == "done":
            return False
        if self.status == "tracking_lost":
            self._status_before_loss = None  # back in view they continue as working
        else:
            self.status = "in_progress"
        self.active_seconds = 0.0
        self.judged_seconds = 0.0
        self.watchable_seconds = 0.0
        self._no_progress_wait = max(self.activity.no_progress_seconds, REFLAG_AFTER_REVIEW_SECONDS)
        self.best_score = None
        self._review_sent = False
        self._no_progress_sent = False
        self._reset_band()
        return True

    def update(
        self, t: float, score: float | None, hand: bool, face: bool, judgeable: bool = True
    ) -> list[StatusEvent]:
        """`score` is None when this person's task is not observable right now; that time
        counts toward nothing. `judgeable` is False when Cues cannot score this task at all
        (a recorded gesture with no usable examples, or the gestures or hands stage off)."""
        events: list[StatusEvent] = []
        if self._last_t is not None and t - self._last_t > MAX_STEP_SECONDS:
            # A stall (no frames for a while): that time was not observed, so it must not
            # complete a hold or the tracking-loss timer.
            self.shift(t - self._last_t - MAX_STEP_SECONDS)
        dt = 0.0 if self._last_t is None else min(max(t - self._last_t, 0.0), MAX_STEP_SECONDS)
        self._last_t = t

        # 1. Tracking loss.
        if not hand and not face:
            if self._unseen_since is None:
                self._unseen_since = t
            if t - self._unseen_since >= TRACKING_LOST_SECONDS and self.status != "tracking_lost":
                if self.status != "done":
                    self._status_before_loss = self.status
                    self.status = "tracking_lost"
                    events.append(StatusEvent("tracking_lost"))
            self._reset_band()
            self._hand_in_view = False
            return events
        self._unseen_since = None
        if self.status == "tracking_lost":
            # Back in view: keep what was already known (needs_help, review).
            before = self._status_before_loss
            self.status = before if before in ("needs_help", "review") else "in_progress"
            self._status_before_loss = None
        elif self.status == "idle":
            self.status = "in_progress"
        if self.status == "done":
            return events
        self.active_seconds += dt
        if judgeable:
            self.watchable_seconds += dt
        if judgeable and score is not None:
            self.judged_seconds += dt

        # Track one "attempt" per continuous stretch of the hand being in view.
        if hand and not self._hand_in_view:
            self._miss_counted = False
        self._hand_in_view = hand

        if score is not None:
            self.best_score = score if self.best_score is None else max(self.best_score, score)
            band = self._band_for(score)
            if band != self._band:
                self._band, self._band_since, self._band_best = band, t, score
            else:
                self._band_best = max(self._band_best, score)
            held = t - self._band_since

            # 2. Success.
            if band == "success" and held >= SUCCESS_HOLD_SECONDS:
                self.status = "done"
                events.append(StatusEvent("attempt_success", round(self._band_best, 3)))
                return events
            # 3. Review.
            if band == "review" and held >= REVIEW_HOLD_SECONDS and not self._review_sent:
                self._review_sent = True
                self.status = "review"
                events.append(StatusEvent("review_needed", round(self._band_best, 3)))
            # 4. Miss.
            if band == "low" and hand and held >= MISS_HOLD_SECONDS and not self._miss_counted:
                self._miss_counted = True
                events.append(StatusEvent("attempt_miss", round(score, 3)))
        else:
            self._reset_band()

        # 5. No progress.
        reached_review = self.best_score is not None and (
            self.best_score >= self.activity.review_threshold
        )
        if self._time_on_task:
            # Not done and not already flagged after the wait: needs review, whatever the
            # score did (a brief near-match does not hold the child on "working").
            stalled = (
                self.status == "in_progress" and self.watchable_seconds >= self._no_progress_wait
            )
        else:
            stalled = not reached_review and self.judged_seconds >= self._no_progress_wait
        if not self._no_progress_sent and stalled:
            self._no_progress_sent = True
            self.status = "needs_help"
            events.append(StatusEvent("no_progress", self.best_score))
        return events

    def shift(self, seconds: float) -> None:
        """Skip a pause: move every hold and timer forward, so time nobody observed
        neither completes a hold (done, review, miss, tracking lost) nor counts as time
        on task. Statuses are kept."""
        if seconds <= 0:
            return
        if self._last_t is not None:
            self._last_t += seconds
        if self._unseen_since is not None:
            self._unseen_since += seconds
        if self._band_since is not None:
            self._band_since += seconds

    def _band_for(self, score: float) -> str:
        if score >= self.activity.success_threshold:
            return "success"
        if score >= self.activity.review_threshold:
            return "review"
        return "low"

    def _reset_band(self) -> None:
        self._band = None
        self._band_since = None
        self._band_best = 0.0


class ExpressionTracker:
    """Emits one expression_context event per sustained negative-expression episode."""

    def __init__(
        self,
        min_probability: float = EXPRESSION_MIN_PROBABILITY,
        min_seconds: float = EXPRESSION_MIN_SECONDS,
    ) -> None:
        self.min_probability = min_probability
        self.min_seconds = min_seconds
        self._label: str | None = None  # sustained negative label, if any
        self._since: float | None = None
        self._sent = False
        self._last_t: float | None = None

    def update(self, t: float, distribution: dict[str, float] | None) -> list[StatusEvent]:
        if self._last_t is not None and t - self._last_t > MAX_STEP_SECONDS:
            self.shift(t - self._last_t - MAX_STEP_SECONDS)  # a stall is not persistence
        self._last_t = t
        label = None
        if distribution:
            candidates = [
                (distribution.get(lbl, 0.0), lbl)
                for lbl in NEGATIVE_LABELS
                if distribution.get(lbl, 0.0) >= self.min_probability
            ]
            if candidates:
                label = max(candidates)[1]
        if label != self._label:
            self._label, self._since, self._sent = label, t, False
        if label is None or self._sent or t - self._since < self.min_seconds:
            return []
        self._sent = True
        return [
            StatusEvent(
                "expression_context",
                payload={
                    "label": label,
                    "probability": round(float(distribution[label]), 3),
                    "duration_seconds": round(t - self._since, 1),
                    "supporting_only": True,
                },
            )
        ]

    def shift(self, seconds: float) -> None:
        """Skip a pause: an expression must persist for min_seconds of observed time."""
        if seconds <= 0:
            return
        if self._since is not None:
            self._since += seconds
        if self._last_t is not None:
            self._last_t += seconds

    def context(self, t: float, distribution: dict[str, float] | None) -> dict | None:
        """Expression context for SeatState, or None when nothing qualifies.

        Call after update() with the same t and distribution. Context qualifies
        only when anger, fear or sadness has stayed at or above min_probability
        for at least min_seconds (the same rule as the escalation logic). It
        then reports that label, its current probability and how long it has
        persisted. Otherwise (neutral, happiness, a short or weak negative
        signal, or no face) it is None: no live expression is published.
        """
        if not distribution or self._label is None:
            return None
        duration = t - self._since
        if duration < self.min_seconds:
            return None
        return {
            "label": self._label,
            "probability": round(float(distribution[self._label]), 3),
            "duration_seconds": round(duration, 1),
            "supporting_only": True,
        }
