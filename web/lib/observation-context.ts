import type { Snapshot, SeatState } from "./dashboard.ts";
import type { SessionSnapshot } from "./session-controls.ts";

/**
 * The context a row must belong to before it is shown as a current task observation: the
 * same (session, activity, revision) the agent checks. It comes from the authoritative
 * session snapshot (read_station_session: session.id, current_activity_id, revision), never
 * from the station-runtime acknowledgement.
 *
 *   unmanaged  session controls are off here: there is no context to check against, so rows
 *              are shown as before.
 *   loading    the session has not been read (or is being re-read): nothing is current.
 *   none       no active session or no activity: nothing is current.
 *   active     rows must match all three values. Nothing is a wildcard; revision 0 is valid.
 */
export type ObservationContext =
  | { kind: "unmanaged" }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "active"; sessionId: string; activityId: string; revision: number };

export const UNMANAGED: ObservationContext = { kind: "unmanaged" };

export function contextFromSnapshot(snapshot: SessionSnapshot | null): ObservationContext {
  if (!snapshot) return { kind: "loading" };
  const session = snapshot.session;
  if (!session || session.ended_at || !session.current_activity_id) return { kind: "none" };
  return {
    kind: "active",
    sessionId: session.id,
    activityId: session.current_activity_id,
    revision: session.revision,
  };
}

/** May this row be shown as a current observation? (Freshness and tracking are checked after.) */
export function matchesContext(
  state: Pick<SeatState, "session_id" | "activity_id" | "session_revision"> | null | undefined,
  context: ObservationContext,
): boolean {
  if (context.kind === "unmanaged") return true;
  if (context.kind !== "active" || !state) return false;
  return (
    state.session_id === context.sessionId &&
    state.activity_id === context.activityId &&
    state.session_revision === context.revision
  );
}

/** The feed snapshot with only the rows that belong to the current context. Seats, names and
 * activities are untouched; a person with no matching row simply has no current observation. */
export function currentObservations(
  snapshot: Snapshot,
  context: ObservationContext,
): Snapshot {
  if (context.kind === "unmanaged") return snapshot;
  return { ...snapshot, states: snapshot.states.filter((state) => matchesContext(state, context)) };
}

/** What the student row says in place of a generic "no observations": the context, not the
 * camera, explains an empty row. Camera and feed messages (problems) are kept as they are. */
export function waitingMessage(
  base: string,
  neutral: string,
  context: ObservationContext,
): string {
  if (base !== neutral) return base; // a camera or feed problem outranks it
  if (context.kind === "active") return "Waiting for current observations";
  if (context.kind === "none") return "No activity is running. Start one to see observations.";
  if (context.kind === "loading") return "Loading the session…";
  return base;
}
