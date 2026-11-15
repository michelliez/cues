import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTeacherReview } from "../lib/teacher-review-actions.ts";
import type { TeacherReview } from "../lib/teacher-reviews.ts";
import { reviewQueue, withResolvedReviewMark } from "../lib/classroom-view.ts";
import type { SeatState } from "../lib/dashboard.ts";
const review: TeacherReview = {
  id: "11111111-1111-4111-8111-111111111111",
  session_id: "00000000-0000-4000-8000-000000000001",
  seat_id: "S1-L",
  activity_id: "raise_hand",
  created_at: "2026-11-14T12:00:00Z",
  priority: "normal",
  decision: "teacher_review_warranted",
  rationale: "Progress stalled.",
  evidence_used: ["current_progress"],
  status: "pending",
  resolved_at: null,
};
function client(data: unknown, error: unknown = null) {
  const calls: unknown[] = [];
  return {
    calls,
    value: {
      rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return {
          abortSignal(signal: AbortSignal) {
            assert.ok(signal);
            return Promise.resolve({ data, error });
          },
        };
      },
    } as unknown as SupabaseClient,
  };
}
for (const status of ["confirmed", "dismissed"] as const) {
  test(`persists ${status} using narrow RPC and validates server acknowledgement`, async () => {
    const resolved = { ...review, status, resolved_at: "2026-11-14T12:01:00Z" };
    const mock = client([resolved]);
    assert.deepEqual(
      await resolveTeacherReview(mock.value, review, status),
      resolved,
    );
    assert.deepEqual(mock.calls, [
      {
        name: "resolve_teacher_review",
        args: { review_id: review.id, action: status },
      },
    ]);
  });
}
test("resolved reviews never send another action", async () => {
  const mock = client([]);
  await assert.rejects(
    resolveTeacherReview(
      mock.value,
      { ...review, status: "dismissed" },
      "confirmed",
    ),
  );
  assert.equal(mock.calls.length, 0);
});
test("failure, conflict, missing RPC and malformed acknowledgements never resolve locally", async () => {
  for (const mock of [
    client(null, { message: "private database detail" }),
    client([]),
    client([review]),
    client([{ ...review, status: "confirmed" }]),
    client([
      {
        ...review,
        id: "22222222-2222-4222-8222-222222222222",
        status: "confirmed",
        resolved_at: "2026-11-14T12:01:00Z",
      },
    ]),
  ]) {
    await assert.rejects(
      resolveTeacherReview(mock.value, review, "confirmed"),
      /Could not save this review action/,
    );
    assert.equal(review.status, "pending");
  }
});

for (const status of ["confirmed", "dismissed"] as const) {
  test(`${status} clears the old camera flag while preserving another person's request`, async () => {
    const observation: SeatState = {
      seat_id: review.seat_id, session_id: review.session_id, activity_id: review.activity_id,
      status: "review", task_score: 0, updated_at: "2026-11-14T12:00:59Z",
    };
    const mock = client([{ ...review, status, resolved_at: "2026-11-14T12:01:00Z" }]);
    const saved = await resolveTeacherReview(mock.value, review, status);
    const marked = withResolvedReviewMark(new Set(), saved, observation);
    const queue = reviewQueue({
      enabled: true, live: true, people: [{ id: review.seat_id }],
      flagged: () => true, askedSeatIds: ["S1-P2"], marked,
    });
    assert.deepEqual(queue, { flagged: [], count: 1 });
    assert.equal(saved.status, status);
    assert.deepEqual([...marked], [review.seat_id]);
    assert.equal(observation.status, "review"); // Never fake a new vision observation.
    assert.equal(reviewQueue({ enabled: false, live: true, people: [], flagged: () => true,
      askedSeatIds: ["S1-P2"], marked }).count, 1);
  });
}

test("an old answer cannot hide another session, task, person or a fresh stall", () => {
  const saved = { ...review, status: "dismissed" as const, resolved_at: "2026-11-14T12:01:00Z" };
  const observation: SeatState = {
    seat_id: review.seat_id, session_id: review.session_id, activity_id: review.activity_id,
    status: "review", task_score: 0, updated_at: "2026-11-14T12:00:59Z",
  };
  for (const state of [null, { ...observation, session_id: "another-session" },
    { ...observation, activity_id: "thumbs_up" }, { ...observation, seat_id: "S1-P2" },
    { ...observation, updated_at: "2026-11-14T12:02:00Z" }]) {
    assert.deepEqual([...withResolvedReviewMark(new Set(["S1-P2"]), saved, state)], ["S1-P2"]);
  }
  assert.equal(withResolvedReviewMark(new Set(), review, observation).size, 0);
});
