import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeatState } from "./dashboard.ts";

export type FlagDecision = "confirmed" | "dismissed";
/** Browser projection of shared.contracts.TeacherFlagDecision. */
export type TeacherFlagDecision = Readonly<{
  id: string;
  session_id: string;
  seat_id: string;
  activity_id: string;
  session_revision: number;
  observed_at: string;
  decision: FlagDecision;
  decided_at: string;
  teacher_id: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /(Z|[+-]\d\d:\d\d)$/i.test(value) &&
  Number.isFinite(Date.parse(value));

export const FLAG_DECISION_ERRORS = {
  signIn: "Sign in as the teacher who started this session to record your answer.",
  changed: "This flag changed or was already answered. Refresh before deciding again.",
  failed: "Could not save your answer. Refresh to check its status before trying again.",
} as const;

/** One atomic RPC; never replace a failed decision with a generic review mark. */
export async function recordFlagDecision(
  client: SupabaseClient,
  observation: SeatState,
  decision: FlagDecision,
  requestId: string,
): Promise<TeacherFlagDecision> {
  if (!UUID.test(requestId) || !UUID.test(observation.session_id) ||
    !ID.test(observation.seat_id) || !observation.activity_id || !ID.test(observation.activity_id) ||
    !Number.isInteger(observation.session_revision) || (observation.session_revision ?? -1) < 0 ||
    !timestamp(observation.updated_at) || !["review", "needs_help"].includes(observation.status) ||
    !["confirmed", "dismissed"].includes(decision)) throw new Error(FLAG_DECISION_ERRORS.changed);
  let response;
  try {
    response = await client.rpc("record_teacher_flag_decision", {
      p_decision_id: requestId,
      p_session_id: observation.session_id,
      p_seat_id: observation.seat_id,
      p_activity_id: observation.activity_id,
      p_expected_revision: observation.session_revision,
      p_observed_at: observation.updated_at,
      p_decision: decision,
    }).abortSignal(AbortSignal.timeout(12000));
  } catch {
    throw new Error(FLAG_DECISION_ERRORS.failed);
  }
  if (response.error?.code === "42501") throw new Error(FLAG_DECISION_ERRORS.signIn);
  if (["22023", "40001"].includes(response.error?.code ?? ""))
    throw new Error(FLAG_DECISION_ERRORS.changed);
  const row = response.data as TeacherFlagDecision | null;
  if (response.error || !row || row.id !== requestId || row.session_id !== observation.session_id ||
    row.seat_id !== observation.seat_id || row.activity_id !== observation.activity_id ||
    row.session_revision !== observation.session_revision || row.decision !== decision ||
    !UUID.test(row.teacher_id) || !timestamp(row.decided_at) || !timestamp(row.observed_at) ||
    Date.parse(row.observed_at) !== Date.parse(observation.updated_at))
    throw new Error(FLAG_DECISION_ERRORS.failed);
  return row;
}
