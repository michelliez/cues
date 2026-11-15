import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from shared.contracts import (
    Activity,
    Alert,
    AlertStatus,
    Event,
    EventType,
    ExpressionContext,
    SeatState,
    SeatStatus,
)

FIXTURES = Path(__file__).parents[1] / "fixtures"


def rows(name):
    return json.loads((FIXTURES / name).read_text())


@pytest.mark.parametrize(
    ("name", "model"),
    [
        ("activities.json", Activity),
        ("events.json", Event),
        ("seat_states.json", SeatState),
        ("alerts.json", Alert),
    ],
)
def test_fixtures_validate_and_round_trip(name, model):
    for row in rows(name):
        instance = model.model_validate(row)
        assert model.model_validate_json(instance.model_dump_json()) == instance


def test_fixtures_cover_shared_states_and_consistent_references():
    events = [Event.model_validate(row) for row in rows("events.json")]
    seats = [SeatState.model_validate(row) for row in rows("seat_states.json")]
    alerts = [Alert.model_validate(row) for row in rows("alerts.json")]
    activity_ids = {row["id"] for row in rows("activities.json")}
    assert {event.type for event in events} == set(EventType)
    assert len(EventType) == 12
    assert {seat.status for seat in seats} == set(SeatStatus)
    assert {alert.status for alert in alerts} == set(AlertStatus)
    assert len({item.session_id for item in [*events, *seats]}) == 1
    assert {item.activity_id for item in [*events, *seats]} - {None} <= activity_ids
    assert {item.seat_id for item in [*events, *alerts]} <= {seat.seat_id for seat in seats}
    assert [event.type for event in events[1:4]] == [EventType.ATTEMPT_MISS] * 3


@pytest.mark.parametrize(
    "change",
    [
        {"session_id": "demo"},
        {"station_id": " "},
        {"type": "emotion_detected"},
        {"score": -0.1},
        {"score": 1.1},
        {"score": float("nan")},
        {"score": float("inf")},
        {"created_at": "2026-11-14T02:00:00"},
        {"camera_frame": "unexpected"},
        {"payload": {"not_json": object()}},
    ],
)
def test_invalid_events_are_rejected(change):
    with pytest.raises(ValidationError):
        Event.model_validate(rows("events.json")[0] | change)


@pytest.mark.parametrize("field", ["session_id", "station_id", "created_at"])
def test_event_requires_complete_envelope(field):
    data = rows("events.json")[0]
    del data[field]
    with pytest.raises(ValidationError):
        Event.model_validate(data)


@pytest.mark.parametrize("field", ["session_id", "updated_at", "status"])
def test_seat_state_requires_complete_snapshot(field):
    data = rows("seat_states.json")[0]
    del data[field]
    with pytest.raises(ValidationError):
        SeatState.model_validate(data)


def test_expression_snapshot_and_sustained_event_have_different_duration_requirements():
    context = {"label": "neutral", "probability": 0.74}
    assert ExpressionContext.model_validate(context).duration_seconds is None
    event = rows("events.json")[0] | {"type": "expression_context", "payload": context}
    with pytest.raises(ValidationError, match="duration_seconds"):
        Event.model_validate(event)
    event["payload"] = context | {"duration_seconds": 6}
    assert Event.model_validate(event).payload["duration_seconds"] == 6


def test_managed_session_expression_event_keeps_its_session_revision():
    # Regression: vision tags every managed-session payload with session_revision (the
    # database guard reads it), and that made every expression_context event invalid.
    payload = {"label": "sadness", "probability": 0.7, "duration_seconds": 6}
    event = rows("events.json")[0] | {
        "type": "expression_context",
        "payload": payload | {"session_revision": 2},
    }
    assert Event.model_validate(event).payload["session_revision"] == 2
    event["payload"] = payload | {"session_revision": 2, "dominant_label": "neutral"}
    with pytest.raises(ValidationError):
        Event.model_validate(event)
    for bad in ("2", -1, {"n": 2}):
        event["payload"] = payload | {"session_revision": bad}
        with pytest.raises(ValidationError):
            Event.model_validate(event)


@pytest.mark.parametrize(
    "change",
    [
        {"label": "distressed"},
        {"probability": 1.2},
        {"duration_seconds": -1},
        {"supporting_only": False},
        {"dominant_label": "neutral"},
    ],
)
def test_expression_constraints_apply_to_nested_context_and_event_payload(change):
    context = {"label": "neutral", "probability": 0.74, "duration_seconds": 6} | change
    with pytest.raises(ValidationError):
        SeatState.model_validate(rows("seat_states.json")[0] | {"expression_context": context})
    with pytest.raises(ValidationError):
        Event.model_validate(
            rows("events.json")[0] | {"type": "expression_context", "payload": context}
        )


@pytest.mark.parametrize(
    "change",
    [
        {"success_threshold": None},
        {"review_threshold": 0.9},
        {"success_threshold": float("inf")},
        {"no_progress_seconds": 0},
        {"check_type": "object_detector"},
        {"activity_id": "duplicate_id"},
    ],
)
def test_activity_calibration_is_validated(change):
    with pytest.raises(ValidationError):
        Activity.model_validate(rows("activities.json")[1] | change)


@pytest.mark.parametrize(
    "change",
    [
        {"id": "abc123"},
        {"status": "applied"},
        {"priority": "urgent"},
        {"resolved_at": "2026-11-14T02:04:00"},
    ],
)
def test_alert_contract_rejects_invalid_values(change):
    with pytest.raises(ValidationError):
        Alert.model_validate(rows("alerts.json")[0] | change)


def test_metadata_defaults_are_not_shared_between_instances():
    data = rows("events.json")[0]
    del data["payload"]
    first = Event.model_validate(data)
    second = Event.model_validate(data)
    first.payload["source"] = "auto"
    assert second.payload == {}
