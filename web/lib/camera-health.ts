/**
 * The camera health strip: four plain facts about the classroom camera, each as a word,
 * so the page no longer says "The camera is off" for every cause.
 *
 * Inputs come from the local vision service (GET /health and /config on this laptop) and
 * from the station's rows. Nothing here reads camera frames, scores a student, or claims
 * anything about a child.
 */

export const LOCAL_VISION_BASE = "http://127.0.0.1:8000";
/** A frame older than this means the camera stopped delivering. */
export const FRAME_STALE_SECONDS = 3;
/** Updates older than this are not "arriving" any more (same window as observations). */
export const UPDATES_STALE_MS = 5000;

export type LocalVisionReading =
  | { reachable: false }
  | {
      reachable: true;
      cameraOpen: boolean;
      /** Seconds since the last frame, or null when none has arrived. */
      frameAgeSeconds: number | null;
      /** The station vision works for, or null when none is set. */
      stationId: string | null;
      /** Vision is pinned to a station by CUES_STATION_ID. */
      pinned: boolean;
      /** This laptop's camera is being refused because another camera holds the station. */
      stationBusy: boolean;
    };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Read this laptop's vision service. Unreachable means not running here (or refused). */
export async function readLocalVision(
  fetcher: Fetch = fetch,
  base: string = LOCAL_VISION_BASE,
): Promise<LocalVisionReading> {
  try {
    const init = {
      credentials: "omit" as const,
      signal: AbortSignal.timeout(2500),
    };
    const [health, config] = await Promise.all([
      fetcher(`${base}/health`, init),
      // /config may be refused at the network level; the camera facts still stand.
      fetcher(`${base}/config`, init).catch(() => null),
    ]);
    if (!health.ok) return { reachable: false };
    const h = (await health.json()) as Record<string, unknown>;
    // /config can refuse (older vision, other origin): the camera facts still stand.
    const c = config?.ok ? ((await config.json()) as Record<string, unknown>) : {};
    const age = h.frame_age_seconds;
    return {
      reachable: true,
      cameraOpen: h.camera_open === true,
      frameAgeSeconds: typeof age === "number" && Number.isFinite(age) ? age : null,
      stationId: text(c.station_id) ?? text(h.station_id),
      pinned: c.pinned === true,
      stationBusy: c.station_busy === true,
    };
  } catch {
    return { reachable: false };
  }
}

export type HealthTone = "good" | "warn" | "quiet";
export type HealthItem = {
  key: "camera" | "station" | "updates" | "other-camera";
  label: string;
  /** The state, in words. Color only supports it. */
  value: string;
  tone: HealthTone;
};

export type HealthInput = {
  /** null until the first reading comes back. */
  vision: LocalVisionReading | null;
  /** The station this dashboard shows. */
  station: string;
  /** Updates for this station reached the database within the last few seconds. */
  updatesFresh: boolean;
  /** Someone is in view right now. */
  inView: number;
  /** Another camera is being refused on this station (from the station's writer row). */
  conflict: boolean;
  /** This page may read the laptop's vision service. False on a hosted page (for
   * example cues.nyc on a phone): only the station's own rows are shown. */
  localReadable?: boolean;
};

export type CameraHealth = {
  items: HealthItem[];
  /** One sentence naming the single most useful thing, or null when all is well. */
  problem: string | null;
};

export const SERVICE_DOWN =
  "The camera service isn't running on this laptop. Start Cues with ./scripts/dev.sh.";
export const NO_STATION =
  "The camera has no classroom yet. It is set once you are signed in here.";
export const OTHER_STATION =
  "This laptop's camera is set to another classroom. Remove CUES_STATION_ID from the root .env.";
export const CAMERA_STOPPED =
  "The camera isn't sending pictures. Check the cable and that no other app is using it.";
export const NO_UPDATES =
  "The camera is on, but no updates are reaching your classroom. Start an activity, or check " +
  "that your session is running.";
export const OTHER_CAMERA =
  "Another camera is trying to use this station, so the extra one is paused. Close it, or " +
  "sign in on that laptop with its own account.";

