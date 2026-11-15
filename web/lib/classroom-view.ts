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

/** Names for a short sentence: "Keith", "Keith and Evan", "Keith, Evan and 2 more". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const more = names.length - 2;
  return `${names[0]}, ${names[1]} and ${more} more`;
}

/**
 * What Attention (and the To review page) says when Cues has no pending
 * request. It only says "All clear" when the camera agrees: if the camera has
 * flagged someone in view who has no request (a near-miss, or the agent chose
 * to keep watching, or its call failed), it names them instead, so the
 * teacher still sees the child's camera status and the cards never contradict
 * an "All clear".
 */
export function clearLine(
  flagged: readonly string[],
  page: "classroom" | "review",
): { text: string; flagged: boolean } {
  if (flagged.length === 0)
    return {
      text:
        page === "review"
          ? "All clear. No one needs you right now."
          : "All clear. Cues will ask when someone may need you.",
      flagged: false,
    };
  const who = nameList(flagged);
  return {
    text: `No requests yet. The camera flagged ${who} for a look.`,
    flagged: true,
  };
}
