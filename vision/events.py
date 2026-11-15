"""Event emitter.

The vision service reports what happens at each seat as structured events
(PRD §17.1) and keeps the live `seat_state` row for each seat up to date.

* `emit(event)` and `update_seat_state(state)` validate shared contracts and queue
  writes. A background thread does the network work, so a slow connection never
  stalls the camera.
* With `vision.supabase_events` enabled and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
  set (root .env), events go
  to the Supabase `events` table and seat state to `seat_state`.
* Without them, or if a Supabase write fails, the same rows are appended to
  vision/logs/events.jsonl (appended) and vision/logs/seat_state.json (latest row
  per seat).

Try it from the repo root:

    uv run python -m vision.events --demo
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from shared.contracts import Event, SeatState

log = logging.getLogger(__name__)

LOG_DIR = Path(__file__).parent / "logs"


class Sink(Protocol):
    def write_event(self, row: dict[str, Any]) -> None: ...
    def write_seat_state(self, row: dict[str, Any]) -> None: ...


class JsonlSink:
    """Local files, used offline and as the fallback. They stay on this laptop.

    * Events are appended to events.jsonl (an audit log, like the events table).
    * Seat state keeps only the LATEST row per seat_id in seat_state.json, like
      the Supabase upsert. Appending would build a per-second history of each
      child's live expression, which the product rules forbid.
    """

    def __init__(self, directory: Path = LOG_DIR) -> None:
        self.directory = directory
        self._latest: dict[str, dict[str, Any]] = {}

    def _append(self, name: str, row: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        with open(self.directory / name, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def write_event(self, row: dict[str, Any]) -> None:
        self._append("events.jsonl", row)

    def write_seat_state(self, row: dict[str, Any]) -> None:
        self._latest[str(row["seat_id"])] = row
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / "seat_state.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._latest, indent=1))
        tmp.replace(path)


class SupabaseSink:
    def __init__(self, client) -> None:
        self.client = client
        # Migration 20261115000100 adds seat_state.task_observable. Until it is applied the
        # write falls back to the old columns (the score already says "not judged": None).
        self._observable_column = True

    def write_event(self, row: dict[str, Any]) -> None:
        self.client.table("events").insert(row).execute()

    def write_seat_state(self, row: dict[str, Any]) -> None:
        """Upsert the complete SeatState row, including tracking_valid."""
        # Legacy mode must still work before lifecycle migration 005 exists.
        payload = dict(row)
        if payload.get("session_revision") is None:
            payload.pop("session_revision", None)
        if not self._observable_column:
            payload.pop("task_observable", None)
        try:
            self.client.table("seat_state").upsert(payload, on_conflict="seat_id").execute()
        except Exception as exc:
            if not (self._observable_column and "task_observable" in str(exc)):
                raise
            self._observable_column = False
            log.warning("seat_state.task_observable is not in the database yet; apply migration")
            payload.pop("task_observable", None)
            self.client.table("seat_state").upsert(payload, on_conflict="seat_id").execute()


class Emitter:
    """Queues shared events/snapshots and writes them on a background thread.

    session_id and station_id are producer defaults, not injected into models.
    Producers include them explicitly when constructing complete shared contracts.
    """

    def __init__(
        self,
        sink: Sink,
        fallback: Sink | None = None,
        session_id: uuid.UUID | str | None = None,
        station_id: str = "S1",
    ) -> None:
        self.sink = sink
        self.fallback = fallback
        self.session_id = uuid.UUID(str(session_id)) if session_id is not None else uuid.uuid4()
        self.station_id = station_id
        self._queue: queue.Queue[tuple[str, dict[str, Any]] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._loop, name="emitter", daemon=True)
        self._thread.start()

    def emit(self, event: Event) -> None:
        """Queue a complete shared event without mutating the producer's model."""
        validated = Event.model_validate(event.model_dump())
        self._queue.put(("event", validated.model_dump(mode="json")))

    def update_seat_state(self, state: SeatState) -> None:
        """Queue a complete shared snapshot, including explicit nulls to clear stale state."""
        validated = SeatState.model_validate(state.model_dump())
        self._queue.put(("seat_state", validated.model_dump(mode="json")))

    def flush(self, timeout: float = 5.0) -> None:
        """Wait until everything queued so far has been written (for tests and shutdown)."""
        done = threading.Event()
        self._queue.put(("flush", {"done": done}))
        done.wait(timeout)

    def close(self) -> None:
        self.flush()
        self._queue.put(None)
        self._thread.join(timeout=2)

    def _loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            kind, row = item
            if kind == "flush":
                row["done"].set()
                continue
            self._write(kind, row)

    def _write(self, kind: str, row: dict[str, Any]) -> None:
        method = "write_event" if kind == "event" else "write_seat_state"
        try:
            getattr(self.sink, method)(row)
        except Exception as exc:
            log.warning("%s write failed (%s); using fallback", kind, exc)
            if self.fallback is not None:
                try:
                    getattr(self.fallback, method)(row)
                except Exception:
                    log.exception("fallback write failed")


