/** What the classroom's student row and the To review cards show, as pure
 * functions so they are tested without rendering. Statuses come from the
 * backend; nothing here scores or ranks a student. */

import type { SeatState } from "./dashboard.ts";
import type { TeacherReview } from "./teacher-reviews.ts";

/** Keep an answered camera flag out of the queue while vision consumes the
 * transaction's review mark. A different task/session or newer observation
 * must not be hidden by an old answer. */
export function withResolvedReviewMark(
  marked: ReadonlySet<string>,
  review: TeacherReview,
  observation: SeatState | null,
): Set<string> {
  const next = new Set(marked);
  if (
    (review.status === "confirmed" || review.status === "dismissed") &&
    review.resolved_at &&
    observation?.seat_id === review.seat_id &&
    observation.session_id === review.session_id &&
    observation.activity_id === review.activity_id &&
    Date.parse(observation.updated_at) <= Date.parse(review.resolved_at)
  ) next.add(review.seat_id);
  return next;
}

export type StripTone = "working" | "done" | "review" | "quiet";

/** The word on a student's own card while Cues has asked the teacher about
 * them. It names the teacher's queue ("check in"), never the student's state:
 * "attention" is the teacher's panel, not a claim about the child. */
export const CHECK_IN_LABEL = "Check in";

export type StripSource = {
  id: string;
  name: string;
  /** The status label from the observation, e.g. "Working". */
  label: string;
  tone: StripTone;
  activity: string;
};

export type StripEntry = StripSource & { status: string; selected: boolean };

/**
 * One card per person the camera sees, in the order given (left to right in
 * the frame). Anyone with a pending request reads "Check in" in the review
 * tone; everyone else keeps their own status. The activity shows only when
 * the class is on more than one.
 */
export function stripEntries(
  inView: readonly StripSource[],
  waiting: ReadonlySet<string>,
  selectedId: string | null,
  mixedActivities: boolean,
): StripEntry[] {
  return inView.map((person) => {
    const asked = waiting.has(person.id);
    return {
      ...person,
      status: asked ? CHECK_IN_LABEL : person.label,
      tone: asked ? "review" : person.tone,
      activity: mixedActivities ? person.activity : "",
      selected: selectedId === person.id,
    };
  });
}

/** The line under a name on a To review card, e.g. "Raise hand · not in
 * view · 2 requests". */
export function reviewIssueLine(
  activity: string,
  visible: boolean,
  count: number,
): string {
  return [
    activity,
    visible ? null : "not in view",
    count > 1 ? `${count} requests` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * People the camera has flagged (their row reads Needs Review) who have no
 * pending request from Cues yet, in the order given (web.review_waiting). The
 * agent may still be deciding, or its call may have failed; either way the
 * teacher sees them. Someone already marked reviewed is left out until vision
 * moves them back to working.
 */
export function flaggedWithoutRequest<T extends { id: string }>(
  people: readonly T[],
  flagged: (person: T) => boolean,
  asked: ReadonlySet<string>,
  marked: ReadonlySet<string>,
): T[] {
  return people.filter(
    (person) => flagged(person) && !asked.has(person.id) && !marked.has(person.id),
  );
}

/**
 * What To review counts and lists beyond Cues's requests. Off, or while the
 * review feed is not live, it is exactly as before: no extra people, and the
 * count is the number of people with requests (0 until the feed is live).
 */
export function reviewQueue<T extends { id: string }>({
  enabled,
  live,
  people,
  flagged,
  askedSeatIds,
  marked,
}: {
  enabled: boolean;
  live: boolean;
  people: readonly T[];
  flagged: (person: T) => boolean;
  askedSeatIds: readonly string[];
  marked: ReadonlySet<string>;
}): { flagged: T[]; count: number } {
  if (!live) return { flagged: [], count: 0 };
  const extra = enabled
    ? flaggedWithoutRequest(people, flagged, new Set(askedSeatIds), marked)
    : [];
  return { flagged: extra, count: askedSeatIds.length + extra.length };
}

/** Raw camera statuses that keep a person flagged (or may hide a flag: vision
 * restores Needs Review when a lost person comes back). */
const STILL_FLAGGED = new Set(["review", "needs_help", "tracking_lost"]);

/** How long a flagged person who dropped out of view keeps the companion
 * resting: vision's own release time for a person it lost (RELEASE_SECONDS in
 * vision/people.py). After that they are gone, not a queue that was cleared. */
export const DROP_REST_MS = 10_000;

/**
 * Flagged people who left the waiting count in the last few seconds without a
 * reason the teacher would recognise: not marked reviewed, no request now, and
 * the camera has not moved them on (their row still reads flagged or lost).
 * While any remain, the companion rests instead of "eating" a queue nobody
 * cleared. `row` is the seat's latest row, or undefined when the seat is no
 * longer listed (another classroom); `clock` is the page's time in ms, or null
 * when it is not ticking. Both of those count as resolved, and so does a row
 * older than DROP_REST_MS, so the rest always ends.
 */
export function unexplainedDrops(
  before: readonly string[],
  now: ReadonlySet<string>,
  {
    marked,
    asked,
    row,
    clock,
  }: {
    marked: ReadonlySet<string>;
    asked: ReadonlySet<string>;
    row: (id: string) => { status: string; updated_at: string } | undefined;
    clock: number | null;
  },
): string[] {
  return before.filter((id) => {
    if (now.has(id) || marked.has(id) || asked.has(id)) return false;
    const latest = row(id);
    if (!latest || clock === null || !STILL_FLAGGED.has(latest.status)) return false;
    const age = clock - Date.parse(latest.updated_at);
    return Number.isFinite(age) && age < DROP_REST_MS;
  });
}

/** Where this tab keeps the people marked reviewed, per classroom, so the
 * classroom and To review pages agree until the camera resets them. */
export const MARKED_KEY = "cues-marked-reviewed";

export function readMarked(storage: Storage, station: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(`${MARKED_KEY}:${station}`) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeMarked(
  storage: Storage,
  station: string,
  ids: Iterable<string>,
): void {
  const list = [...ids];
  const key = `${MARKED_KEY}:${station}`;
  if (list.length) storage.setItem(key, JSON.stringify(list));
  else storage.removeItem(key);
}

/** Forget every classroom's marks in this tab (on sign-out). */
export function forgetMarked(storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(MARKED_KEY)) storage.removeItem(key);
  }
}
