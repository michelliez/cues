"""Canonical Python contracts for data exchanged between Cues components.

These models validate data, not routing or intervention policy. JSON fixtures
and documentation examples must conform to these definitions.
"""

from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    TypeAdapter,
    model_validator,
)

Identifier = Annotated[str, Field(min_length=1, pattern=r"\S")]
UnitScore = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
SessionRevision = Annotated[int, Field(ge=0, strict=True)]
_REVISION = TypeAdapter(SessionRevision)
Duration = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class EventType(StrEnum):
    ATTEMPT_SUCCESS = "attempt_success"
    ATTEMPT_MISS = "attempt_miss"
    REVIEW_NEEDED = "review_needed"
    NO_PROGRESS = "no_progress"
    TRACKING_LOST = "tracking_lost"
    EXPRESSION_CONTEXT = "expression_context"
    TEACHER_VERIFIED = "teacher_verified"
    AGENT_INVOKED = "agent_invoked"
    ALERT_CREATED = "alert_created"
    TEACHER_APPROVED = "teacher_approved"
    TEACHER_DISMISSED = "teacher_dismissed"
    INTERVENTION_APPLIED = "intervention_applied"


class SeatStatus(StrEnum):
    IDLE = "idle"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    NEEDS_HELP = "needs_help"
    TRACKING_LOST = "tracking_lost"


class AlertStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DISMISSED = "dismissed"


class CheckType(StrEnum):
    RULE = "rule"
    GESTURE = "gesture"


class AlertPriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ExpressionLabel(StrEnum):
    ANGER = "anger"
    CONTEMPT = "contempt"
    DISGUST = "disgust"
    FEAR = "fear"
    HAPPINESS = "happiness"
    NEUTRAL = "neutral"
    SADNESS = "sadness"
    SURPRISE = "surprise"


# The approved intervention menu (PRD 12, 13). The agent may suggest ONE of these on a review
# request and nothing else; the teacher approves before anything is recorded. The same keys are
# in supabase/migrations/20261114001800_interventions.sql and web/lib/interventions.ts (a test
# keeps all three equal). Wording describes what an adult does, never a child's state.
INTERVENTION_MENU: dict[str, str] = {
    "repeat_instruction": "Repeat the instruction",
    "show_example": "Show an example",
    "model_task": "Model the task",
    "smaller_steps": "Break it into smaller steps",
    "offer_break": "Offer a short break",
    "adult_check_in": "Check in with the student",
}
InterventionKey = Literal[
    "repeat_instruction",
    "show_example",
    "model_task",
    "smaller_steps",
    "offer_break",
    "adult_check_in",
]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ExpressionContext(_Contract):
    """Supporting model output, never a diagnosis or standalone failure signal."""

    label: ExpressionLabel
    probability: UnitScore
    duration_seconds: Duration | None = None
    supporting_only: Literal[True] = True


class Event(_Contract):
    """Complete exchanged event; producers supply IDs and an aware timestamp."""

    session_id: UUID
    station_id: Identifier
    seat_id: Identifier
    type: EventType
    created_at: AwareDatetime
    activity_id: Identifier | None = None
    score: UnitScore | None = None
    payload: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_expression_payload(self) -> Self:
        if self.type == EventType.EXPRESSION_CONTEXT:
            # Vision adds session_revision to every managed-session payload (the database's
            # stale-write guard reads it); it is not part of the expression context itself.
            payload = dict(self.payload)
            revision = payload.pop("session_revision", None)
            if revision is not None:
                _REVISION.validate_python(revision)
            context = ExpressionContext.model_validate(payload)
            if context.duration_seconds is None:
                raise ValueError("expression_context events require duration_seconds")
        return self


class SeatState(_Contract):
    """Complete seat snapshot, not a partial database update."""

    seat_id: Identifier
    session_id: UUID
    status: SeatStatus
    updated_at: AwareDatetime
    activity_id: Identifier | None = None
    tracking_valid: bool | None = None
    session_revision: SessionRevision | None = None
    task_score: UnitScore | None = None
    expression_context: ExpressionContext | None = None


class Activity(_Contract):
    id: Identifier
    name: Identifier
    check_type: CheckType
    no_progress_seconds: Annotated[int, Field(gt=0)]
    success_threshold: UnitScore | None = None
    review_threshold: UnitScore | None = None

    @model_validator(mode="after")
    def validate_thresholds(self) -> Self:
        if self.check_type == CheckType.GESTURE and self.success_threshold is None:
            raise ValueError("gesture activities require success_threshold")
        if self.review_threshold is not None:
            if self.success_threshold is None:
                raise ValueError("review_threshold requires success_threshold")
            if self.review_threshold > self.success_threshold:
                raise ValueError("review_threshold cannot exceed success_threshold")
        return self


class Alert(_Contract):
    id: UUID
    seat_id: Identifier
    reason: Identifier
    priority: AlertPriority
    suggestion: Identifier
    created_at: AwareDatetime
    evidence: dict[str, JsonValue] = Field(default_factory=dict)
    status: AlertStatus = AlertStatus.PENDING
    resolved_at: AwareDatetime | None = None


class Session(_Contract):
    """Authoritative teacher-managed station session; no perception data."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    id: UUID
    station_id: Identifier
    current_activity_id: Identifier | None
    started_at: AwareDatetime
    ended_at: AwareDatetime | None
    revision: Annotated[int, Field(ge=0, strict=True)]


class TeacherFlagDecision(_Contract):
    """A teacher's recorded camera-flag answer; never a fabricated agent review."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)

    id: UUID
    session_id: UUID
    seat_id: Identifier
    activity_id: Identifier
    session_revision: SessionRevision
    observed_at: AwareDatetime
    decision: Literal["confirmed", "dismissed"]
    decided_at: AwareDatetime
    teacher_id: UUID
