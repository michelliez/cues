import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHECK_IN_LABEL,
  stripEntries,
  waitingCount,
} from "../lib/classroom-view.ts";
import type { SeatState } from "../lib/dashboard.ts";
import { observationPresentation } from "../lib/observation-presentation.ts";
import { groupReviewsBySeat, type TeacherReview } from "../lib/teacher-reviews.ts";

const now = Date.parse("2026-11-14T12:00:05Z");
const live = { enabled: true, connected: true, now };
const seat = (status: SeatState["status"]): SeatState => ({
  seat_id: "S1-P1",
  session_id: "session-a",
  activity_id: "raise_hand",
  status,
  task_score: 0.1,
  tracking_valid: true,
  updated_at: "2026-11-14T12:00:04Z",
});
const review = (id: string, seat_id = "S1-P1") =>
  ({ id, seat_id, status: "pending", priority: "normal", created_at: "2026-11-14T12:00:00Z" }) as unknown as TeacherReview;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("1-3. a vision review or needs_help with no pending teacher_review is not in Attention and the count is zero", () => {
  for (const status of ["review", "needs_help"] as const) {
    // Attention is built from the pending reviews alone: no reviews, no one.
    const groups = groupReviewsBySeat([]);
    assert.deepEqual(groups, []);
    assert.equal(waitingCount(true, groups), 0);
    // ...whatever the camera says about the person.
    const view = observationPresentation(seat(status), live);
    assert.equal("needsReview" in view, false);
  }
  // The dashboard has no other source for the list or the count.
  const dash = read("../components/dashboard.tsx");
  assert.match(dash, /const waitingCount = pendingCount\(reviewsLive, reviewGroups\)/);
  assert.doesNotMatch(dash, /flaggedOnly|flaggedIdSet|catchingUp|reviewQueue|unexplainedDrops/);
});

test("4-5. a real pending review is in Attention, counted once per person, and the card reads Check in", () => {
  const groups = groupReviewsBySeat([review("a"), review("b"), review("c", "S1-P2")]);
  assert.deepEqual(groups.map((g) => g.seat_id), ["S1-P1", "S1-P2"]);
  assert.equal(waitingCount(true, groups), 2);
  assert.equal(waitingCount(false, groups), 0); // not live yet: nothing is claimed
  const [asked, other] = stripEntries(
    [
      { id: "S1-P1", name: "P1", label: "Working", tone: "working", activity: "" },
      { id: "S1-P3", name: "P3", label: "Working", tone: "working", activity: "" },
    ],
    new Set(groups.map((g) => g.seat_id)),
    null,
    false,
  );
  assert.equal(asked.status, CHECK_IN_LABEL);
  assert.equal(asked.tone, "review");
  assert.equal(other.status, "Working");
});

test("6. a raw vision flag without a review reads neutrally, never as support or review", () => {
  for (const status of ["review", "needs_help"] as const) {
    const view = observationPresentation(seat(status), live);
    assert.equal(view.label, "Low task match");
    assert.match(view.detail, /observation, not a request for support/);
    assert.doesNotMatch(`${view.label} ${view.detail}`, /needs review|needs help|support needed|may need/i);
    const [entry] = stripEntries(
      [{ id: "S1-P1", name: "P1", label: view.label, tone: "quiet", activity: "" }],
      new Set(),
      null,
      false,
    );
    assert.equal(entry.status, "Low task match");
    assert.notEqual(entry.tone, "review");
  }
  // Neutral progress information is kept.
  assert.equal(observationPresentation(seat("in_progress"), live).label, "Working");
  assert.equal(observationPresentation(seat("done"), live).label, "Completed");
  assert.equal(observationPresentation({ ...seat("in_progress"), tracking_valid: false }, live).label, "Tracking unavailable");
  const dash = read("../components/dashboard.tsx");
  const tone = dash.slice(dash.indexOf("const statusTone"), dash.indexOf("/** Who the dashboard is for"));
  assert.doesNotMatch(tone, /needsReview|"review"/); // only "Check in" gets the review tone
});

test("7. Support needed / No support needed exist only for an actual review row", () => {
  const buttons = read("../components/mark-reviewed-button.tsx");
  const card = read("../components/review-card.tsx");
  assert.doesNotMatch(buttons, /FlagDecisionButtons/);
  assert.doesNotMatch(card, /WaitingReviewCard/);
  const dash = read("../components/dashboard.tsx");
  assert.doesNotMatch(dash, /FlagDecisionButtons|WaitingReviewCard|flagDecisions/);
  // The only decision buttons are TeacherReviewActions, keyed by a review.
  assert.equal((dash.match(/<TeacherReviewActions/g) ?? []).length, 1);
  assert.match(dash, /<TeacherReviewActions\s+key=\{lead\.id\}/);
  const person = read("../components/person-panel.tsx");
  assert.ok(!person.includes("needsReview"));
  // The request panel, its wording and the buttons sit inside `review ? (...)`.
  const request = person.slice(person.indexOf("{review ? ("));
  assert.match(request, /TeacherReviewActions/);
  assert.equal(person.slice(0, person.indexOf("{review ? (")).includes("TeacherReviewActions>"), false);
});

test("8. resolving a review leaves no camera-only replacement", () => {
  const before = groupReviewsBySeat([review("a")]);
  assert.equal(waitingCount(true, before), 1);
  // The review resolves; vision still says needs_help for that person.
  const after = groupReviewsBySeat([]);
  assert.equal(waitingCount(true, after), 0);
  assert.equal(observationPresentation(seat("needs_help"), live).label, "Low task match");
});
