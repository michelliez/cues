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

test("Attention only says All clear when the camera agrees", async () => {
  const { clearLine, nameList } = await import("../lib/classroom-view.ts");
  assert.deepEqual(clearLine([], "classroom"), {
    text: "All clear. Cues will ask when someone may need you.",
    flagged: false,
  });
  assert.equal(clearLine([], "review").text, "All clear. No one needs you right now.");
  const one = clearLine(["Keith"], "classroom");
  assert.equal(one.flagged, true);
  assert.equal(one.text, "No requests yet. The camera flagged Keith for a look.");
  assert.doesNotMatch(one.text, /All clear/);
  assert.equal(nameList(["Keith", "Evan"]), "Keith and Evan");
  assert.equal(nameList(["Keith", "Evan", "Eric", "Michelle"]), "Keith, Evan and 2 more");
});

test("the dashboard names camera-flagged people instead of saying All clear", async () => {
  const { readFileSync } = await import("node:fs");
  const dash = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dash, /present\(seat\)\.needsReview && reviewsFor\(seat\.id\)\.length === 0/);
  assert.ok(!dash.includes('"All clear. Cues will ask when someone may need you."'));
  assert.ok(!dash.includes('"All clear. No one needs you right now."'));
});
