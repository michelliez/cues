import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CAMERA_NO_FRAMES,
  CAMERA_UNAVAILABLE,
  FEED_PAUSED,
  NO_OBSERVATIONS,
  VISION_UNAVAILABLE,
  emptyPeopleMessage,
  type LocalVisionReading,
} from "../lib/camera-health.ts";

const vision = (over: Partial<Extract<LocalVisionReading, { reachable: true }>> = {}) =>
  ({
    reachable: true,
    cameraOpen: true,
    frameAgeSeconds: 0.1,
    stationId: "S1",
    pinned: false,
    stationBusy: false,
    ...over,
  }) as LocalVisionReading;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("1. camera open with a fresh frame and no observations never says the camera is off", () => {
  const message = emptyPeopleMessage({ vision: vision(), localReadable: true, feedConnected: true });
  assert.equal(message, NO_OBSERVATIONS);
  assert.doesNotMatch(message, /camera is off|no one is/i); // no person count to claim from
});

test("2. camera_open=false reads Camera unavailable; open but no recent frame reads not delivering", () => {
  assert.equal(
    emptyPeopleMessage({ vision: vision({ cameraOpen: false }), localReadable: true, feedConnected: true }),
    CAMERA_UNAVAILABLE,
  );
  assert.match(CAMERA_UNAVAILABLE, /^Camera unavailable/);
  for (const frameAgeSeconds of [null, 9]) {
    assert.equal(
      emptyPeopleMessage({ vision: vision({ frameAgeSeconds }), localReadable: true, feedConnected: true }),
      CAMERA_NO_FRAMES,
    );
  }
});

test("3. an unreachable local health service reads Local vision unavailable", () => {
  assert.equal(
    emptyPeopleMessage({ vision: { reachable: false }, localReadable: true, feedConnected: true }),
    VISION_UNAVAILABLE,
  );
  assert.match(VISION_UNAVAILABLE, /^Local vision unavailable/);
});

test("4. a disconnected observation feed reads as updates paused, separate from the camera", () => {
  assert.equal(
    emptyPeopleMessage({ vision: vision(), localReadable: true, feedConnected: false }),
    FEED_PAUSED,
  );
  assert.match(FEED_PAUSED, /^Observation updates paused/);
  // The camera's own facts still win: a closed camera is not blamed on the feed.
  assert.equal(
    emptyPeopleMessage({ vision: vision({ cameraOpen: false }), localReadable: true, feedConnected: false }),
    CAMERA_UNAVAILABLE,
  );
  // A page that can't read this laptop says nothing about the camera.
  assert.equal(
    emptyPeopleMessage({ vision: null, localReadable: false, feedConnected: true }),
    NO_OBSERVATIONS,
  );
  assert.equal(
    emptyPeopleMessage({ vision: null, localReadable: false, feedConnected: false }),
    FEED_PAUSED,
  );
});

test("5. fresh observations still list people; the message is only for an empty row", () => {
  const dash = read("../components/dashboard.tsx");
  assert.match(dash, /empty=\{inView\.length === 0 \? peopleEmpty : null\}/);
  // The camera wording comes from the shared health reading, never from row freshness.
  assert.match(dash, /vision: localVision\.vision/);
  assert.doesNotMatch(dash, /The camera is off|cameraReporting/);
  // One poll serves the strip and the message.
  assert.match(dash, /local=\{localVision\}/);
  assert.equal((read("../components/camera-health-strip.tsx").match(/readLocalVision/g) ?? []).length, 0);
});
