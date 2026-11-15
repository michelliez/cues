"""Shapes of the per-seat perception results that stages share through ctx.

Stages write these into the pipeline's shared ctx dict:

    ctx["hands"]      -> dict[seat_id, list[Hand]]
    ctx["faces"]      -> dict[seat_id, Face]
    ctx["match"]      -> dict[seat_id, Match]
    ctx["expression"] -> dict[seat_id, dict[label, probability]]   (smoothed)

A seat with nothing detected is simply missing from the dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Hand:
    landmarks: np.ndarray  # (21, 3) MediaPipe normalised x, y, z
    handedness: str  # "Left" or "Right", as MediaPipe reports it
    seat_id: str
    # MediaPipe Gesture Recognizer scores for this hand, e.g. {"Thumb_Up": 0.91,
    # "Open_Palm": 0.02, ...}. Empty when hands come from the plain landmarker.
    gestures: dict[str, float] = field(default_factory=dict)

    @property
    def wrist(self) -> tuple[float, float]:
        return float(self.landmarks[0, 0]), float(self.landmarks[0, 1])


@dataclass
class Face:
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in pixels
    crop: np.ndarray  # RGB face crop (with padding) for the expression model
    seat_id: str


@dataclass
class Match:
    activity_id: str
    score: float | None  # 0..1, None when the task has no recorded examples yet
    reason: str = ""  # why score is None, for display
    detail: str = ""  # raw distances, shown by `vision.watch --debug`
    hand: Hand | None = None  # the one hand this score is for (one hand per person)
    # Task-specific observability: does Cues have enough evidence for THIS task to judge this
    # person right now? Not the same as tracking: a person can be tracked and still not
    # judgeable (wrist out of frame, no hand found). Not observable means score is None
    # (missing evidence, never a failure); observable means score is a number, and a low
    # number is a real, countable failure. Left None it follows the score.
    observable: bool | None = None
    # Why, for diagnostics only (never shown to teachers): "observable_wrong",
    # "missing_pose_landmarks", "no_owned_hand", "no_recogniser_evidence", "no_examples",
    # "hand_unreadable", "person_not_visible"; "" when the task is simply judged.
    reason_code: str = ""

    def __post_init__(self) -> None:
        if self.observable is None:
            self.observable = self.score is not None
        elif self.observable and self.score is None:
            raise ValueError("an observable match needs a score")
        elif not self.observable:
            self.score = None  # missing evidence is never a number
