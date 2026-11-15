import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the header pill says TO REVIEW and the camera button says OFF", () => {
  assert.match(read("../components/dashboard.tsx"), /^\s*TO REVIEW\s*$/m);
  const feed = read("../components/local-classroom-feed.tsx");
  assert.match(feed, /^\s*OFF\s*$/m);
  assert.doesNotMatch(feed, /Turn off/);
});

test("the TO REVIEW pill matches the header buttons and glows while someone waits", () => {
  const css = read("../components/workspace.css");
  const rule = css.match(/\.dashboard-shell \.review-link \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /height: 44px/);
  assert.doesNotMatch(rule, /border:/);
  const waiting = css.match(/\.dashboard-shell \.review-link\.has-items \{[^}]*\}/)?.[0] ?? "";
  assert.match(waiting, /0 0 22px 2px var\(--ws-glow\)/);
  assert.doesNotMatch(waiting, /background:/);
});

test("coming back to the camera page does not hang on Connecting", () => {
  const feed = read("../components/local-classroom-feed.tsx");
  // The image's own state decides: a stream that already has a frame is live even when the
  // browser does not fire the load event again for it.
  assert.match(feed, /image\.current\.naturalWidth > 0\) setConnection\("live"\)/);
  assert.match(feed, /ref=\{image\}/);
  assert.match(feed, /setInterval\(look, 250\)/);
});

test("with no activity running, the people list says so instead of 'The camera is off'", () => {
  const dashboard = read("../components/dashboard.tsx");
  const controls = read("../components/session-controls.tsx");
  // The dashboard listens for the same label the session controls send.
  const label = dashboard.match(/const NO_ACTIVITY = "([^"]+)"/)?.[1] ?? "";
  assert.ok(label);
  assert.ok(controls.includes(`"${label}"`));
  assert.match(dashboard, /onActivity=\{setSessionActivity\}/);
  // The no-activity message comes before the camera-off fallback.
  const noActivity = dashboard.indexOf("No activity running. Pick one and press Start");
  const cameraOff = dashboard.indexOf("The camera is off.");
  assert.ok(noActivity > 0 && noActivity < cameraOff);
});
