import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { seatViews, type Snapshot, type SeatState } from "../lib/dashboard.ts";
import {
  UNMANAGED,
  contextFromSnapshot,
  currentObservations,
  matchesContext,
  waitingMessage,
} from "../lib/observation-context.ts";
import { inCameraView } from "../lib/observation-presentation.ts";
import type { Session, SessionSnapshot } from "../lib/session-controls.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const session = (over: Partial<Session> = {}): Session => ({
  id: A,
  station_id: "S1",
  current_activity_id: "raise_hand",
  started_at: "2026-11-15T00:00:00Z",
  ended_at: null,
  revision: 3,
  ...over,
});
const snap = (s: Session | null): SessionSnapshot => ({ session: s, activities: [] });
const row = (over: Partial<SeatState> = {}): SeatState => ({
  seat_id: "S1-P1",
  session_id: A,
  activity_id: "raise_hand",
  status: "in_progress",
  task_score: 0.2,
  tracking_valid: true,
  session_revision: 3,
  updated_at: "2026-11-15T00:00:04Z",
  ...over,
});
const feed = (state: SeatState): Snapshot => ({
  seats: [{ id: "S1-P1", station_id: "S1", side: null, display_name: "Person 1", is_simulated: false }],
  states: [state],
  activities: [{ id: "raise_hand", name: "Raise your hand" }],
  stations: [{ id: "S1", name: "Demo" }],
});
const shown = (state: SeatState, ctx = contextFromSnapshot(snap(session()))) =>
  seatViews(currentObservations(feed(state), ctx)).filter((seat) => seat.state !== null);

test("1. a row from the current session, activity and revision renders", () => {
  const seats = shown(row());
  assert.equal(seats.length, 1);
  // Then the existing freshness check still applies on top of the match.
  const live = { enabled: true, connected: true, now: Date.parse("2026-11-15T00:00:05Z") };
  assert.equal(inCameraView(seats[0].state, live), true);
  assert.equal(inCameraView(seats[0].state, { ...live, now: live.now + 60_000 }), false);
});

test("2. a row from another session is rejected", () => {
  assert.equal(shown(row({ session_id: B })).length, 0);
});

test("3. a row from another activity is rejected", () => {
  assert.equal(shown(row({ activity_id: "open_palm" })).length, 0);
});

test("4. a row from another revision is rejected, in either direction", () => {
  assert.equal(shown(row({ session_revision: 2 })).length, 0);
  assert.equal(shown(row({ session_revision: 4 })).length, 0);
});

test("5. revision 0 is valid, and null is never a wildcard", () => {
  const zero = contextFromSnapshot(snap(session({ revision: 0 })));
  assert.equal(shown(row({ session_revision: 0 }), zero).length, 1);
  assert.equal(shown(row({ session_revision: null }), zero).length, 0); // null is not 0
  assert.equal(shown(row({ session_revision: null })).length, 0); // nor "any revision"
  assert.equal(shown(row({ activity_id: null })).length, 0);
  assert.equal(matchesContext(null, zero), false);
});

test("6. with no active session there is no current task observation", () => {
  for (const ctx of [
    contextFromSnapshot(snap(null)), // no session
    contextFromSnapshot(snap(session({ ended_at: "2026-11-15T00:01:00Z" }))), // ended
    contextFromSnapshot(snap(session({ current_activity_id: null }))), // no activity
    contextFromSnapshot(null), // not loaded yet: cached rows are not current either
  ]) {
    assert.equal(shown(row(), ctx).length, 0);
  }
  assert.equal(contextFromSnapshot(null).kind, "loading");
  assert.equal(contextFromSnapshot(snap(null)).kind, "none");
});

test("7. switching activity immediately hides the old activity's row", () => {
  const old = row();
  assert.equal(shown(old, contextFromSnapshot(snap(session()))).length, 1);
  // The change returns the next revision and activity; the old row stops counting at once.
  const switched = contextFromSnapshot(
    snap(session({ current_activity_id: "open_palm", revision: 4 })),
  );
  assert.equal(shown(old, switched).length, 0);
  assert.equal(shown(row({ activity_id: "open_palm", session_revision: 4 }), switched).length, 1);
});

test("8. a session restart immediately hides the old session's row; a revision bump alone does too", () => {
  const old = row();
  const restarted = contextFromSnapshot(snap(session({ id: B, revision: 0 })));
  assert.equal(shown(old, restarted).length, 0);
  // Same session and activity, next revision (a restart of the activity).
  const bumped = contextFromSnapshot(snap(session({ revision: 4 })));
  assert.equal(shown(old, bumped).length, 0);
  // A late response carrying only older rows can never come back as current.
  assert.equal(shown(row({ session_id: A, session_revision: 3 }), restarted).length, 0);
});

test("the waiting message follows the context and never hides a camera or feed problem", () => {
  const neutral = "No current person observations.";
  assert.equal(waitingMessage(neutral, neutral, contextFromSnapshot(snap(session()))), "Waiting for current observations");
  assert.match(waitingMessage(neutral, neutral, contextFromSnapshot(snap(null))), /No activity is running/);
  assert.equal(waitingMessage(neutral, neutral, contextFromSnapshot(null)), "Loading the session…");
  assert.equal(waitingMessage("Camera unavailable.", neutral, contextFromSnapshot(snap(session()))), "Camera unavailable.");
  assert.equal(waitingMessage(neutral, neutral, UNMANAGED), neutral);
  assert.equal(shown(row({ session_id: B }), UNMANAGED).length, 1); // session controls off: as before
});

test("wiring: one session read is shared, adopted before the slower step, and the strip is unchanged", () => {
  const controls = readFileSync(new URL("../components/session-controls.tsx", import.meta.url), "utf8");
  const dash = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dash, /onSnapshot=\{setSessionSnapshot\}/);
  assert.match(dash, /contextFromSnapshot\(sessionSnapshot\)/);
  assert.equal((controls.match(/readSession\(/g) ?? []).length, 1); // no second poll
  assert.ok(controls.indexOf("setSnapshot(next)") < controls.indexOf("await clearRequests(result.id)"));
  assert.match(dash, /updatedAt=\{allSeats\.map/); // camera health reads every row, as before
  assert.match(dash, /nameOf = \(seatId: string\) =>\s*allSeats\.find/);
});
