import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordFlagDecision, FLAG_DECISION_ERRORS } from "../lib/flag-decisions.ts";
import type { SeatState } from "../lib/dashboard.ts";
import { isEnabled } from "../lib/flags.ts";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const observation: SeatState = {
  seat_id: "S1-P1", session_id: "00000000-0000-4000-8000-000000000001",
  activity_id: "raise_hand", session_revision: 2, status: "needs_help", task_score: 0,
  updated_at: "2026-11-15T06:00:00Z",
};
const saved = {
  id: REQUEST, session_id: observation.session_id, seat_id: observation.seat_id,
  activity_id: observation.activity_id, session_revision: 2,
  observed_at: "2026-11-15T06:00:00+00:00", decision: "confirmed",
  decided_at: "2026-11-15T06:00:01Z", teacher_id: "00000000-0000-4000-8000-000000000002",
};
function mock(data: unknown = saved, error: unknown = null, offline = false) {
  const calls: unknown[] = [];
  return { calls, client: { rpc(name: string, args: unknown) {
    calls.push([name, args]);
    return { abortSignal: async (signal: AbortSignal) => {
      assert.ok(signal instanceof AbortSignal);
      if (offline) throw new Error("private network detail");
      return { data, error };
    } };
  } } as unknown as SupabaseClient };
}

for (const decision of ["confirmed", "dismissed"] as const) {
  test(`saves ${decision} and binds the acknowledgement to the exact request`, async () => {
    const server = { ...saved, decision };
    const m = mock(server);
    assert.deepEqual(await recordFlagDecision(m.client, observation, decision, REQUEST), server);
    assert.deepEqual(m.calls, [["record_teacher_flag_decision", {
      p_decision_id: REQUEST, p_session_id: observation.session_id, p_seat_id: "S1-P1",
      p_activity_id: "raise_hand", p_expected_revision: 2,
      p_observed_at: observation.updated_at, p_decision: decision,
    }]]);
    assert.equal(observation.status, "needs_help");
  });
}

test("bad observations and request IDs never reach the backend", async () => {
  const m = mock();
  for (const change of [{ session_revision: null }, { session_revision: -1 },
    { activity_id: null }, { session_id: "untrusted" }, { seat_id: "bad id" },
    { updated_at: "2026-11-15T06:00:00" }, { status: "in_progress" as const }])
    await assert.rejects(recordFlagDecision(m.client, { ...observation, ...change }, "confirmed", REQUEST));
  await assert.rejects(recordFlagDecision(m.client, observation, "confirmed", "bad-request"));
  assert.deepEqual(m.calls, []);
});

test("a mismatched or malformed server acknowledgement cannot clear the flag", async () => {
  for (const data of [null, [], {}, { ...saved, id: saved.teacher_id },
    { ...saved, session_id: saved.teacher_id }, { ...saved, seat_id: "S1-P2" },
    { ...saved, activity_id: "thumbs_up" }, { ...saved, session_revision: 3 },
    { ...saved, decision: "dismissed" }, { ...saved, teacher_id: "invented" },
    { ...saved, observed_at: "2026-11-15T06:01:00Z" }, { ...saved, decided_at: null }]) {
    await assert.rejects(recordFlagDecision(mock(data).client, observation, "confirmed", REQUEST),
      new RegExp(FLAG_DECISION_ERRORS.failed));
  }
});

test("backend failures stay safe and never fall back to an acknowledgement-only RPC", async () => {
  for (const [code, expected] of [["42501", "signIn"], ["40001", "changed"],
    ["22023", "changed"], ["PGRST202", "failed"]] as const) {
    const m = mock(null, { code, message: "private provider detail" });
    await assert.rejects(recordFlagDecision(m.client, observation, "confirmed", REQUEST),
      (error: Error) => error.message === FLAG_DECISION_ERRORS[expected]);
    assert.equal(m.calls.length, 1);
  }
  await assert.rejects(recordFlagDecision(mock(null, null, true).client, observation, "confirmed", REQUEST),
    new RegExp(FLAG_DECISION_ERRORS.failed));
});

test("flag-off startup uses the existing single action; both pages wire the rollout flag", () => {
  assert.equal(isEnabled("web.flag_decisions", {}), false);
  assert.equal(isEnabled("web.flag_decisions", { CUES_FLAG_WEB_FLAG_DECISIONS: "1" }), true);
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const source = read("../components/dashboard.tsx");
  assert.match(source, /if \(!flagDecisionsEnabled\) return markReviewedButton\(sessionId, seatId\)/);
  for (const page of ["../app/dashboard/page.tsx", "../app/review/page.tsx"])
    assert.match(read(page), /flagDecisionsEnabled=\{isEnabled\("web\.flag_decisions"\)\}/);
  const buttons = read("../components/mark-reviewed-button.tsx");
  const choice = buttons.slice(buttons.indexOf("export function FlagDecisionButtons"));
  assert.doesNotMatch(choice, /markSeatReviewed\(/);
  assert.match(choice, /await recordFlagDecision[\s\S]*setDone\(true\)[\s\S]*onDecided\?\.\(saved\)/);
  assert.match(choice, /request\.current \?\?=/);
  assert.match(choice, /disabled=\{!authenticated \|\| saving !== null \|\| done\}/);
});
