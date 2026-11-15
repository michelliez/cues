"""Continuously connect Supabase SeatState snapshots to the existing pipeline."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from agent.context_enricher import ContextEnricher
from agent.deep_agent import AgentRunResult, CuesDeepAgent
from agent.escalation import (
    DEFAULT_ESCALATION_CONFIG,
    EscalationConfig,
    EscalationDecision,
    evaluate_escalation,
)
from agent.progress import ProgressEvaluator, ProgressState
from agent.progress_history import ProgressHistoryStore
from agent.router import AgentEvaluationRequest, EvaluationRouter
from shared.contracts import Activity, SeatState

log = logging.getLogger(__name__)


class SeatStateSource(Protocol):
    """Read the latest row for each seat; implementations do not make decisions."""

    def fetch(self) -> Sequence[Mapping[str, Any] | SeatState]: ...


class SupabaseSeatStateSource:
    """Poll current SeatState rows through the existing backend Supabase client."""

    FIELDS = (
        "seat_id,session_id,activity_id,status,updated_at,tracking_valid,"
        "task_score,expression_context,session_revision"
    )
    # Migration 20261115000100. Without the column a row's observability follows its score.
    OBSERVABLE_FIELD = ",task_observable"

    def __init__(self, client, station_provider=None) -> None:
        self.client = client
        self.station_provider = station_provider
        self._session_id: str | None = None  # the active session found by the last fetch()
        self._observable_column = True

    def fetch(self) -> Sequence[Mapping[str, Any]]:
        if self.station_provider is None:
            raise RuntimeError("A local station provider is required for live SeatState polling")
        station = self.station_provider()
        if not station:
            return []
        sessions = (
            self.client.table("sessions")
            .select("id,current_activity_id,revision")
            .eq("station_id", station)
            .is_("ended_at", "null")
            .execute()
            .data
            or []
        )
        if len(sessions) != 1:
            self._session_id = None
            return []
        session = sessions[0]
        self._session_id = session["id"]
        seats = (
            self.client.table("seats").select("id").eq("station_id", station).execute().data or []
        )
        ids = {row["id"] for row in seats}
        rows = self._seat_state_rows(session["id"])
        if self.station_provider() != station:
            return []
        return [
            row
            for row in rows
            if row["seat_id"] in ids
            and row.get("session_revision") == session["revision"]
            and row.get("activity_id") == session["current_activity_id"]
        ]

    def _seat_state_rows(self, session_id) -> list:
        fields = self.FIELDS + (self.OBSERVABLE_FIELD if self._observable_column else "")
        try:
            query = self.client.table("seat_state").select(fields).eq("session_id", session_id)
            return query.execute().data or []
        except Exception as exc:
            if not (self._observable_column and "task_observable" in str(exc)):
                raise
            self._observable_column = False  # column not applied yet: read without it
            log.warning("seat_state.task_observable is not in the database yet; apply migration")
            return self._seat_state_rows(session_id)

    def fetch_marks(self) -> dict[tuple[UUID, str], datetime]:
        """The teacher's "Mark as reviewed" marks for the active session (seat id and time)."""
        if self._session_id is None:
            return {}
        rows = (
            self.client.table("seat_review_marks")
            .select("seat_id,marked_at")
            .eq("session_id", self._session_id)
            .execute()
            .data
            or []
        )
        session_id = UUID(str(self._session_id))
        return {
            (session_id, row["seat_id"]): datetime.fromisoformat(
                row["marked_at"].replace("Z", "+00:00")
            )
            for row in rows
        }


@dataclass(frozen=True)
class SeatStateProcessingResult:
    snapshot: SeatState
    progress: ProgressState
    escalation: EscalationDecision
    request: AgentEvaluationRequest | None = None
    agent_result: AgentRunResult | None = None


