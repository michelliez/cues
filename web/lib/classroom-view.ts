/** What the classroom's student row and the To review cards show, as pure
 * functions so they are tested without rendering. Statuses come from the
 * backend; nothing here scores or ranks a student. */

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
 * How many people are waiting on the teacher: people with a pending
 * teacher_review, and nobody else. A camera or progress status never adds
 * anyone. 0 until the review feed is live.
 */
export function waitingCount(
  live: boolean,
  groups: readonly { seat_id: string }[],
): number {
  return live ? groups.length : 0;
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
