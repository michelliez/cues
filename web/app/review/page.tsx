import { redirect } from "next/navigation";
import { isEnabled } from "@/lib/flags";
import Dashboard from "@/components/dashboard";
import { garamond } from "@/components/workspace-fonts";
import "@/components/workspace.css";

// The To review page (web.review_page): everyone Cues asked about, one card
// each, with the teacher's decision in reach. It is the classroom dashboard in
// its review view, so it reads the same data and stays in sync with it.
export default async function ReviewPage() {
  if (!isEnabled("web.review_page") || !isEnabled("web.dashboard"))
    redirect("/dashboard");
  return (
    <div className={`workspace ${garamond.variable}`}>
      <Dashboard
        view="review"
        reviewPageEnabled
        liveProgressEnabled={isEnabled("web.live_progress")}
        personObservationsEnabled={isEnabled("web.person_observations")}
        sessionControlsEnabled={isEnabled("web.session_controls")}
        stationId={process.env.CUES_STATION_OVERRIDE ?? ""}
        reviewsEnabled={isEnabled("web.teacher_reviews")}
        reviewActionsEnabled={isEnabled("web.teacher_review_actions")}
        teacherLoginEnabled={isEnabled("web.teacher_login")}
        themeToggleEnabled={isEnabled("web.theme_toggle")}
        visionStationConfigEnabled={isEnabled("web.vision_station_config")}
        interventionsEnabled={isEnabled("web.interventions")}
      />
    </div>
  );
}