class SeatStatePipeline:
    """Coordinate existing nodes without adding routing or assessment policy."""

    def __init__(
        self,
        activities: Iterable[Activity],
        agent: CuesDeepAgent,
        history: ProgressHistoryStore,
        *,
        router: EvaluationRouter | None = None,
        progress_window_seconds: float = 4,
        escalation_config: EscalationConfig = DEFAULT_ESCALATION_CONFIG,
        clock: Callable[[], datetime] | None = None,
        publisher=None,
    ) -> None:
        catalog = [Activity.model_validate(item.model_dump()) for item in activities]
        self.activities = {item.id: item for item in catalog}
        if len(self.activities) != len(catalog):
            raise ValueError("activity IDs must be unique")
        self.publisher = publisher
        self._revision_started = {}
        self.agent = agent
        self.history = history
        self.router = router if router is not None else EvaluationRouter()
        self.enricher = ContextEnricher(catalog)
        self.progress_window_seconds = progress_window_seconds
        self.escalation_config = escalation_config
        self.clock = clock if clock is not None else lambda: datetime.now(UTC)
        self._evaluators: dict[tuple[UUID, str, str], ProgressEvaluator] = {}
        self._last_rows: dict[str, str] = {}
        self._diagnostics: dict[str, tuple] = {}
        self._marks_seen: dict[tuple[UUID, str], datetime] = {}
        self._marks_primed = False

    def apply_review_marks(self, marks: Mapping[tuple[UUID, str], datetime]) -> None:
        """Restart stall detection for each child the teacher has just marked reviewed.

        The first call only records the marks that already exist (a restarted worker must
        not treat old marks as new); later marks that are new or newer act once.
        """
        if not self._marks_primed:
            self._marks_seen = dict(marks)
            self._marks_primed = True
            return
        for key, marked_at in marks.items():
            seen = self._marks_seen.get(key)
            if seen is not None and marked_at <= seen:
                continue
            self._marks_seen[key] = marked_at
            self.acknowledge_review(*key, marked_at)

    def acknowledge_review(self, session_id: UUID, seat_id: str, marked_at: datetime) -> None:
        """The teacher checked in with this child: measure a stall from scratch, and let
        a new review open (the review itself was closed by the mark)."""
        self._last_rows.pop(seat_id, None)
        for key, evaluator in self._evaluators.items():
            if key[0] == session_id and key[1] == seat_id:
                evaluator.reset()
                self._revision_started[key] = marked_at
                self.router.reset(session_id=session_id, seat_id=seat_id, activity_id=key[2])

    def process_row(
        self, row: Mapping[str, Any] | SeatState, *, now: datetime | None = None
    ) -> SeatStateProcessingResult | None:
        """Process one changed row; exact unchanged rows are skipped.

        ProgressEvaluator remains authoritative for duplicate timestamps,
        out-of-order/future/stale observations, tracking gaps, and task identity.
        """
        snapshot = row if isinstance(row, SeatState) else SeatState.model_validate(row)
        snapshot = SeatState.model_validate(snapshot.model_dump())
        fingerprint = snapshot.model_dump_json()
        if self._last_rows.get(snapshot.seat_id) == fingerprint:
            return None
        self._last_rows[snapshot.seat_id] = fingerprint
        if snapshot.activity_id is None or snapshot.activity_id not in self.activities:
            raise KeyError(f"unknown activity ID: {snapshot.activity_id!r}")
        activity = self.activities[snapshot.activity_id]
        key = (snapshot.session_id, snapshot.seat_id, snapshot.activity_id)
        evaluator = self._evaluators.get(key)
        if evaluator is None:
            self._revision_started[key] = snapshot.updated_at
            evaluator = self._evaluators[key] = ProgressEvaluator(
                activity, window_seconds=self.progress_window_seconds
            )
        if evaluator.key is not None and evaluator.key[-1] != snapshot.session_revision:
            if evaluator.last is not None and snapshot.updated_at <= evaluator.last:
                return None
            self._revision_started[key] = snapshot.updated_at
            evaluator.reset()
            self.router.reset(
                session_id=snapshot.session_id,
                seat_id=snapshot.seat_id,
                activity_id=snapshot.activity_id,
            )
        previous_timestamp = evaluator.last
        observed_now = now if now is not None else self.clock()
        previous_progress = evaluator.state
        progress = evaluator.update(snapshot, now=observed_now)
        # Record only observations the evaluator accepted as fresh. Its public
        # timestamp is the source of truth, so ignored late/future rows do not
        # become misleading history entries.
        if evaluator.last == snapshot.updated_at and evaluator.last != previous_timestamp:
            self.history.record(snapshot, progress)
            if self.publisher is not None:
                recent = [
                    entry
                    for entry in self.history.get_recent_progress_history(
                        snapshot.session_id, snapshot.seat_id, snapshot.activity_id, limit=10
                    )
                    if entry.observed_at >= self._revision_started[key]
                ]
                try:
                    self.publisher(snapshot, progress, recent)
                except Exception as error:
                    log.error(
                        "Live progress publication failed seat=%s error=%s; check migration 012",
                        snapshot.seat_id,
                        type(error).__name__,
                    )
        escalation = evaluate_escalation(
            progress, snapshot.expression_context, config=self.escalation_config
        )
        request = self.router.route(snapshot, progress, escalation)
        age = (observed_now - snapshot.updated_at).total_seconds()
        gap = (
            (snapshot.updated_at - previous_timestamp).total_seconds() if previous_timestamp else 0
        )
        reason = (
            "stale_observation"
            if age > evaluator.max_gap
            else "future_observation"
            if age < 0
            else "tracking_unavailable"
            if snapshot.tracking_valid is not True
            else "task_not_observable"
            if not snapshot.task_observable and progress.trend != "completed"
            else "completion_latched"
            if progress.trend == "completed"
            else "observation_gap"
            if gap > evaluator.max_gap
            else "insufficient_window"
            if progress.trend == "unknown"
            else "valid_window"
        )
        diagnostic = (
            key,
            snapshot.session_revision,
            snapshot.status,
            snapshot.tracking_valid,
            progress.trend,
            escalation.reason,
            reason,
        )
        if self._diagnostics.get(snapshot.seat_id) != diagnostic:
            self._diagnostics[snapshot.seat_id] = diagnostic
            log.info(
                "seat=%s session=%s activity=%s revision=%s tracking=%s score=%s "
                "vision_status=%s progress=%s->%s stalled=%.2fs age=%.2fs gap=%.2fs "
                "escalation=%s route=%s reason=%s",
                snapshot.seat_id,
                snapshot.session_id,
                snapshot.activity_id,
                snapshot.session_revision,
                snapshot.tracking_valid,
                snapshot.task_score,
                snapshot.status,
                previous_progress.trend,
                progress.trend,
                progress.stalled_seconds,
                age,
                gap,
                escalation.reason or "none",
                "evaluate" if request else "none",
                reason,
            )
        if request is None:
            return SeatStateProcessingResult(snapshot, progress, escalation)
        context = self.enricher.enrich(request)
        log.info(
            "Agent evaluation started seat=%s priority=%s", snapshot.seat_id, escalation.priority
        )
        agent_result = self.agent.run(context)
        log.info(
            "Agent evaluation finished seat=%s decision=%s pending_review=%s",
            snapshot.seat_id,
            getattr(agent_result.assessment, "decision", "unavailable"),
            agent_result.pending_review.id if agent_result.pending_review else "none",
        )
        return SeatStateProcessingResult(snapshot, progress, escalation, request, agent_result)


