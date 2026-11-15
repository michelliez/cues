"use client";

import type { ReactNode } from "react";
import {
  evidenceLabels,
  teacherRationale,
  type TeacherReview,
} from "@/lib/teacher-reviews";
import { initials } from "@/components/workspace-rows";
import { WorkspaceIcon } from "@/components/workspace-icon";

// One person on the To review page: who, which task, when, and the teacher's
// decision in reach. The agent's own words wait behind "Why?", as on the
// classroom page. No expression labels or scores are shown.
const clock = (at: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

export function ReviewCard({
  headingId,
  index,
  name,
  issue,
  review,
  elevated,
  decisions,
  mark,
}: {
  /** Id for the name heading, so focus can return to this card. */
  headingId: string;
  /** Position in the queue, from 1. */
  index: number;
  name: string;
  /** What the request is about, from reviewIssueLine (activity, "not in view",
   * request count). */
  issue: string;
  /** The person's most urgent pending review. */
  review: TeacherReview;
  elevated: boolean;
  /** Support needed / No support needed, when decisions can be saved. */
  decisions: ReactNode;
  /** Mark as reviewed, or its confirmation. */
  mark: ReactNode;
}) {
  return (
    <li className="review-card" data-elevated={elevated || undefined}>
      <span className="review-index" aria-hidden="true">
        {String(index).padStart(2, "0")}
      </span>
      <span className="row-avatar is-ring is-large" aria-hidden="true">
        {initials(name)}
      </span>
      <div className="review-card-body">
        <div className="review-card-title">
          <h2 id={headingId} tabIndex={-1}>
            {name}
          </h2>
          {elevated ? <span className="status-pill is-review">Urgent</span> : null}
        </div>
        <p className="review-issue">{issue}</p>
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
      </div>
      <div className="review-card-actions">
        {decisions}
        {mark}
      </div>
      <time className="review-card-time" dateTime={review.created_at}>
        {clock(review.created_at)}
      </time>
    </li>
  );
}