/** The four checks and the one thing worth telling the teacher, in order of cause. */
export function cameraHealth(input: HealthInput): CameraHealth {
  const { vision } = input;
  // A hosted page can't see this laptop's camera service: show only what the
  // station's rows say, and never claim the service is down.
  if (input.localReadable === false) {
    const refused = input.conflict;
    return {
      items: [
        updatesItem(input),
        {
          key: "other-camera",
          label: "Other cameras",
          value: refused ? "One refused" : "None",
          tone: refused ? "warn" : "good",
        },
      ],
      problem: refused ? OTHER_CAMERA : null,
    };
  }
  const checking: HealthItem[] = [
    { key: "camera", label: "Camera", value: "Checking", tone: "quiet" },
    { key: "station", label: "Classroom", value: "Checking", tone: "quiet" },
    { key: "updates", label: "Updates", value: "Checking", tone: "quiet" },
    { key: "other-camera", label: "Other cameras", value: "Checking", tone: "quiet" },
  ];
  // A refused camera is already known from the station's row: say so at once.
  if (vision === null)
    return input.conflict
      ? {
          items: checking.map((item) =>
            item.key === "other-camera"
              ? { ...item, value: "One refused", tone: "warn" as const }
              : item,
          ),
          problem: OTHER_CAMERA,
        }
      : { items: checking, problem: null };

  const otherCamera: HealthItem = {
    key: "other-camera",
    label: "Other cameras",
    value: input.conflict || (vision.reachable && vision.stationBusy) ? "One refused" : "None",
    tone: input.conflict || (vision.reachable && vision.stationBusy) ? "warn" : "good",
  };
  const refused = otherCamera.tone === "warn";

  if (!vision.reachable) {
    return {
      items: [
        { key: "camera", label: "Camera", value: "Not running here", tone: "warn" },
        { key: "station", label: "Classroom", value: "Unknown", tone: "quiet" },
        updatesItem(input),
        otherCamera,
      ],
      problem: refused ? OTHER_CAMERA : SERVICE_DOWN,
    };
  }

  const delivering =
    vision.cameraOpen &&
    vision.frameAgeSeconds !== null &&
    vision.frameAgeSeconds <= FRAME_STALE_SECONDS;
  const camera: HealthItem = delivering
    ? { key: "camera", label: "Camera", value: "On", tone: "good" }
    : {
        key: "camera",
        label: "Camera",
        value: vision.cameraOpen ? "No pictures" : "Off",
        tone: "warn",
      };
  const station: HealthItem =
    vision.stationId === null
      ? { key: "station", label: "Classroom", value: "Not set", tone: "warn" }
      : vision.stationId === input.station
        ? { key: "station", label: "Classroom", value: "Set", tone: "good" }
        : { key: "station", label: "Classroom", value: "Another one", tone: "warn" };
  const updates = updatesItem(input);

  // The most useful cause first: a refused camera explains the rest.
  let problem: string | null = null;
  if (refused) problem = OTHER_CAMERA;
  else if (station.tone === "warn")
    problem = vision.stationId === null ? NO_STATION : OTHER_STATION;
  else if (camera.tone === "warn") problem = CAMERA_STOPPED;
  else if (updates.tone === "warn") problem = NO_UPDATES;
  return { items: [camera, station, updates, otherCamera], problem };
}

function updatesItem(input: HealthInput): HealthItem {
  if (input.updatesFresh)
    return {
      key: "updates",
      label: "Updates",
      value: input.inView > 0 ? "Arriving" : "Arriving, no one in view",
      tone: "good",
    };
  // Vision writes only for people it sees, so an empty room also has no updates.
  // That is only a problem when the camera is on and someone should be there.
  return {
    key: "updates",
    label: "Updates",
    value: "Not arriving",
    tone: input.vision?.reachable ? "warn" : "quiet",
  };
}

/** Whether any station row was written recently (the database accepted a write). */
export function updatesFresh(
  updatedAt: readonly (string | null | undefined)[],
  now: number,
): boolean {
  return updatedAt.some((value) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at <= now + 2000 && now - at < UPDATES_STALE_MS;
  });
}

export type HealthSummary = { tone: HealthTone; label: string };

/**
 * One word for the collapsed strip: amber when any check warns or another camera
 * is refused, grey while a check has not come back yet, green otherwise. (The
 * page counts people in view from the same rows as "updates", so it can't tell an
 * empty room from a stopped session; with the camera on and nothing arriving,
 * the sentence asks the teacher to start an activity.)
 */
export function healthSummary(health: CameraHealth): HealthSummary {
  if (health.items.some((item) => item.tone === "warn") || health.problem === OTHER_CAMERA)
    return { tone: "warn", label: "Needs a look" };
  if (health.items.some((item) => item.value === "Checking"))
    return { tone: "quiet", label: "Checking" };
  // A hosted page can't see the camera: with nothing arriving, say that rather
  // than "All good".
  if (health.items.some((item) => item.tone === "quiet"))
    return { tone: "quiet", label: "No updates" };
  return { tone: "good", label: "All good" };
}

export const VISION_UNAVAILABLE = "Local vision unavailable. Start Cues with ./scripts/dev.sh.";
export const CAMERA_UNAVAILABLE = "Camera unavailable. Check the cable and that no other app is using it.";
export const CAMERA_NO_FRAMES = "Camera not delivering frames.";
export const FEED_PAUSED = "Observation updates paused. Reconnecting…";
export const NO_OBSERVATIONS = "No current person observations.";

/**
 * What the student row says when no one is listed. Each fact comes from its own source:
 * this laptop's vision service says whether it runs, the camera is open and frames are
 * arriving; the observation feed says whether updates are being received. An absence of
 * fresh rows alone never says the camera is off, and with a healthy camera it does not
 * claim whether anyone is in view (the service reports no person count).
 */
export function emptyPeopleMessage({
  vision,
  localReadable,
  feedConnected,
}: {
  /** The reading of this laptop's service, null until the first one. */
  vision: LocalVisionReading | null;
  /** False on a page that may not reach this laptop (a hosted page). */
  localReadable?: boolean | null;
  /** The observation feed (Supabase) is connected without error. */
  feedConnected: boolean;
}): string {
  if (localReadable !== false) {
    if (vision && !vision.reachable) return VISION_UNAVAILABLE;
    if (vision?.reachable) {
      if (!vision.cameraOpen) return CAMERA_UNAVAILABLE;
      if (vision.frameAgeSeconds === null || vision.frameAgeSeconds > FRAME_STALE_SECONDS)
        return CAMERA_NO_FRAMES;
    }
  }
  if (!feedConnected) return FEED_PAUSED;
  if (localReadable !== false && vision === null) return "Checking the camera…";
  return NO_OBSERVATIONS;
}
