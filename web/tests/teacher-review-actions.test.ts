import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTeacherReview } from "../lib/teacher-review-actions.ts";
import type { TeacherReview } from "../lib/teacher-reviews.ts";
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
