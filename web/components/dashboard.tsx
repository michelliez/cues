"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { seatViews, type SeatView } from "@/lib/dashboard";
import {
  INITIAL_REVIEWS,
  DISABLED_REVIEWS,
  watchTeacherReviews,
  type ReviewFeedState,
} from "@/lib/teacher-review-feed";
import {
  activityLabel,
  groupReviewsBySeat,
  type TeacherReview,
} from "@/lib/teacher-reviews";
import { watchDashboard, type FeedState } from "@/lib/dashboard-feed";
import {
  resolveDefaultStation,
  StationSignInRequired,
} from "@/lib/default-station";
import { createDashboardClient } from "@/lib/supabase";
import { startLocalVisionSync } from "@/lib/local-vision";
import { SessionControls } from "@/components/session-controls";
import LocalClassroomFeed from "@/components/local-classroom-feed";
import { PersonDetails } from "@/components/person-panel";
import { MarkReviewedButton } from "@/components/mark-reviewed-button";
import { TeacherReviewActions } from "@/components/teacher-review-actions";
import { CameraHealthStrip } from "@/components/camera-health-strip";
import { ReviewCompanion } from "@/components/review-companion";
import { ReviewCard } from "@/components/review-card";
import { StudentStrip } from "@/components/student-strip";
import { reviewIssueLine, stripEntries } from "@/lib/classroom-view";
import {
  CAMERA_CONFLICT_MESSAGE,
  cameraConflict,
  readStationWriter,
} from "@/lib/station-writer";
import {
  inCameraView,
  isFresh,
  observationPresentation,
  type ObservationOptions,
} from "@/lib/observation-presentation";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { WorkspaceIcon } from "@/components/workspace-icon";
import {
  ReviewRowContent,
  type PersonTone,
} from "@/components/workspace-rows";

// The companion is decorative and only shown signed out: load it on demand.
const Companion = dynamic(() => import("@/components/login-companion"), {
  ssr: false,
});

const ignoreActivity = () => {};
const INITIAL: FeedState = {
  snapshot: null,
  connection: "connecting",
  loading: true,
  error: null,
};
type Presentation = ReturnType<typeof observationPresentation>;
const statusTone = (presentation: Presentation): PersonTone =>
  presentation.needsReview
    ? "review"
    : presentation.currentStatus === "done"
      ? "done"
      : presentation.currentStatus === "in_progress"
        ? "working"
        : "quiet";

/** Who the dashboard is for: unknown until the sign-in check returns. */
type Account =
  | { state: "checking" }
  | { state: "signed-out" }
  | { state: "finding" }
  | { state: "ready"; station: string }
  | { state: "error"; message: string };

/** The signed-out classroom: one calm question, as on the sign-in page. */
function SignInCard() {
  return (
    <section className="ws-signin" aria-labelledby="signin-heading">
      <Companion size={96} />
      <h1 id="signin-heading">Sign in to see your classroom</h1>
      <p>Cues shows the people your classroom camera sees and who needs you.</p>
      <Link className="ws-pill is-dark" href="/login">
        Sign in
        <WorkspaceIcon name="arrow" />
      </Link>
    </section>
  );
}

