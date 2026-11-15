import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECK_IN_LABEL,
  reviewIssueLine,
  stripEntries,
  type StripSource,
} from "../lib/classroom-view.ts";

const person = (id: string, label = "Working", tone: StripSource["tone"] = "working"): StripSource => ({
  id,
  name: `Person ${id}`,
  label,
  tone,
  activity: "Raise hand",
});

test("the student row keeps the camera's left-to-right order", () => {
  const row = stripEntries([person("3"), person("1"), person("2")], new Set(), null, false);
  assert.deepEqual(row.map((entry) => entry.id), ["3", "1", "2"]);
});

test("someone Cues asked about reads Check in, never a claim about the child", () => {
  const [asked, other] = stripEntries(
    [person("1", "Completed", "done"), person("2")],
    new Set(["1"]),
    null,
    false,
  );
  assert.equal(asked.status, CHECK_IN_LABEL);
  assert.equal(asked.tone, "review");
  assert.equal(other.status, "Working");
  assert.equal(other.tone, "working");
  assert.doesNotMatch(CHECK_IN_LABEL, /attention|distress|struggl|emotion/i);
});

test("the opened card is marked selected; activities show only when mixed", () => {
  const same = stripEntries([person("1"), person("2")], new Set(), "2", false);
  assert.deepEqual(same.map((entry) => entry.selected), [false, true]);
  assert.deepEqual(same.map((entry) => entry.activity), ["", ""]);
  const mixed = stripEntries([person("1")], new Set(), null, true);
  assert.equal(mixed[0].activity, "Raise hand");
});

test("a To review card says the task, then not in view, then the request count", () => {
  assert.equal(reviewIssueLine("Raise hand", true, 1), "Raise hand");
  assert.equal(reviewIssueLine("Raise hand", false, 1), "Raise hand · not in view");
  assert.equal(reviewIssueLine("Raise hand", true, 2), "Raise hand · 2 requests");
  assert.equal(
    reviewIssueLine("Thumbs up", false, 3),
    "Thumbs up · not in view · 3 requests",
  );
});

test("Attention lists camera-flagged people as rows until the teacher answers", async () => {
  const { readFileSync } = await import("node:fs");
  const dash = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
  // The rows come from reviewQueue's flagged list (marked people already left out).
  assert.match(dash, /\{reviewGroups\.length \|\| flaggedOnly\.length \? \(\s*<ul className="row-list">/);
  assert.match(dash, /\{flaggedOnly\.map\(\(seat\) =>\s*row\(/);
  // A flagged person opens in place there, not in the side panel.
  assert.match(dash, /!flaggedIdSet\.has\(selectedId\)/);
  // All clear only when nobody is flagged and nobody marked is still catching up.
  assert.match(dash, /catchingUp\s*\?\s*"Marked as reviewed\. The camera will catch up in a moment\."\s*:\s*"All clear\. Cues will ask when someone may need you\."/);
});

test("a flagged person without a request gets durable choices behind the rollout flag", async () => {
  const { readFileSync } = await import("node:fs");
  const dash = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dash, /flaggedIdSet\.has\(seatId\) && pending\.length === 0\s*\? flagDecisions/);
  assert.match(dash, /mark=\{flagDecisions\(/);
  assert.match(dash, /reviewActionsEnabled && client && sessionId \? \(\s*<FlagDecisionButtons/);
  const button = readFileSync(new URL("../components/mark-reviewed-button.tsx", import.meta.url), "utf8");
  const decisions = button.slice(button.indexOf("export function FlagDecisionButtons"));
  assert.match(decisions, /resolutionLabels\.confirmed/);
  assert.match(decisions, /resolutionLabels\.dismissed/);
  // Preserve the actual choice, without inventing an agent review.
  assert.match(decisions, /recordFlagDecision\(client, request\.current\.observation, choice, request\.current\.id\)/);
  assert.doesNotMatch(decisions, /markSeatReviewed\(/);
  assert.match(dash, /if \(!flagDecisionsEnabled\) return markReviewedButton\(sessionId, seatId\)/);
  assert.doesNotMatch(decisions, /resolve_teacher_review|resolveTeacherReview/);
  assert.ok(decisions.includes("locked.current = true")); // a double click saves once
});
