import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("web.reset_people is registered and wired from the page to the session controls", () => {
  const flag = JSON.parse(read("../../flags.json"))["web.reset_people"];
  assert.ok(flag && typeof flag.description === "string");
  assert.match(read("../app/dashboard/page.tsx"), /resetPeopleEnabled=\{isEnabled\("web\.reset_people"\)\}/);
  const dashboard = read("../components/dashboard.tsx");
  assert.match(dashboard, /resetPeopleEnabled\s*\?\s*\{/);
  // Everyone with an open request is closed through the existing Mark as reviewed path.
  assert.match(dashboard, /seatIds: reviewGroups\.map\(\(group\) => group\.seat_id\)/);
  // Only people with a pending review have anything to close (camera-only flags are gone).
  assert.match(dashboard, /onReset: \(ids\) => ids\.forEach\(applyMarked\)/);
});

test("switching an activity closes open requests, and the refresh button restarts the activity", () => {
  const controls = read("../components/session-controls.tsx");
  // After a successful start/change/restart (never after End), open requests are closed.
  assert.match(controls, /activityId !== null && !result\.ended_at\) await clearRequests\(result\.id\)/);
  assert.match(controls, /markSeatReviewed\(client, sessionId, seatId\)/);
  // The restart is the same verified RPC as Change activity, on the current activity, after a confirm.
  assert.match(controls, /window\.confirm\(RESET_CONFIRM\)/);
  assert.match(controls, /act\(snapshot\.session\.current_activity_id\)/);
  // Off, or with no running activity, or while the session failed to load: it only reloads.
  assert.match(controls, /resetPeople && snapshot\?\.session && !loadError && !refreshRequired/);
  // After one failed read or action the button is the retry, and it stays usable.
  assert.match(controls, /disabled=\{busy\}\n\s*onClick=\{\(\) => \{\n\s*if \(!restart\) return setRefreshKey/);
  assert.match(controls, /if \(!restart\) return setRefreshKey/);
});

test("one failed close never leaves the rest open, and the teacher is told", () => {
  const controls = read("../components/session-controls.tsx");
  assert.match(controls, /closed\.length < reset\.seatIds\.length/);
  assert.match(controls, /some requests could not be closed/);
});