export default function Dashboard({
  view = "classroom",
  reviewPageEnabled = false,
  liveProgressEnabled = false,
  personObservationsEnabled = false,
  sessionControlsEnabled = false,
  stationId = "",
  reviewsEnabled = false,
  reviewActionsEnabled = false,
  teacherLoginEnabled = false,
  themeToggleEnabled = false,
  hostedLocalFeedEnabled = false,
  companionEnabled = false,
  hostedDashboardOrigin = "https://cues.nyc",
  visionStationConfigEnabled = false,
  healthStripEnabled = false,
  interventionsEnabled = false,
  resetPeopleEnabled = false,
}: {
  /** "classroom" (the default) or "review", the To review page. */
  view?: "classroom" | "review";
  /** web.review_page: the To review page and its links. */
  reviewPageEnabled?: boolean;
  liveProgressEnabled?: boolean;
  personObservationsEnabled?: boolean;
  sessionControlsEnabled?: boolean;
  /** Explicit dev/test override (CUES_STATION_OVERRIDE). Normally empty: a signed-in
   * teacher's own default station is used. */
  stationId?: string;
  reviewsEnabled?: boolean;
  reviewActionsEnabled?: boolean;
  teacherLoginEnabled?: boolean;
  themeToggleEnabled?: boolean;
  hostedLocalFeedEnabled?: boolean;
  /** web.companion: the Cues companion on the To review pill. */
  companionEnabled?: boolean;
  hostedDashboardOrigin?: string;
  visionStationConfigEnabled?: boolean;
  /** web.health_strip: camera on/off, classroom set, updates arriving, other cameras. */
  healthStripEnabled?: boolean;
  /** web.interventions: the agent's suggested support, and approving one (migration 018). */
  interventionsEnabled?: boolean;
  /** web.reset_people: switching or restarting the activity puts everyone back to working. */
  resetPeopleEnabled?: boolean;
}) {
  const [observationNow, setObservationNow] = useState<number | null>(null);
  useEffect(() => {
    if (!personObservationsEnabled) return;
    const tick = () => setObservationNow(Date.now());
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    const visible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [personObservationsEnabled]);
  const [feed, setFeed] = useState<FeedState>(INITIAL);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [markedSeats, setMarkedSeats] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [reviews, setReviews] = useState<ReviewFeedState>(
    reviewsEnabled ? INITIAL_REVIEWS : DISABLED_REVIEWS,
  );
  const resolvedReviewIds = useRef(new Set<string>());
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [client] = useState(() => {
    try {
      return createDashboardClient(
        sessionControlsEnabled || teacherLoginEnabled || reviewActionsEnabled,
      );
    } catch {
      return null;
    }
  });
  const configurationError = client === null;
  // The station this dashboard is about: the override, else the signed-in teacher's own
  // default station (created on first sign-in). Empty while signed out or still loading.
  const stationOverride = stationId.trim();
  const resolvesStation =
    !stationOverride && (sessionControlsEnabled || teacherLoginEnabled);
  const [account, setAccount] = useState<Account>({ state: "checking" });
  const station =
    stationOverride || (account.state === "ready" ? account.station : "");
  // Tell this laptop's vision service the signed-in teacher's resolved station.
  // The result isn't shown as a caption: the camera card itself says when the
  // camera can't be reached.
  useEffect(() => {
    if (!visionStationConfigEnabled || !client || !station) return;
    return startLocalVisionSync(client, station);
  }, [client, station, visionStationConfigEnabled]);
  useEffect(() => {
    if (!client || !resolvesStation) return;
    let disposed = false;
    let latest = 0;
    const resolve = async (signedIn: boolean) => {
      const mine = ++latest;
      if (!signedIn) {
        setAccount({ state: "signed-out" });
        return;
      }
      setAccount({ state: "finding" });
      try {
        const found = await resolveDefaultStation(client);
        if (!disposed && mine === latest)
          setAccount({ state: "ready", station: found.id });
      } catch (cause) {
        if (disposed || mine !== latest) return;
        setAccount(
          cause instanceof StationSignInRequired
            ? { state: "signed-out" }
            : {
                state: "error",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Your classroom camera could not be loaded.",
              },
        );
      }
    };
    const initial = latest;
    // undefined until the first read: tab focus fires SIGNED_IN again for the
    // same teacher, which must not reset the classroom.
    let userId: string | null | undefined;
    void client.auth.getSession().then(({ data }) => {
      if (disposed || latest !== initial) return;
      userId = data.session?.user.id ?? null;
      void resolve(Boolean(data.session));
    });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      const next = session?.user.id ?? null;
      if (userId !== undefined && next === userId) return;
      userId = next;
      ++latest; // Immediately invalidate in-flight work for the previous identity.
      // A different account: never keep the previous teacher's station on screen.
      setAccount(session ? { state: "finding" } : { state: "signed-out" });
      // Defer: Supabase calls inside this callback can deadlock the auth lock.
      setTimeout(() => {
        if (!disposed) void resolve(Boolean(session));
      }, 0);
    });
    return () => {
      disposed = true;
      data.subscription.unsubscribe();
    };
  }, [client, resolvesStation]);
  const shownStation = useRef(station);
  useEffect(() => {
    // Another station (account switch, sign-out): drop the old station's rows now.
    if (shownStation.current === station) return;
    shownStation.current = station;
    queueMicrotask(() => {
      setFeed(INITIAL);
      setSelectedId(null);
      setReviews(reviewsEnabled ? INITIAL_REVIEWS : DISABLED_REVIEWS);
    });
  }, [station, reviewsEnabled]);
  useEffect(() => {
    if (!client) return;
    const subscription = watchDashboard(
      client,
      (state) => {
        if (personObservationsEnabled)
          setFeed((previous) => ({
            ...state,
            snapshot: station ? (state.snapshot ?? previous.snapshot) : null,
          }));
        else setFeed(state);
      },
      personObservationsEnabled,
      station,
      liveProgressEnabled,
    );
    const offline = () => subscription.disconnect();
    const online = () => setAttempt((n) => n + 1);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      subscription.dispose();
    };
  }, [attempt, client, personObservationsEnabled, station, liveProgressEnabled]);
  useEffect(() => {
    if (!client) return;
    const subscription = watchTeacherReviews(
      client,
      (state) =>
        setReviews({
          ...state,
          reviews:
            state.reviews?.filter(
              (review) => !resolvedReviewIds.current.has(review.id),
            ) ?? null,
        }),
      reviewsEnabled,
      station,
      interventionsEnabled,
    );
    const offline = () => subscription.disconnect();
    const online = () => setReviewAttempt((n) => n + 1);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      subscription.dispose();
    };
  }, [client, reviewsEnabled, reviewAttempt, station, interventionsEnabled]);

  const signedOut =
    teacherLoginEnabled && resolvesStation && account.state === "signed-out";
  // Without a station there is nothing to load yet: say why, not "error".
  const waitingForStation =
    resolvesStation && !station && !configurationError;

  // People are labelled as the backend names them (seats.display_name,
  // "Person 1", "Person 2"…): no made-up names.
  const seats = feed.snapshot ? seatViews(feed.snapshot) : [];
  const activityName = (id: string) =>
    activityLabel(
      id,
      feed.snapshot?.activities.find((item) => item.id === id)?.name,
    );
  const nameOf = (seatId: string) =>
    seats.find((seat) => seat.id === seatId)?.display_name ?? "A student";
  const observationOptions: ObservationOptions = {
    enabled: personObservationsEnabled,
    now: observationNow,
    connected: feed.connection === "connected" && !feed.error,
  };
  const present = (seat: SeatView) =>
    observationPresentation(seat.state, observationOptions);
  const queue = reviews.reviews ?? [];
  const reviewGroups = groupReviewsBySeat(queue);
  const reviewsFor = (seatId: string): TeacherReview[] =>
    reviewGroups.find((group) => group.seat_id === seatId)?.reviews ?? [];
  // People come from the camera: only those it sees right now are listed.
  const inView = seats.filter((seat) =>
    inCameraView(seat.state, observationOptions),
  );
  const cameraReporting = seats.some((seat) =>
    isFresh(seat.state, observationOptions),
  );
  const reviewsLive =
    reviewsEnabled &&
    !configurationError &&
    reviews.reviews !== null &&
    !reviews.error &&
    reviews.connection === "connected";
  const activityNames = [
    ...new Set(
      seats.filter((seat) => seat.state?.activity_id).map((s) => s.activity),
    ),
  ];
  // Each row names its task only when the class is on more than one.
  const mixedActivities = activityNames.length > 1;
  const observationActivity = !feed.snapshot
    ? "Waiting for the camera"
    : activityNames.length > 1
      ? "Several activities"
      : (activityNames[0] ?? "No activity yet");
  const sessionLive = Boolean(sessionControlsEnabled && client);
  // One camera per station: while a second camera is being refused (and paused), say so.
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!client || !station || !sessionControlsEnabled) return;
    let disposed = false;
    // One read at a time (a read can take up to 12s, the poll is 5s), so an
    // old answer never overwrites a newer one; a failed read keeps the last.
    let inFlight = false;
    // The last writer read; while reads fail it is re-checked against the
    // clock, so the warning still expires once the other camera goes quiet.
    let lastWriter: Awaited<ReturnType<typeof readStationWriter>> | null = null;
    const check = () => {
      if (lastWriter && !disposed)
        setConflict(cameraConflict(lastWriter, Date.now()));
      if (inFlight) return;
      inFlight = true;
      void readStationWriter(client, station)
        .then((writer) => {
          lastWriter = writer;
          if (!disposed) setConflict(cameraConflict(writer, Date.now()));
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      // Never carry one classroom's warning over to the next.
      setConflict(false);
    };
  }, [client, station, sessionControlsEnabled]);
  // With session controls, the activity picker itself shows the activity.
  const activity = observationActivity;

  // A mark lasts until vision reports the person out of review.
  // Read the raw status, not the on-screen one: a stale or paused observation
  // must not drop the mark before vision has actually reset the person.
  const stillFlagged = seats
    .filter(
      (seat) =>
        markedSeats.has(seat.id) &&
        (seat.state?.status === "review" || seat.state?.status === "needs_help"),
    )
    .map((seat) => seat.id)
    .join(",");
  useEffect(() => {
    const keep = new Set(stillFlagged ? stillFlagged.split(",") : []);
    queueMicrotask(() =>
      setMarkedSeats((previous) =>
        [...previous].every((id) => keep.has(id))
          ? previous
          : new Set([...previous].filter((id) => keep.has(id))),
      ),
    );
  }, [stillFlagged]);
  const waitingCount = reviewsLive ? reviewGroups.length : 0;
  // A person picked from the strip who has no request opens in the side
  // panel; someone with a request opens in place in the attention list.
  const selectedPerson =
    selectedId && reviewsFor(selectedId).length === 0
      ? (inView.find((seat) => seat.id === selectedId) ?? null)
      : null;
  // A request arrives for the person open in the side panel: the panel closes
  // and they open in the attention list, so carry focus to their row there.
  const panelPerson = useRef<string | null>(null);
  const panelId = selectedPerson?.id ?? null;
  useEffect(() => {
    const was = panelPerson.current;
    panelPerson.current = panelId;
    if (!was || panelId || selectedId !== was) return;
    if (!document.activeElement || document.activeElement === document.body)
      document
        .querySelector<HTMLButtonElement>(`.row-list [aria-controls="more-${was}"]`)
        ?.focus();
  }, [panelId, selectedId]);
  // Close the open person and return focus to what opened them: the card the
  // teacher pressed Escape on, else their row, else the list heading.
  const closeDetails = (returnTo?: HTMLElement | null) => {
    const id = selectedId;
    setSelectedId(null);
    requestAnimationFrame(() =>
      (returnTo?.isConnected
        ? returnTo
        : id
          ? document.querySelector<HTMLButtonElement>(`[aria-controls="more-${id}"]`)
          : listHeading.current
      )?.focus(),
    );
  };
  // After a decision or a mark: if the person has nothing left to show (no other
  // request and out of view), close their row so it can't reopen on its own later;
  // otherwise keep focus on their row, which may have moved to the other group.
  // The review feed failed or dropped: the notice says so, and no "All clear"
  // or "Checking…" shows under it.
  const reviewNotice =
    reviewsEnabled &&
    !configurationError &&
    Boolean(reviews.error || reviews.connection === "disconnected");
  const pageHeading = useRef<HTMLHeadingElement>(null);
  // Settle in a layout effect after the update that removed the review has
  // committed, so the count is never stale and focus lands before paint.
  const [settling, setSettling] = useState<{ seat: string } | null>(null);
  const settleRow = (seatId: string) => setSettling({ seat: seatId });
  useLayoutEffect(() => {
    if (!settling) return;
    const seatId = settling.seat;
    const remaining =
      reviewGroups.find((group) => group.seat_id === seatId)?.reviews.length ??
      0;
    if (view === "review") {
      // The card stays while the person has another request: keep focus on
      // it; otherwise the page title.
      (remaining
        ? document.getElementById(`review-card-${seatId}`)
        : pageHeading.current
      )?.focus();
      return;
    }
    if (!remaining && !inView.some((seat) => seat.id === seatId)) {
      queueMicrotask(() => setSelectedId(null));
      listHeading.current?.focus();
      return;
    }
    document
      .querySelector<HTMLButtonElement>(`[aria-controls="more-${seatId}"]`)
      ?.focus();
    // Runs once per settle request; later data changes must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settling]);
  const resolved = (review: TeacherReview) => {
    resolvedReviewIds.current.add(review.id);
    setReviews((state) => ({
      ...state,
      reviews: state.reviews?.filter((item) => item.id !== review.id) ?? null,
    }));
    settleRow(review.seat_id);
  };
  // "Mark as reviewed": close this person's review requests here at once (every page reads
  // the same table, so they leave the others too) and let vision reset them to working.
  // Remember the mark until vision moves them out of review, so the row (which may remount in
  // the other group) can't offer it twice, and drop their open requests from the queue now.
  const applyMarked = (marked: string) => {
    setMarkedSeats((previous) => new Set(previous).add(marked));
    setReviews((state) => {
      const closed = (state.reviews ?? []).filter(
        (item) => item.seat_id === marked,
      );
      for (const item of closed) resolvedReviewIds.current.add(item.id);
      return {
        ...state,
        reviews:
          state.reviews?.filter((item) => item.seat_id !== marked) ?? null,
      };
    });
  };
  const markReviewedButton = (sessionId: string | null, seatId: string) =>
    markedSeats.has(seatId) ? (
      <p className="person-note" role="status">
        Marked as reviewed. They’ll show as working again in a moment.
      </p>
    ) : reviewActionsEnabled && client && sessionId ? (
      <MarkReviewedButton
        key={seatId}
        client={client}
        sessionId={sessionId}
        seatId={seatId}
        onMarked={(marked) => {
          applyMarked(marked);
          settleRow(marked);
        }}
      />
    ) : null;
  const row = (
    seatId: string,
    content: React.ReactNode,
    presentation: Presentation | null,
    pending: readonly TeacherReview[],
  ) => {
    const open = selectedId === seatId;
    return (
      <li key={seatId} className={open ? "is-open" : undefined}>
        <button
          type="button"
          className="ws-row"
          aria-expanded={open}
          aria-controls={`more-${seatId}`}
          onClick={() => setSelectedId(open ? null : seatId)}
        >
          {content}
        </button>
        {open ? (
          <PersonDetails
            id={`more-${seatId}`}
            presentation={presentation}
            reviews={pending}
            stale={!!reviews.error || reviews.connection === "disconnected"}
            client={reviewActionsEnabled ? client : null}
            onResolved={resolved}
            interventionsEnabled={interventionsEnabled}
            actions={markReviewedButton(
              pending[0]?.session_id ??
                seats.find((seat) => seat.id === seatId)?.state?.session_id ??
                null,
              seatId,
            )}
          />
        ) : null}
      </li>
    );
  };

  const peopleEmpty = !feed.snapshot
    ? waitingForStation
      ? account.state === "error"
        ? account.message
        : "Finding your classroom…"
      : feed.loading && !configurationError
        ? "Loading…"
        : "People aren’t available right now."
    : cameraReporting
      ? "No one is in view right now."
      : observationOptions.connected
        ? "The camera is off. People appear here when it sees them."
        : "Updates paused. Reconnecting…";

  const connectionProblem =
    !waitingForStation &&
    (configurationError || feed.error || feed.connection === "disconnected");

  return (
    <div className="dashboard-shell">
      <WorkspaceSidebar
        accountEnabled={teacherLoginEnabled}
        themeToggle={themeToggleEnabled}
        reviewPage={reviewPageEnabled}
        reviewCount={reviewsLive ? reviewGroups.length : 0}
      />
      <main id="main-content" className="dashboard-main">
        {signedOut ? (
          <SignInCard />
        ) : (
          <>
            <section className="ws-hero" aria-labelledby="classroom-heading">
              <header className="page-intro">
                <div>
                  <h1 id="classroom-heading" ref={pageHeading} tabIndex={-1}>
                    {view === "review" ? "to review" : "your classroom"}
                  </h1>
                  {view === "review" || sessionLive ? null : (
                    <p className="ws-subtitle">{activity}</p>
                  )}
                </div>
                {view === "review" ? (
                  <Link className="ws-pill" href="/dashboard">
                    <WorkspaceIcon name="back" />
                    Back to classroom
                  </Link>
                ) : reviewPageEnabled ? (
                  <Link
                    className={`ws-pill review-link${waitingCount ? " has-items" : ""}${companionEnabled ? " has-companion" : ""}`}
                    href="/review"
                  >
                    TO REVIEW
                    {waitingCount ? (
                      // With the companion, keyed so a new count pops in.
                      <span
                        className="ws-count"
                        key={companionEnabled ? waitingCount : undefined}
                      >
                        {waitingCount}
                      </span>
                    ) : null}
                    {companionEnabled ? (
                      <ReviewCompanion count={reviewsLive ? waitingCount : null} />
                    ) : null}
                  </Link>
                ) : null}
              </header>
              {view !== "review" &&
              ((sessionLive && client) || (healthStripEnabled && station)) ? (
                <div className="hero-controls">
                  {sessionLive && client ? (
                    <SessionControls
                      client={client}
                      station={station}
                      onActivity={ignoreActivity}
                      teacherLoginEnabled={teacherLoginEnabled}
                      resetPeople={
                        resetPeopleEnabled
                          ? {
                              seatIds: reviewGroups.map((group) => group.seat_id),
                              onReset: (ids) => ids.forEach(applyMarked),
                            }
                          : null
                      }
                    />
                  ) : null}
                  {healthStripEnabled && station ? (
                    <CameraHealthStrip
                      station={station}
                      updatedAt={seats.map((seat) => seat.state?.updated_at)}
                      inView={inView.length}
                      conflict={conflict}
                      hostedEnabled={hostedLocalFeedEnabled}
                      hostedOrigin={hostedDashboardOrigin}
                    />
                  ) : null}
                </div>
              ) : null}
              {view !== "review" && sessionLive && conflict && !healthStripEnabled ? (
                <p className="station-busy" role="status">
                  {CAMERA_CONFLICT_MESSAGE}
                </p>
              ) : null}
            </section>

            {connectionProblem ? (
              <section className="notice" role="alert">
                <p>
                  {configurationError
                    ? "Cues isn’t connected to your classroom data here."
                    : feed.snapshot
                      ? "Live updates paused. Showing the last update."
                      : "Couldn’t load your classroom."}
                </p>
                {!configurationError ? (
                  <button
                    type="button"
                    className="ws-pill"
                    disabled={feed.loading}
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Try again
                  </button>
                ) : null}
              </section>
            ) : null}

            {view === "review" ? (
              <section className="review-page" aria-label="To review">
                {reviewsEnabled &&
                !configurationError &&
                (reviews.error || reviews.connection === "disconnected") ? (
                  <div className="list-notice" role="alert">
                    <p>Couldn’t check for new requests.</p>
                    <button
                      type="button"
                      className="ws-pill"
                      disabled={reviews.loading}
                      onClick={() => setReviewAttempt((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                ) : null}
                {reviewGroups.length ? (
                  <ol className="review-list">
                    {reviewGroups.map((group, index) => {
                      const lead = group.reviews[0];
                      const visible = inView.some(
                        (seat) => seat.id === group.seat_id,
                      );
                      return (
                        <ReviewCard
                          key={group.seat_id}
                          headingId={`review-card-${group.seat_id}`}
                          index={index + 1}
                          name={nameOf(group.seat_id)}
                          issue={reviewIssueLine(
                            activityName(lead.activity_id),
                            visible,
                            group.reviews.length,
                          )}
                          review={lead}
                          elevated={group.elevated}
                          decisions={
                            reviewActionsEnabled && client ? (
                              <TeacherReviewActions
                                key={lead.id}
                                client={client}
                                review={lead}
                                onResolved={resolved}
                                interventionsEnabled={interventionsEnabled}
                              />
                            ) : null
                          }
                          mark={markReviewedButton(lead.session_id, group.seat_id)}
                        />
                      );
                    })}
                  </ol>
                ) : (
                  reviewNotice ? null : (
                    <p className="list-clear review-clear" role="status">
                      {!reviewsEnabled || configurationError
                        ? "Cues will list people here when someone may need you."
                        : reviewsLive
                          ? "All clear. No one needs you right now."
                          : "Checking…"}
                    </p>
                  )
                )}
              </section>
            ) : (
              <>
            <div className="monitor-workspace">
              <LocalClassroomFeed hostedEnabled={hostedLocalFeedEnabled} hostedOrigin={hostedDashboardOrigin} />
              <section
                className="ws-panel class-panel"
                aria-labelledby="class-heading"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && selectedId) closeDetails();
                }}
              >
                {selectedPerson ? (
                  <div className="panel-person">
                    <header className="panel-heading">
                      <button
                        type="button"
                        className="ws-icon-button"
                        onClick={() => closeDetails()}
                        aria-label="Back to attention"
                      >
                        <WorkspaceIcon name="back" />
                      </button>
                      <h2 id="class-heading" ref={listHeading} tabIndex={-1}>
                        {selectedPerson.display_name}
                      </h2>
                    </header>
                    <PersonDetails
                      id={`more-${selectedPerson.id}`}
                      presentation={present(selectedPerson)}
                      reviews={[]}
                      stale={false}
                      client={null}
                      onResolved={resolved}
                      actions={markReviewedButton(
                        selectedPerson.state?.session_id ?? null,
                        selectedPerson.id,
                      )}
                    />
                  </div>
                ) : (
                  <>
                <header className="panel-heading">
                  <h2 id="class-heading" ref={listHeading} tabIndex={-1}>
                    Attention
                  </h2>
                  {reviewsLive && reviewGroups.length ? (
                    <span className="ws-count">
                      {reviewGroups.length}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </header>

                {reviewsEnabled &&
                !configurationError &&
                (reviews.error || reviews.connection === "disconnected") ? (
                  <div className="list-notice" role="alert">
                    <p>Couldn’t check for new requests.</p>
                    <button
                      type="button"
                      className="ws-pill"
                      disabled={reviews.loading}
                      onClick={() => setReviewAttempt((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                ) : null}

                {reviewGroups.length ? (
                  <ul className="row-list">
                    {reviewGroups.map((group) => {
                      const seat = seats.find((s) => s.id === group.seat_id);
                      const visible = inView.some((s) => s.id === group.seat_id);
                      return row(
                        group.seat_id,
                        <ReviewRowContent
                          name={nameOf(group.seat_id)}
                          meta={
                            !visible
                              ? "Not in view"
                              : mixedActivities && seat
                                ? seat.activity
                                : ""
                          }
                          time={group.latest}
                          elevated={group.elevated}
                        />,
                        visible && seat ? present(seat) : null,
                        group.reviews,
                      );
                    })}
                  </ul>
                ) : (
                  reviewNotice ? null : (
                    <p className="panel-empty" role="status">
                      {!reviewsEnabled || configurationError
                        ? "Cues will ask here when someone may need you."
                        : reviewsLive
                          ? "All clear. Cues will ask when someone may need you."
                          : "Checking…"}
                    </p>
                  )
                )}
                  </>
                )}
              </section>
            </div>

            <StudentStrip
              empty={inView.length === 0 ? peopleEmpty : null}
              people={stripEntries(
                inView.map((seat) => {
                  const presentation = present(seat);
                  return {
                    id: seat.id,
                    name: seat.display_name,
                    label: presentation.label,
                    tone: statusTone(presentation),
                    activity: seat.activity,
                  };
                }),
                new Set(reviewGroups.map((group) => group.seat_id)),
                selectedId,
                mixedActivities,
                reviewsLive,
              )}
              onSelect={(id) => setSelectedId(selectedId === id ? null : id)}
              onEscape={selectedId ? (card) => closeDetails(card) : undefined}
            />
              </>
            )}
          </>
        )}

      </main>
    </div>
  );
}
