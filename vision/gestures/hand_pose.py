"""Which side of a hand faces the camera, and whether the hand is open.

Both come from the 21 MediaPipe hand landmarks; no extra model.

Palm or back (palm_side):
    Take two vectors from the wrist: to the index-finger knuckle (point 5) and
    to the little-finger knuckle (point 17). The sign of their 2-D cross
    product says which way the hand turns from index to little finger, and so
    which side faces the camera, once you know if it is a left or right hand.
    The sign does not change when the hand tilts in the image, so a tilted
    raised hand or thumbs-up still reads correctly. When the hand is seen
    edge-on (the two vectors nearly in line) the result is "side".

    Checked on the station camera: MediaPipe's "Right" label is the person's
    right hand in the picture vision passes it. (An earlier version assumed
    the opposite, which swapped palm and back.) If palm and back come out
    swapped on a different camera, for example one that mirrors its own
    output, set CUES_PALM_FLIP=1.

Open hand (is_open):
    A finger is extended when its tip is clearly further from the wrist than
    its knuckle (ratio >= EXTENDED_RATIO). The hand is open when at least
    MIN_EXTENDED of the four fingers (index to little) are extended. The thumb
    is not counted.
"""

from __future__ import annotations

import os

import numpy as np

from vision.camera import ASPECT

WRIST, INDEX_MCP, PINKY_MCP = 0, 5, 17
FINGERS = ((5, 8), (9, 12), (13, 16), (17, 20))  # (knuckle, tip): index..little
EXTENDED_RATIO = 1.6
MIN_EXTENDED = 3
SIDE_SINE = 0.25  # below this |sin(angle)|, the hand is seen edge-on


def palm_side(landmarks: np.ndarray, handedness: str) -> str:
    """'palm', 'back' or 'side': which side of the hand faces the camera."""
    pts = np.asarray(landmarks, dtype=np.float64)[:, :2] * (ASPECT, 1.0)  # x in y units
    v1, v2 = pts[INDEX_MCP] - pts[WRIST], pts[PINKY_MCP] - pts[WRIST]
    norm = float(np.linalg.norm(v1) * np.linalg.norm(v2))
    if norm < 1e-9:
        return "side"
    sine = float(v1[0] * v2[1] - v1[1] * v2[0]) / norm
    if abs(sine) < SIDE_SINE:
        return "side"
    # In image coordinates (y down), the person's right hand with the palm to
    # the camera gives a negative sine. MediaPipe's "Right" = the person's right.
    persons_right = handedness.lower() == "right"
    palm = (sine < 0) if persons_right else (sine > 0)
    if os.environ.get("CUES_PALM_FLIP", "0") in ("1", "true"):
        palm = not palm
    return "palm" if palm else "back"


def extended_fingers(landmarks: np.ndarray) -> int:
    pts = np.asarray(landmarks, dtype=np.float64)[:, :2] * (ASPECT, 1.0)  # x in y units
    count = 0
    for knuckle, tip in FINGERS:
        k = np.linalg.norm(pts[knuckle] - pts[WRIST])
        if k > 1e-9 and np.linalg.norm(pts[tip] - pts[WRIST]) / k >= EXTENDED_RATIO:
            count += 1
    return count


def is_open(landmarks: np.ndarray) -> bool:
    return extended_fingers(landmarks) >= MIN_EXTENDED


def describe(landmarks: np.ndarray, handedness: str) -> str:
    """Short text for debugging, e.g. 'palm, open (4/4 fingers)'."""
    n = extended_fingers(landmarks)
    state = "open" if n >= MIN_EXTENDED else "closed"
    return f"{palm_side(landmarks, handedness)}, {state} ({n}/4 fingers)"


OPEN_PALM_MIN = 0.5  # Gesture Recognizer Open_Palm score needed to call a hand open


def open_palm_check(hand) -> bool | None:
    """Is this hand an open palm facing the camera (the raise-hand pose)?

    True or False when the hand gives evidence either way; None when it cannot be told:
    there is no hand, or it is seen edge-on so palm and back cannot be separated. None is
    missing evidence, not a wrong palm: callers must not turn it into False.

    Open: the Gesture Recognizer's Open_Palm score is at least OPEN_PALM_MIN
    (finger counting is used when a hand has no recogniser scores). Facing:
    palm_side() reads "palm"; "back" is a clearly wrong hand.
    """
    if hand is None:
        return None
    side = palm_side(hand.landmarks, hand.handedness)
    if side == "side":
        return None
    if side != "palm":
        return False
    if hand.gestures:
        return hand.gestures.get("Open_Palm", 0.0) >= OPEN_PALM_MIN
    return is_open(hand.landmarks)


def open_palm_facing(hand) -> bool:
    """True only for an open palm facing the camera (display callers: None counts as no)."""
    return open_palm_check(hand) is True
