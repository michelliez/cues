import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_COLORS,
  DONE_MS,
  EAT_MS,
  companionStep,
  initialCompanionPhase,
} from "../lib/companion.ts";

test("the companion rests blue, waits orange and celebrates green", () => {
  assert.equal(COMPANION_COLORS.rest, "#5763d2");
  assert.equal(COMPANION_COLORS.waiting, "#e8741f");
  assert.equal(COMPANION_COLORS.eating, COMPANION_COLORS.waiting);
  assert.equal(COMPANION_COLORS.done, "#34a46a");
});

test("it starts where the queue is, without a hop", () => {
  assert.equal(initialCompanionPhase(0), "rest");
  assert.equal(initialCompanionPhase(3), "waiting");
  assert.deepEqual(companionStep(3, 3), { kind: "none" });
});

test("each new request is a hop; a smaller but non-empty queue changes nothing", () => {
  assert.deepEqual(companionStep(0, 1), { kind: "hop" });
  assert.deepEqual(companionStep(1, 2), { kind: "hop" });
  assert.deepEqual(companionStep(2, 1), { kind: "none" });
});

test("clearing the queue eats the last count, then green, then rest", () => {
  assert.deepEqual(companionStep(2, 0), { kind: "eat", eaten: 2 });
  assert.deepEqual(companionStep(0, 0), { kind: "none" });
  assert.ok(EAT_MS >= 1200 && EAT_MS <= 2000, "the eat is unhurried but under 2s");
  assert.ok(DONE_MS >= 1500 && DONE_MS <= 3000, "green lasts about 2s");
  // A request arriving mid-eat is a hop: the component cancels the eat timers.
  assert.deepEqual(companionStep(0, 1), { kind: "hop" });
});

test("a dropped or loading feed is never a cleared queue", () => {
  assert.deepEqual(companionStep(3, null), { kind: "rest" });
  assert.deepEqual(companionStep(null, null), { kind: "rest" });
  // Coming back shows the queue as it is: no hop, no eat.
  assert.deepEqual(companionStep(null, 3), { kind: "sync" });
  assert.deepEqual(companionStep(null, 0), { kind: "sync" });
  assert.equal(initialCompanionPhase(null), "rest");
});

test("coming back to an empty queue the tab last saw with requests is an eat", () => {
  // Cleared on the To review page, then back to the classroom.
  assert.deepEqual(companionStep(null, 0, 2), { kind: "eat", eaten: 2 });
  // Nothing remembered, or the queue still has requests: just show it.
  assert.deepEqual(companionStep(null, 0, null), { kind: "sync" });
  assert.deepEqual(companionStep(null, 0, 0), { kind: "sync" });
  assert.deepEqual(companionStep(null, 1, 2), { kind: "sync" });
  // Remembered only matters on the first live count.
  assert.deepEqual(companionStep(1, 0, 5), { kind: "eat", eaten: 1 });
});

test("only the dashboard remembers, per station, and sign-out forgets", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  // The landing demo's simulated counts are never stored.
  assert.doesNotMatch(read("../components/landing-demo.tsx"), /<ReviewCompanion[^>]*rememberAs/);
  // The companion reads and writes only under its station's key.
  const companion = read("../components/review-companion.tsx");
  assert.match(companion, /`\$\{COMPANION_COUNT_KEY\}:\$\{rememberAs\}`/);
  assert.match(companion, /if \(!memoryKey \|\| count === null\) return;/);
  // Sign-out clears every remembered count in the tab.
  assert.match(read("../components/profile-account.tsx"), /forgetCompanionCounts\(window\.sessionStorage\)/);
  const { forgetCompanionCounts } = await import("../lib/companion.ts");
  const store = new Map<string, string>([
    ["cues-companion-count:S1", "2"],
    ["cues-companion-count:S2", "1"],
    ["other", "x"],
  ]);
  const storage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
  } as unknown as Storage;
  forgetCompanionCounts(storage);
  assert.deepEqual([...store.keys()], ["other"]);
});