class SeatStateRuntime:
    """Polling lifecycle with per-row isolation and bounded retry cadence."""

    def __init__(
        self,
        source: SeatStateSource,
        pipeline: SeatStatePipeline,
        *,
        poll_seconds: float = 1.0,
    ) -> None:
        if poll_seconds <= 0:
            raise ValueError("poll_seconds must be positive")
        self.source = source
        self.pipeline = pipeline
        self.poll_seconds = poll_seconds
        self.monotonic = time.monotonic

    def run_once(self) -> list[SeatStateProcessingResult]:
        rows = self.source.fetch()
        fetch_marks = getattr(self.source, "fetch_marks", None)
        if fetch_marks is not None:
            try:
                self.pipeline.apply_review_marks(fetch_marks())
                self._marks_failing = False
            except Exception as error:
                # For example migration 1500 is not applied yet: keep working, say so once.
                if not getattr(self, "_marks_failing", False):
                    log.error(
                        "Review marks unavailable (%s); apply migration 1500", type(error).__name__
                    )
                self._marks_failing = True
        results = []
        for row in rows:
            try:
                result = self.pipeline.process_row(row)
                if result is not None:
                    results.append(result)
            except Exception as error:
                seat = row.seat_id if isinstance(row, SeatState) else row.get("seat_id", "unknown")
                log.error("SeatState processing failed for seat %s: %s", seat, type(error).__name__)
        return results

    def run_forever(self, stop: threading.Event | None = None) -> None:
        stop = stop if stop is not None else threading.Event()
        while not stop.is_set():
            started = self.monotonic()
            try:
                self.run_once()
            except Exception as error:
                log.error("SeatState source read failed: %s", type(error).__name__)
            # Poll at a fixed rate: Supabase reads take 0.5-1s, and waiting the full
            # period after them would skip vision's 1 Hz rows and reset stall timing.
            stop.wait(max(0.0, self.poll_seconds - (self.monotonic() - started)))


def local_station():
    """Read this laptop's authoritative vision assignment; unavailable means pause."""
    import json
    from urllib.request import urlopen

    try:
        with urlopen("http://127.0.0.1:8000/config", timeout=2) as response:
            station = json.load(response).get("station_id")
        if isinstance(station, str) and station:
            return station
    except Exception:
        pass
    return None
