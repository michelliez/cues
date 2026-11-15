import type { SupabaseClient } from "@supabase/supabase-js";
import { parseTeacherReviews, type TeacherReview } from "./teacher-reviews.ts";

export type ReviewResolution = "confirmed" | "dismissed";

/** Trusted action boundary: backend maps confirmed/dismissed to the existing store methods.
 * Deployment must authorize teacher scope and enforce the pending-only transition.
 */
export async function resolveTeacherReview(
  client: SupabaseClient,
  review: TeacherReview,
  status: ReviewResolution,
): Promise<TeacherReview> {
  if (review.status !== "pending")
    throw new Error("This review is already resolved. Refresh the queue.");
  if (status !== "confirmed" && status !== "dismissed")
    throw new Error("Invalid review action.");
  try {
    const { data, error } = await client
      .rpc("resolve_teacher_review", {
        review_id: review.id,
        action: status,
      })
      .abortSignal(AbortSignal.timeout(12000));
    if (error) throw error;
    const rows = parseTeacherReviews(data);
    const result = rows[0];
    if (
      rows.length !== 1 ||
      result.id !== review.id ||
      result.status !== status ||
      !result.resolved_at
    )
      throw new Error("Unconfirmed transition");
    return result;
  } catch {
    throw new Error(
      "Could not save this review action. Refresh the queue to check its status before trying again.",
    );
  }
}
