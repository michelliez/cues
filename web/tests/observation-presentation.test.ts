import assert from "node:assert/strict";
import test from "node:test";
import {
  inCameraView,
  isFresh,
  observationPresentation,
  OBSERVATION_FUTURE_SKEW_MS,
  OBSERVATION_STALE_MS,
} from "../lib/observation-presentation.ts";
import { parseSnapshot, seatViews, type SeatState } from "../lib/dashboard.ts";
import { isEnabled } from "../lib/flags.ts";
const now = Date.parse("2026-11-14T12:00:05Z");
const state: SeatState = {
  seat_id: "S1-P1",
  session_id: "session-a",
  activity_id: "raise_hand",
  status: "in_progress",
  task_score: 0.85,
  tracking_valid: true,
  updated_at: "2026-11-14T12:00:04Z",
};
const live = { enabled: true, connected: true, now };
test("fresh valid observations show backend status and score without re-evaluation", () => {
  const view = observationPresentation(state, live);
  assert.equal(view.label, "Working");
  assert.equal(view.score, 0.85);
  assert.equal(view.currentStatus, "in_progress");
  assert.equal(
    observationPresentation({ ...state, status: "done" }, live).label,
    "Completed",
  );
});
test("invalid or unknown tracking never presents a task failure or score", () => {
  for (const tracking_valid of [false, null, undefined]) {
    const view = observationPresentation(
      { ...state, status: "review", tracking_valid },
      live,
    );
    assert.equal(
      view.label,
      tracking_valid === false ? "Tracking unavailable" : "Tracking unknown",
    );
    assert.equal(view.score, null);
    assert.equal(view.currentStatus, null);
  }
  assert.equal(
    observationPresentation(
      { ...state, status: "tracking_lost", tracking_valid: false },
      live,
    ).label,
    "Tracking lost",
  );
});
test("five-second freshness boundary, disconnected data, clock recovery and first render", () => {
  const updated_at = new Date(now - OBSERVATION_STALE_MS).toISOString();
  for (const opts of [
    live,
    { ...live, connected: false },
    { ...live, now: null },
  ]) {
    const view = observationPresentation({ ...state, updated_at }, opts);
    assert.equal(view.label, "Updates paused");
    assert.equal(view.score, null);
    assert.equal(view.currentStatus, null);
  }
  assert.equal(
    observationPresentation(
      { ...state, updated_at: new Date(now - 4999).toISOString() },
      live,
    ).label,
    "Working",
  );
  // A row newer than the page's last one-second tick is normal: the camera
  // reports about once a second, and station and dashboard clocks differ a
  // little. It stays in view up to the skew allowance, then counts as a bad
  // clock.
  for (const ahead of [1, 300, OBSERVATION_FUTURE_SKEW_MS])
    assert.equal(
      observationPresentation(
        { ...state, updated_at: new Date(now + ahead).toISOString() },
        live,
      ).label,
      "Working",
    );
  assert.equal(
    observationPresentation(
      {
        ...state,
        updated_at: new Date(
          now + OBSERVATION_FUTURE_SKEW_MS + 1,
        ).toISOString(),
      },
      live,
    ).label,
    "Updates paused",
  );
  assert.equal(
    observationPresentation(
      { ...state, updated_at: new Date(now).toISOString() },
      live,
    ).label,
    "Working",
  );
});
test("departed positions remain one card; reused IDs replace current state without carrying history", () => {
  const metadata = {
    id: "S1-P1",
    station_id: "S1",
    display_name: "Person 1",
    side: null,
    is_simulated: true,
  };
  const input = {
    seats: [metadata],
    states: [{ ...state, status: "tracking_lost", tracking_valid: false }],
    activities: [{ id: "raise_hand", name: "Raise hand" }],
    stations: [{ id: "S1", name: "Station" }],
  };
  const before = structuredClone(input);
  const cards = seatViews(parseSnapshot(input, true));
  assert.equal(cards.length, 1);
  assert.equal(
    observationPresentation(cards[0].state, { ...live, now: now + 60000 })
      .label,
    "Updates paused",
  );
  assert.equal(
    seatViews(
      parseSnapshot(
        { ...input, states: [{ ...state, session_id: "session-b" }] },
        true,
      ),
    )[0].state?.session_id,
    "session-b",
  );
  assert.equal(
    seatViews(parseSnapshot({ ...input, states: [] }, true)).length,
    0,
  );
  assert.deepEqual(input, before);
});
test("feature off preserves the old projection/presentation; flag defaults on", () => {
  // On by default; =0 falls back to the old projection. =1 lists only the
  // people the camera sees now.
  assert.equal(isEnabled("web.person_observations", {}), true);
  assert.equal(
    isEnabled("web.person_observations", { CUES_FLAG_WEB_PERSON_OBSERVATIONS: "0" }),
    false,
  );
  assert.equal(
    isEnabled("web.person_observations", {
      CUES_FLAG_WEB_PERSON_OBSERVATIONS: "1",
    }),
    true,
  );
  assert.equal(
    observationPresentation(
      { ...state, tracking_valid: false },
      { ...live, enabled: false },
    ).label,
    "Working",
  );
  assert.equal(
    observationPresentation(
      { ...state, status: "tracking_lost" },
      { ...live, enabled: false },
    ).score,
    null,
  );
});
test("tracking projection accepts boolean/null only and never treats unknown as valid", () => {
  const input = { seats: [], states: [state], activities: [], stations: [] };
  assert.equal(parseSnapshot(input, true).states[0].tracking_valid, true);
  assert.equal(
    parseSnapshot(
      { ...input, states: [{ ...state, tracking_valid: null }] },
      true,
    ).states[0].tracking_valid,
    null,
  );
  assert.equal(
    Object.hasOwn(parseSnapshot(input, false).states[0], "tracking_valid"),
    false,
  );
  for (const tracking_valid of ["true", 1, {}, []])
    assert.throws(() =>
      parseSnapshot({ ...input, states: [{ ...state, tracking_valid }] }, true),
    );
});

test("people are listed only while the camera sees them", () => {
  assert.equal(inCameraView(state, live), true);
  // Seen, even if its hand tracking is uncertain.
  assert.equal(inCameraView({ ...state, tracking_valid: false }, live), true);
  assert.equal(
    inCameraView({ ...state, status: "tracking_lost" }, live),
    false,
  );
  const stale = { ...live, now: now + OBSERVATION_STALE_MS };
  assert.equal(inCameraView(state, stale), false);
  assert.equal(inCameraView(state, { ...live, connected: false }), false);
  assert.equal(inCameraView(null, live), false);
});

test("camera off: no fresh observation from any person", () => {
  const stale = { ...live, now: now + OBSERVATION_STALE_MS };
  assert.equal(isFresh(state, live), true);
  assert.equal(isFresh(state, stale), false);
  assert.equal(isFresh({ ...state, status: "tracking_lost" }, live), true);
});

test("with person observations off, any observed person who is not lost is listed", () => {
  const off = { enabled: false, connected: false, now: null };
  assert.equal(inCameraView(state, off), true);
  assert.equal(inCameraView({ ...state, status: "tracking_lost" }, off), false);
});
