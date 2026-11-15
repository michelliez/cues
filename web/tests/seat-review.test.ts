import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MARK_REVIEWED_ERRORS,
  markSeatReviewed,
  parseSeatReview,
} from "../lib/seat-review.ts";
import { parseTeacherReviews, pendingReviews } from "../lib/teacher-reviews.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";

function rpcClient(response: { data?: unknown; error?: unknown } | Error) {
  const calls: unknown[][] = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push([name, args]);
      return {
        abortSignal: async () => {
          if (response instanceof Error) throw response;
          return { data: null, error: null, ...response };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

test("marking sends only the session and the person; the teacher comes from the sign-in", async () => {
  const { client, calls } = rpcClient({
    data: { closed: 2, marked_at: "2026-11-14T12:00:00Z" },
  });
  assert.deepEqual(await markSeatReviewed(client, SESSION, "S1-P1"), { closed: 2 });
  assert.deepEqual(calls, [
    ["mark_seat_reviewed", { p_session_id: SESSION, p_seat_id: "S1-P1" }],
  ]);
});

test("a child with no open review can still be marked", async () => {
  const { client } = rpcClient({ data: { closed: 0, marked_at: "2026-11-14T12:00:00Z" } });
  assert.deepEqual(await markSeatReviewed(client, SESSION, "S1-P2"), { closed: 0 });
});

test("bad ids are refused before anything is sent", async () => {
  const { client, calls } = rpcClient({ data: {} });
  await assert.rejects(markSeatReviewed(client, "not-a-uuid", "S1-P1"));
  await assert.rejects(markSeatReviewed(client, SESSION, "S1 P1; drop table"));
  await assert.rejects(markSeatReviewed(client, SESSION, ""));
  assert.deepEqual(calls, []);
});

test("errors are mapped to plain messages and never show provider details", async () => {
  const cases: [unknown, string][] = [
    [{ code: "42501", message: "Not authorized for station" }, MARK_REVIEWED_ERRORS.signIn],
    [{ code: "22023", message: "Session unavailable" }, MARK_REVIEWED_ERRORS.gone],
    [{ code: "XX000", message: "secret detail" }, MARK_REVIEWED_ERRORS.failed],
  ];
  for (const [error, message] of cases)
    await assert.rejects(
      markSeatReviewed(rpcClient({ error }).client, SESSION, "S1-P1"),
      (thrown: Error) => thrown.message === message && !/secret/.test(thrown.message),
    );
  await assert.rejects(
    markSeatReviewed(rpcClient(new Error("offline")).client, SESSION, "S1-P1"),
    new RegExp(MARK_REVIEWED_ERRORS.failed),
  );
});

test("malformed answers are rejected", () => {
  for (const bad of [null, {}, { closed: -1, marked_at: "2026-11-14T12:00:00Z" },
    { closed: 1.5, marked_at: "2026-11-14T12:00:00Z" }, { closed: 1 },
    { closed: 1, marked_at: "yesterday" }])
    assert.throws(() => parseSeatReview(bad), /Invalid response/);
});

test("a review the teacher marked reviewed is valid but never waiting", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    session_id: SESSION,
    seat_id: "S1-P1",
    activity_id: "raise_hand",
    created_at: "2026-11-14T12:00:00Z",
    priority: "normal",
    rationale: "Progress has stalled across recent observations.",
    evidence_used: ["current_progress"],
    status: "reviewed",
    resolved_at: "2026-11-14T12:05:00Z",
  };
  const parsed = parseTeacherReviews([row]);
  assert.equal(parsed[0].status, "reviewed");
  assert.deepEqual(pendingReviews(parsed), []);
});

// The runner does not mount React: check the wiring in source.
test("Mark as reviewed is wired only to people with a pending review, and only with review actions on", () => {
  const dashboard = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /reviewActionsEnabled && client && sessionId/);
  // An opened row in Attention (it has a pending review by construction) and each card
  // on the To review page. A person opened from the strip with no request gets none.
  assert.match(dashboard, /pending\.length\s*\? markReviewedButton\(pending\[0\]\.session_id, seatId\)\s*: null/);
  assert.match(dashboard, /mark=\{markReviewedButton\(lead\.session_id, group\.seat_id\)\}/);
  assert.equal((dashboard.match(/markReviewedButton\(/g) ?? []).length, 2); // the two calls above
  const person = readFileSync(new URL("../components/person-panel.tsx", import.meta.url), "utf8");
  assert.ok(!person.includes("needsReview"));
  const button = readFileSync(new URL("../components/mark-reviewed-button.tsx", import.meta.url), "utf8");
  assert.ok(button.includes("locked.current = true")); // a double click marks once
  assert.ok(button.includes("disabled={!authenticated || saving || done}"));
});
