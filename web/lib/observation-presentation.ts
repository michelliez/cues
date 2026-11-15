import { evaluatedProgress } from "./progress-context.ts";
import { statuses, type SeatState } from "./dashboard.ts";

export const OBSERVATION_STALE_MS = 5000;
/** How far ahead of the page's clock an observation may be and still count
 * as fresh. The page clock ticks once a second while the camera reports about
 * once a second, and the station and dashboard can be different laptops, so a
 * row slightly "in the future" is normal. Beyond this it is treated as a bad
 * clock and paused. */
export const OBSERVATION_FUTURE_SKEW_MS = 2000;
export type ObservationOptions = {
  enabled: boolean;
  now: number | null;
  connected: boolean;
};
/** Whether the station camera reported this person within the last five seconds. */
export function isFresh(
  state: SeatState | null,
  options?: ObservationOptions,
): boolean {
  if (!state) return false;
  if (!options?.enabled) return true;
  const observedAt = Date.parse(state.updated_at);
  return (
    options.connected &&
    options.now !== null &&
    Number.isFinite(observedAt) &&
    observedAt <= options.now + OBSERVATION_FUTURE_SKEW_MS &&
    options.now - observedAt < OBSERVATION_STALE_MS
  );
}
/** People shown on the dashboard are the people the camera sees right now. */
export function inCameraView(
  state: SeatState | null,
  options?: ObservationOptions,
): boolean {
  return isFresh(state, options) && state?.status !== "tracking_lost";
}
/** Display freshness only. Never changes task/review state or calculates stalled_seconds. */
export function observationPresentation(
  state: SeatState | null,
  options?: ObservationOptions,
) {
  const empty = {
    label: "Awaiting observation",
    detail: "No observation has been received.",
    score: null,
    currentStatus: null,
    unavailable: true,
  };
  if (!state) return empty;
  const hidden = (label: string, detail: string) => ({
    ...empty,
    label,
    detail,
  });
  if (options?.enabled) {
    if (!isFresh(state, options))
      return hidden(
        "Updates paused",
        "No fresh observation is available. The last observation is shown below.",
      );
    if (state.status === "tracking_lost")
      return hidden(
        "Tracking lost",
        "This position is no longer being tracked. This is not a failed attempt.",
      );
    if (state.tracking_valid === false)
      return hidden(
        "Tracking unavailable",
        "Tracking is unavailable for this observation. This is not a failed attempt.",
      );
    if (state.tracking_valid !== true)
      return hidden(
        "Tracking unknown",
        "Tracking validity has not been provided for this observation.",
      );
  }
  const evaluated = evaluatedProgress(state, options?.now ?? undefined);
  // Vision may still write review / needs_help. Those are observations about
  // the task, never a decision that the teacher should step in: only a pending
  // teacher_review (written by the agent) does that. So they read neutrally here.
  const raw = state.status === "review" || state.status === "needs_help";
  const neutral = raw
    ? {
        label: "Low task match",
        detail:
          "The task isn’t matching right now. This is an observation, not a request for support.",
      }
    : statuses[state.status];
  return {
    label: evaluated?.trend === "stalled" ? "Stalled" : evaluated?.trend === "improving" ? "Improving" : neutral.label,
    detail: evaluated?.trend === "stalled" ? "Valid task observations show sustained lack of progress." : neutral.detail,
    score: state.status === "tracking_lost" ? null : state.task_score,
    currentStatus: state.status,
    unavailable: state.status === "tracking_lost",
  };
}
