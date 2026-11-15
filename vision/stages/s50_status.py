"""Task status and events: the vision service's output to the rest of Cues.

On each frame this stage:
1. Reads each seat's match score, and whether a hand and a face are visible,
   from ctx (written by the earlier stages).
2. Feeds them to that seat's SeatTracker (vision/status.py), which returns
   status changes and events. A new tracker starts whenever the seat's task
   changes.
3. Feeds the smoothed expression distribution to that seat's ExpressionTracker.
4. Turns the results into shared contract objects (shared.contracts.Event and
   SeatState) and sends them through the emitter: local JSONL by default,
   Supabase when `vision.supabase_events` is on and keys are set.
5. Keeps the last few events in ctx["events"] so vision.watch can print them.

Seat state is the primary output: Michelle's progress pipeline reads it. It is
sent when the status or tracking changes and otherwise once per second, with
tracking_valid (person seen in this frame) and the expression's persistence.
Events are informational (audit/debug); vision makes no review or agent
decision.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from vision import activities
from vision.activities import TASKS
from vision.grouping import GROUPING
from vision.session_sync import frame_activity
from vision.status import ExpressionTracker, SeatTracker, StatusEvent

FLAG = "vision.task_status"
SEAT_STATE_INTERVAL = 1.0
RECENT_EVENTS = 20

log = logging.getLogger(__name__)


def observed_at(frame_timestamp: float) -> datetime:
    """Wall-clock time (UTC) at which this frame was captured.

    Frame timestamps are time.monotonic() values. Converting them keeps the
    observation time in SeatState.updated_at and Event.created_at, instead of
    the later time the row happens to be sent.
    """
    return datetime.now(UTC) - timedelta(seconds=max(time.monotonic() - frame_timestamp, 0.0))


def format_event(seat_id: str, activity_id: str, event: StatusEvent) -> str:
    """One-line summary, e.g. `EVENT attempt_miss S1-L thumbs_up score=0.31`."""
    parts = [f"EVENT {event.type}", seat_id, activity_id]
    if event.score is not None:
        parts.append(f"score={event.score:.2f}")
    if event.payload:
        parts.append(" ".join(f"{k}={v}" for k, v in event.payload.items()))
    return " ".join(parts)


class StatusStage:
    name = "status"
    rate_hz = None

    def __init__(self, emitter=None, tasks=TASKS, zones=GROUPING, station=None, marks=None) -> None:
        from vision import station as station_module
        from vision.review_marks import MARKS

        self.station = station or station_module.STATION
        self.marks = marks or MARKS
        self._station_generation = self.station.generation
        self.tasks = tasks
        self.zones = zones
        self._emitter = emitter
        self._trackers: dict[str, SeatTracker] = {}
        self._expression: dict[str, ExpressionTracker] = {}
        # seat -> ((status, tracking_valid), time sent)
        self._last_state: dict[str, tuple[tuple[str, bool], float]] = {}
        self._session_key = None
        # Time of the last frame processed, and whether frames since then were paused.
        self._last_processed_t: float | None = None
        self._paused = False
        self.recent: deque[str] = deque(maxlen=RECENT_EVENTS)
        self._last_event: dict[str, tuple[str, float]] = {}  # seat -> (event type, time)

    @property
    def emitter(self):
        if self._emitter is None:
            from vision.events import emitter_from_env

            self._emitter = emitter_from_env()
        return self._emitter

    def _reset(self) -> None:
        self._trackers.clear()
        self._expression.clear()
        self._last_state.clear()
        self._last_event.clear()
        self.recent.clear()

    def process(self, frame, ctx) -> None:
        # One station per frame: the one PeopleStage used for this frame's ids.
        if "station_generation" in ctx:
            station_id, generation = ctx["station_id"], ctx["station_generation"]
        else:
            station_id, generation = self.station.snapshot()
        if generation != self._station_generation:
            # New station: no score, status, expression or session carries over.
            self._reset()
            self._session_key = None
            self._station_generation = generation
        if station_id is None:
            ctx.update(status={}, events=[], last_event={})
            return  # no teacher station yet: nothing is written
        session = ctx.get("session") if ctx.get("session_managed") else None
        if session is not None and session.station_id != station_id:
            session = None
        if ctx.get("session_managed"):
            if session is None:
                # Paused (sync lapsed, session ended, no activity): write nothing, but keep
                # each person's status. A brief sync gap must not send a flagged or finished
                # child back to working; a new session or revision still resets.
                self._paused = True
                self._drop_released(ctx)  # a released id must not pass its status on
                ctx.update(status={}, events=[], last_event={})
                return
            key = (session.id, session.revision)
            if key != self._session_key:
                self._reset()
                self._session_key = key
            elif self._paused and self._last_processed_t is not None:
                # Same session after a pause: the paused time was not observed.
                gap = frame.timestamp - self._last_processed_t
                for tracker in self._trackers.values():
                    tracker.shift(gap)
                for expression in self._expression.values():
                    expression.shift(gap)
            self._paused = False
            self._last_processed_t = frame.timestamp
        self.emitter.station_id = station_id
        prefix = f"{station_id}-"
        session_id = session.id if session else self.emitter.session_id
        session_revision = session.revision if session else None
        t = frame.timestamp
        matches = ctx.get("match", {})
        hands = ctx.get("hands", {})
        faces = ctx.get("faces", {})
        expressions = ctx.get("expression", {})
        for seat in self.zones.ids(ctx):
            if not seat.startswith(prefix):
                continue  # an id from another station's tracker; never written
            activity_id = frame_activity(self.tasks, seat, ctx)
            if activity_id is None:
                continue
            activity = activities.get(activity_id)
            tracker = self._trackers.get(seat)
            marked = self.marks.get(session_id, seat)
            if tracker is None or tracker.activity.id != activity.id:
                tracker = self._trackers[seat] = SeatTracker(seat, activity)
                tracker.acknowledged_at = marked  # a mark from before this tracker is old news
            elif marked is not None and (
                tracker.acknowledged_at is None or marked > tracker.acknowledged_at
            ):
                # The teacher marked this child reviewed: back to working, timers restart.
                tracker.acknowledge(marked)
            match = matches.get(seat)
            score = match.score if match is not None and match.activity_id == activity.id else None
            visible = seat in faces or seat in ctx.get("people", {})
            in_hand = seat in hands
            # A gesture task counts toward no progress only if Cues can score it (gestures
            # and hands on, examples recorded); rule tasks always can.
            judgeable = activity.check_type != "gesture" or ctx.get("scorable", {}).get(
                activity.id, False
            )
            events = tracker.update(t, score, in_hand, visible, judgeable=judgeable)
            expr_tracker = self._expression.setdefault(seat, ExpressionTracker())
            events += expr_tracker.update(t, expressions.get(seat))
            when = observed_at(t)
            for event in events:
                self._send_event(seat, activity.id, event, when, session_id, session_revision)
                self._last_event[seat] = (event.type, t)
            # Tracked now = the person, their face or their hand is seen in this frame.
            tracking_valid = (visible or in_hand) and tracker.status != "tracking_lost"
            expression = expr_tracker.context(t, expressions.get(seat))
            self._maybe_send_state(
                seat,
                tracker,
                score,
                expression,
                tracking_valid,
                t,
                when,
                session_id,
                session_revision,
            )
        self._drop_released(ctx)
        ctx["status"] = {seat: tr.status for seat, tr in self._trackers.items()}
        ctx["events"] = list(self.recent)
        ctx["last_event"] = {s: e for s, (e, when) in self._last_event.items() if t - when < 3.0}

    def _drop_released(self, ctx) -> None:
        live = set(self.zones.ids(ctx))
        for gone in [s for s in self._trackers if s not in live]:  # released person ids
            self._trackers.pop(gone, None)
            self._expression.pop(gone, None)
            self._last_state.pop(gone, None)
            self._last_event.pop(gone, None)

    def _send_event(
        self,
        seat: str,
        activity_id: str,
        event: StatusEvent,
        when: datetime,
        session_id=None,
        session_revision=None,
    ) -> None:
        from shared.contracts import Event

        line = format_event(seat, activity_id, event)
        self.recent.append(line)
        log.info(line)
        self.emitter.emit(
            Event(
                session_id=session_id if session_id is not None else self.emitter.session_id,
                station_id=self.emitter.station_id,
                seat_id=seat,
                type=event.type,
                activity_id=activity_id,
                score=event.score,
                payload={
                    **(event.payload or {"source": "auto"}),
                    **(
                        {"session_revision": session_revision}
                        if session_revision is not None
                        else {}
                    ),
                },
                created_at=when,
            )
        )

    def _maybe_send_state(
        self,
        seat,
        tracker: SeatTracker,
        score,
        expression,
        tracking_valid,
        t,
        when,
        session_id=None,
        session_revision=None,
    ) -> None:
        """Send SeatState on a status or tracking change, else once per SEAT_STATE_INTERVAL."""
        from shared.contracts import ExpressionContext, SeatState

        key = (tracker.status, tracking_valid)
        last = self._last_state.get(seat)
        if last is not None and last[0] == key and t - last[1] < SEAT_STATE_INTERVAL:
            return
        self._last_state[seat] = (key, t)
        self.emitter.update_seat_state(
            SeatState(
                seat_id=seat,
                session_id=session_id if session_id is not None else self.emitter.session_id,
                status=tracker.status,
                updated_at=when,
                activity_id=tracker.activity.id,
                tracking_valid=tracking_valid,
                session_revision=session_revision,
                task_score=score if tracking_valid else None,
                # Judged only when tracked AND this task had evidence for this person: a score
                # of 0.0 is a failure, None is missing evidence (never written as 0.0).
                task_observable=score is not None and bool(tracking_valid),
                expression_context=ExpressionContext(**expression) if expression else None,
            )
        )

    def draw(self, image, ctx) -> None:
        """Status is shown on the dashboard and in vision.watch, not on the video."""

    def close(self) -> None:
        if self._emitter is not None:
            self._emitter.close()


def create_stage() -> StatusStage:
    return StatusStage()
