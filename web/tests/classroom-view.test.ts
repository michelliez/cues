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

test("cards follow Attention: no 'Needs review' card while Attention is all clear", () => {
  const flagged = person("1", "Needs Review", "review");
  // Feed live, no request for them: the card does not contradict All clear.
  const [clear] = stripEntries([flagged], new Set(), null, false, true);
  assert.equal(clear.status, "Working");
  assert.equal(clear.tone, "working");
  // A pending request still reads Check in.
  const [asked] = stripEntries([flagged], new Set(["1"]), null, false, true);
  assert.equal(asked.status, CHECK_IN_LABEL);
  assert.equal(asked.tone, "review");
  // Feed not live (loading, dropped): keep the camera's own status.
  const [unknown] = stripEntries([flagged], new Set(), null, false, false);
  assert.equal(unknown.status, "Needs Review");
  // Other statuses are untouched.
  const [done] = stripEntries([person("2", "Completed", "done")], new Set(), null, false, true);
  assert.equal(done.status, "Completed");
});
