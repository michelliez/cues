"use client";

import { useId, useState } from "react";
import { WorkspaceIcon } from "@/components/workspace-icon";
import {
  OTHER_CAMERA,
  cameraHealth,
  healthSummary,
  updatesFresh,
  type CameraHealth,
  type HealthSummary,
} from "@/lib/camera-health";
import type { LocalVisionState } from "@/lib/use-local-vision";

type CameraHealthProps = {
  station: string;
  /** updated_at of each person's latest row at this station. */
  updatedAt: readonly (string | null | undefined)[];
  inView: number;
  /** Another camera is being refused on this station (from its writer row). */
  conflict: boolean;
  /** The one reading of this laptop's vision service the dashboard polls (useLocalVision). */
  local: LocalVisionState;
};

/** The strip's live state: the shared vision reading plus the station's rows. */
function useCameraHealth({
  station,
  updatedAt,
  inView,
  conflict,
  local,
}: CameraHealthProps): { health: CameraHealth; summary: HealthSummary } {
  const health = cameraHealth({
    vision: local.vision,
    station,
    updatesFresh: updatesFresh(updatedAt, local.now),
    inView,
    conflict,
    localReadable: local.localReadable ?? undefined,
  });
  return { health, summary: healthSummary(health) };
}

/** The four checks, each a label and a word. */
function HealthPills({ health }: { health: CameraHealth }) {
  return (
    <ul>
      {health.items.map((item) => (
        <li key={item.key} className={`health-item is-${item.tone}`}>
          <span className="health-label">{item.label}</span>
          <span className="health-value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The one sentence. A refused camera always shows, even with the strip closed;
 * other causes show only inside it. */
function HealthProblem({ health, open }: { health: CameraHealth; open: boolean }) {
  if (!health.problem) return null;
  if (!open && health.problem !== OTHER_CAMERA) return null;
  return (
    <div className="health-problem-line">
      <p className="health-problem" role="status">
        {health.problem}
      </p>
    </div>
  );
}

// The team's camera checks, folded behind a round "more" button (three dots)
// that sits in the row with the activity controls. Its badge is green when all
// is good, amber when something needs a look, grey while checking; the four
// checks open beside it. A refused second camera is always spelled out.
export function CameraHealthStrip(props: CameraHealthProps) {
  const { health, summary } = useCameraHealth(props);
  const [open, setOpen] = useState(false);
  const pillsId = useId();
  return (
    <div className="health-strip">
      <div className="health-row">
        <button
          type="button"
          className="ws-icon-button health-more"
          aria-expanded={open}
          aria-controls={pillsId}
          aria-label={`Camera status: ${summary.label}`}
          title={`Camera status: ${summary.label}`}
          onClick={() => setOpen((value) => !value)}
        >
          <WorkspaceIcon name="more" />
          <span className={`health-dot is-${summary.tone}`} aria-hidden="true" />
        </button>
        <div id={pillsId} className="health-pills" hidden={!open}>
          <HealthPills health={health} />
        </div>
      </div>
      <HealthProblem health={health} open={open} />
    </div>
  );
}
