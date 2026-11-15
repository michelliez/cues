"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { observationPresentation } from "@/lib/observation-presentation";
import {
  evidenceLabels,
  reviewPrompt,
  teacherRationale,
  type TeacherReview,
} from "@/lib/teacher-reviews";
import { TeacherReviewActions } from "@/components/teacher-review-actions";
import { WorkspaceIcon } from "@/components/workspace-icon";

// One person, opened in place in the class list: their status in plain words
// and Cues' request if there is one. Model details (its own words and what it
// looked at) wait behind "Why?". No expression labels or scores are shown; the
// rationale is the agent's own text, written under its no-diagnosis rules.
function clock(at: string) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function PersonDetails({
  id,
  presentation,
  reviews,
  stale,
  client,
  onResolved,
  actions,
  interventionsEnabled = false,
}: {
  id: string;
  /** Null when the camera has no row for this person right now. */
  presentation: ReturnType<typeof observationPresentation> | null;
  /** This person's pending reviews, most urgent first. */
  reviews: readonly TeacherReview[];
  stale: boolean;
  /** Present only when review decisions can be saved. */
  client: SupabaseClient | null;
  onResolved: (review: TeacherReview) => void;
  /** "Mark as reviewed", shown only with a pending review. */
  actions?: React.ReactNode;
  /** web.interventions */
  interventionsEnabled?: boolean;
}) {
  const review = reviews[0];
  return (
    <div className="row-more" id={id}>
      <p className="person-status">
        {presentation ? presentation.detail : "Not in view right now."}
      </p>
      {review ? (
        <div className="person-request">
          <p className="ws-caption">
            Cues asked · {clock(review.created_at)}
            {review.priority === "elevated" ? " · Urgent" : ""}
          </p>
          <div className="review-copy">
            <p className="review-prompt-title">{reviewPrompt.title}</p>
            <p className="review-prompt-detail">{reviewPrompt.detail}</p>
          </div>
          {stale ? (
            <p className="person-note" role="status">
              Reconnecting… this may have changed.
            </p>
          ) : null}
          {client ? (
            <TeacherReviewActions
              key={review.id}
              client={client}
              review={review}
              onResolved={onResolved}
              interventionsEnabled={interventionsEnabled}
            />
          ) : (
            <p className="person-note">
              Recording your decision isn’t turned on here.
            </p>
          )}
          <details className="person-why">
            <summary>
              Why did Cues ask?
              <WorkspaceIcon name="chevronDown" />
            </summary>
            <p>{teacherRationale(review.rationale)}</p>
            {review.evidence_used.length ? (
              <p className="ws-caption">
                Based on{" "}
                {review.evidence_used
                  .map((source) => evidenceLabels[source].toLowerCase())
                  .join(", ")}
              </p>
            ) : null}
          </details>
          {actions}
          {reviews.length > 1 ? (
            <p className="person-note">
              {reviews.length - 1} more after this one.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