def _current_station() -> str:
    """The service creates its emitter only once a station is set. The one-off
    `python -m vision.events --demo` check falls back to S1 (or CUES_STATION_ID)."""
    from vision.station import LEGACY_STATION, STATION

    return STATION.get() or LEGACY_STATION


def emitter_from_env() -> Emitter:
    """Supabase when the `vision.supabase_events` flag is on and keys are set;
    otherwise local JSONL. JSONL is always the fallback.

    The station is vision.station.STATION (the dashboard's station, or the
    CUES_STATION_ID dev override). CUES_SESSION_ID is required
    when writing to Supabase: a random id would put this run's rows under a
    session the dashboard is not showing. Offline (JSONL only) a new id is used.
    """
    from vision import flags
    from vision.supabase_client import get_client

    local = JsonlSink()
    client = get_client() if flags.enabled("vision.supabase_events") else None
    session_id = os.environ.get("CUES_SESSION_ID")
    if client is not None and not session_id and not flags.enabled("vision.session_lifecycle"):
        raise RuntimeError(
            "vision.supabase_events is on but CUES_SESSION_ID is not set. Put the dashboard's "
            "sessions row id in .env (CUES_SESSION_ID=...), or turn the flag off."
        )
    sink: Sink = SupabaseSink(client) if client is not None else local
    emitter = Emitter(
        sink,
        fallback=local if client is not None else None,
        session_id=session_id or str(uuid.uuid4()),
        # StatusStage sets the dashboard's station before anything is written.
        station_id=_current_station(),
    )
    where = "Supabase" if client is not None else f"{LOG_DIR} (local only)"
    log.info("events go to %s, session %s", where, emitter.session_id)
    return emitter


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Send a demo event to check the setup.")
    parser.add_argument("--demo", action="store_true", help="send one fake attempt_success")
    args = parser.parse_args(argv)
    if not args.demo:
        parser.print_help()
        return
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    emitter = emitter_from_env()
    try:
        emitter.emit(
            Event(
                session_id=emitter.session_id,
                station_id=emitter.station_id,
                type="attempt_success",
                seat_id=f"{emitter.station_id}-L",
                activity_id="raise_hand",
                score=1.0,
                payload={"source": "auto"},
                created_at=datetime.now(UTC),
            )
        )
        emitter.update_seat_state(
            SeatState(
                session_id=emitter.session_id,
                seat_id=f"{emitter.station_id}-L",
                status="done",
                activity_id="raise_hand",
                task_score=1.0,
                updated_at=datetime.now(UTC),
            )
        )
    finally:
        emitter.close()
    print(f"Sent a demo attempt_success for {emitter.station_id}-L.")


if __name__ == "__main__":
    main()
