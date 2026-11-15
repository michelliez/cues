"""Deterministic progress state only; no routing, expression, or service calls."""

from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from statistics import mean
from typing import Literal
from uuid import UUID

from shared.contracts import Activity, SeatState

# Pass explicitly for accelerated demos; the evaluator default stays four seconds.
DEMO_PROGRESS_WINDOW_SECONDS = 2
# Vision rewrites seat_state about once a second. A poll that is a little slower than
# that sees two rows 2.06s apart; one missed heartbeat is not a tracking gap, two are.
MAX_OBSERVATION_GAP_SECONDS = 3


@dataclass(frozen=True)
class ProgressState:
    trend: Literal["improving", "stalled", "completed", "unknown"]
    stalled_seconds: float = 0


class ProgressEvaluator:
    """Evaluate one seat/task stream. Call reset() when restarting the same task.

    updated_at must describe a fresh task observation, not an unrelated app update.
    Scores are compared only within the configured activity. Rule-based tasks use
    explicit done status; gesture tasks can also use Activity.success_threshold.

    Evidence, for every task type: tracking invalid, or the task not observable
    (task_score None: Cues could not judge this person), is "unknown", never a failure,
    and clears the window. Only an observable low score (a number, even 0.0) can build
    toward "stalled".
    """

    def __init__(
        self,
        activity: Activity,
        window_seconds: float = 4,
        min_increase: float = 0.10,
        max_gap_seconds: float = MAX_OBSERVATION_GAP_SECONDS,
    ) -> None:
        if any(not isfinite(v) or v <= 0 for v in (window_seconds, max_gap_seconds, min_increase)):
            raise ValueError("configuration must be finite and positive")
        self.activity = activity.model_copy(deep=True)
        self.window = window_seconds
        self.increase = min_increase
        self.max_gap = max_gap_seconds
        self.reset()

    def reset(self) -> None:
        self.key: tuple[UUID, str, str | None, int | None] | None = None
        self.last: datetime | None = None
        self.started: datetime | None = None
        self.samples: list[tuple[datetime, float | None]] = []
        self.state = ProgressState("unknown")

    def _clear_window(self) -> None:
        self.samples.clear()
        self.started = None
        self.state = ProgressState("unknown")

    def update(self, snapshot: SeatState, *, now: datetime) -> ProgressState:
        """Consume a snapshot; elapsed time is measured using its aware timestamp.

        Duplicate/out-of-order and future observations do not change state. Stale
        observations invalidate the window. Completion is latched until reset or
        a new session/seat/activity. No agent decision is made here.
        """
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("now must be timezone-aware")
        snapshot = SeatState.model_validate(snapshot.model_dump())
        if snapshot.updated_at > now:
            return self.state
        key = (
            snapshot.session_id,
            snapshot.seat_id,
            snapshot.activity_id,
            snapshot.session_revision,
        )
        if key != self.key:
            self.reset()
            self.key = key
        if self.last is not None and snapshot.updated_at <= self.last:
            if (now - self.last).total_seconds() > self.max_gap:
                self._clear_window()
            return self.state
        previous = self.last
        self.last = snapshot.updated_at
        if snapshot.activity_id != self.activity.id:
            self._clear_window()
            return self.state
        if self.state.trend == "completed":
            return self.state
        if (now - snapshot.updated_at).total_seconds() > self.max_gap:
            self._clear_window()
            return self.state
        valid = snapshot.tracking_valid is True and snapshot.status not in ("idle", "tracking_lost")
        reached_threshold = (
            valid
            and self.activity.check_type == "gesture"
            and snapshot.task_score is not None
            and snapshot.task_score >= self.activity.success_threshold
        )
        if snapshot.status == "done" or reached_threshold:
            self._clear_window()
            self.state = ProgressState("completed")
            return self.state
        if not valid:
            self._clear_window()
            return self.state
        if previous is not None and (self.last - previous).total_seconds() > self.max_gap:
            self._clear_window()
        if not snapshot.task_observable:
            # Tracked, but nothing to judge on this task: missing evidence, not failure.
            self._clear_window()
            return self.state
        if self.started is None:
            self.started = self.last
        # Keep one observation per half-second time bucket to bound memory and
        # prevent high frame-rate bursts from dominating the window averages.
        bucket = int(self.last.timestamp() * 2)
        if self.samples and int(self.samples[-1][0].timestamp() * 2) == bucket:
            self.samples[-1] = (self.last, snapshot.task_score)
        else:
            self.samples.append((self.last, snapshot.task_score))
        # Retain one boundary observation for irregular sampling, but never use
        # samples older than the rolling window in the score comparison.
        while (
            len(self.samples) > 1
            and (self.last - self.samples[1][0]).total_seconds() >= self.window
        ):
            self.samples.pop(0)
        if (self.last - self.samples[0][0]).total_seconds() < self.window:
            self.state = ProgressState("unknown")
            return self.state
        improving = False
        if self.activity.check_type == "gesture":
            early = [
                s
                for t, s in self.samples
                if s is not None
                and self.window / 2 < (self.last - t).total_seconds() <= self.window
            ]
            late = [
                s
                for t, s in self.samples
                if s is not None and (self.last - t).total_seconds() <= self.window / 2
            ]
            if not early or not late:
                self.state = ProgressState("unknown")
                return self.state
            # Enter at the configured increase; exit below half that increase.
            threshold = self.increase / 2 if self.state.trend == "improving" else self.increase
            improving = mean(late) - mean(early) >= threshold
        if improving:
            self.started = self.last
            self.state = ProgressState("improving")
        else:
            self.state = ProgressState("stalled", (self.last - self.started).total_seconds())
        return self.state
