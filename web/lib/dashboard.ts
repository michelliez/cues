/** Read projections of PRD §17; status names mirror shared/contracts.py. */
export const statuses = {
  idle: {
    label: "Ready",
    detail: "Waiting for the activity to start.",
    tone: "neutral",
  },
  in_progress: {
    label: "Working",
    detail: "The activity is underway.",
    tone: "active",
  },
  review: {
    label: "Needs Review",
    detail: "An uncertain result needs a teacher’s review.",
    tone: "review",
  },
  done: {
    label: "Completed",
    detail: "The activity is complete.",
    tone: "done",
  },
  needs_help: {
    label: "Needs Review",
    detail: "Task state indicates support is needed.",
    tone: "review",
  },
  tracking_lost: {
    label: "Tracking Lost",
    detail: "Observation is unavailable. This is not a failed attempt.",
    tone: "neutral",
  },
} as const;

export type SeatStatus = keyof typeof statuses;
export type Seat = {
  id: string;
  station_id: string;
  side: string | null;
  display_name: string;
  is_simulated: boolean;
};
export type SeatState = {
  seat_id: string;
  session_id: string;
  activity_id: string | null;
  status: SeatStatus;
  task_score: number | null;
  tracking_valid?: boolean | null;
  expression_context?: {
    label: string;
    probability: number;
    duration_seconds?: number | null;
    supporting_only: true;
  } | null;
  session_revision?: number | null;
  evaluated_progress?: unknown;
  updated_at: string;
};
export type Activity = { id: string; name: string };
export type Station = { id: string; name: string };
export type Snapshot = {
  seats: Seat[];
  states: SeatState[];
  activities: Activity[];
  stations: Station[];
};
export type SeatView = Seat & { activity: string; state: SeatState | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid dashboard data");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Missing dashboard field");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function rows<T>(
  value: unknown,
  parse: (row: Record<string, unknown>) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error("Expected dashboard rows");
  return value.map((row) => parse(record(row)));
}

export function parseSnapshot(
  input: {
    seats: unknown;
    states: unknown;
    activities: unknown;
    stations: unknown;
  },
  readTracking = false,
): Snapshot {
  return {
    seats: rows(input.seats, (r) => {
      if (typeof r.is_simulated !== "boolean")
        throw new Error("Missing simulation label");
      return {
        id: text(r.id),
        station_id: text(r.station_id),
        side: nullableText(r.side),
        display_name: text(r.display_name),
        is_simulated: r.is_simulated,
      };
    }),
    states: rows(input.states, (r) => {
      const status = text(r.status);
      if (!Object.hasOwn(statuses, status))
        throw new Error("Unknown seat status");
      if (
        readTracking &&
        r.tracking_valid != null &&
        typeof r.tracking_valid !== "boolean"
      )
        throw new Error("Invalid tracking validity");
      const score = r.task_score;
      const expression = r.expression_context;
      if (readTracking && expression != null) {
        const e = record(expression);
        if (!['anger', 'contempt', 'disgust', 'fear', 'happiness', 'neutral', 'sadness', 'surprise'].includes(String(e.label)) ||
            typeof e.probability !== 'number' || !Number.isFinite(e.probability) ||
            e.probability < 0 || e.probability > 1 || e.supporting_only !== true ||
            (e.duration_seconds != null && (typeof e.duration_seconds !== 'number' ||
             !Number.isFinite(e.duration_seconds) || e.duration_seconds < 0)))
          throw new Error('Invalid expression context');
      }
      if (
        score !== null &&
        (typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1)
      )
        throw new Error("Invalid match score");
      const updated = text(r.updated_at);
      if (!Number.isFinite(Date.parse(updated)))
        throw new Error("Invalid observation timestamp");
      return {
        seat_id: text(r.seat_id),
        session_id: text(r.session_id),
        activity_id: nullableText(r.activity_id),
        status: status as SeatStatus,
        task_score: score,
        ...(readTracking
          ? {
              tracking_valid:
                typeof r.tracking_valid === "boolean" ? r.tracking_valid : null,
              expression_context: (expression ?? null) as SeatState['expression_context'],
            }
          : {}),
        session_revision: typeof r.session_revision === "number" ? r.session_revision : null,
        evaluated_progress: r.evaluated_progress ?? null,
        updated_at: updated,
      };
    }),
    activities: rows(input.activities, (r) => ({
      id: text(r.id),
      name: text(r.name),
    })),
    stations: rows(input.stations, (r) => ({
      id: text(r.id),
      name: text(r.name),
    })),
  };
}

export function seatViews(snapshot: Snapshot): SeatView[] {
  const states = new Map(snapshot.states.map((s) => [s.seat_id, s]));
  const activities = new Map(snapshot.activities.map((a) => [a.id, a.name]));
  const order = (side: string | null) =>
    side === "left" ? 0 : side === "right" ? 1 : 2;
  const personStations = new Set(
    snapshot.seats
      .filter((seat) => states.has(seat.id) && /^.+-P\d+$/.test(seat.id))
      .map((seat) => seat.station_id),
  );
  return snapshot.seats
    .filter((seat) => {
      const person = /^.+-P\d+$/.test(seat.id);
      // Person metadata alone is not an observation. Retire legacy fixed seats
      // for a station once its person pipeline supplies actual state rows.
      return person
        ? states.has(seat.id)
        : !personStations.has(seat.station_id);
    })
    .map((seat) => {
      const state = states.get(seat.id) ?? null;
      return {
        ...seat,
        state,
        activity: state?.activity_id
          ? (activities.get(state.activity_id) ?? "Activity unavailable")
          : "No activity assigned",
      };
    })
    .sort(
      (a, b) =>
        a.station_id.localeCompare(b.station_id) ||
        order(a.side) - order(b.side) ||
        a.id.localeCompare(b.id),
    );
}

