"use client";
import Link from "next/link";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markSeatReviewed } from "@/lib/seat-review";
import {
  changeSession,
  readSession,
  sessionActions,
  sessionControlState,
  sessionOwnership,
  stationSyncLabel,
  type SessionSnapshot,
} from "@/lib/session-controls";

const RESET_LABEL = "Put everyone back to working";
const RESET_CONFIRM =
  "Put everyone back to working? People who finished start over, and open requests are closed.";

// Module-wide, so a remount never reuses a topic whose channel is still leaving.
let channelId = 0;

export function SessionControls({
  client,
  station,
  onActivity,
  teacherLoginEnabled = false,
  resetPeople = null,
  onSnapshot,
}: {
  client: SupabaseClient;
  station: string;
  onActivity: (label: string) => void;
  teacherLoginEnabled?: boolean;
  /** web.reset_people: switching or restarting the activity puts everyone back to working, so
   * the requests still open for the people in `seatIds` are closed too, and the refresh button
   * restarts the current activity. Null: the button only reloads the session, as before. */
  resetPeople?: {
    seatIds: readonly string[];
    onReset: (seatIds: string[]) => void;
  } | null;
  /** The one authoritative session snapshot (null while loading or unavailable), shared with
   * the dashboard so what it shows as current follows the same session, activity and revision. */
  onSnapshot?: (snapshot: SessionSnapshot | null) => void;
}) {
  const resetRef = useRef(resetPeople);
  useEffect(() => {
    resetRef.current = resetPeople;
  });
  const [user, setUser] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const snapshotRef = useRef(onSnapshot);
  useEffect(() => {
    snapshotRef.current = onSnapshot;
  });
  // Every change, including a start, end or switch that this page just made, reaches the
  // dashboard in the same commit; a reload (snapshot null) says "unknown", never "unchanged".
  useEffect(() => {
    snapshotRef.current?.(snapshot);
  }, [snapshot]);
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "start" | "change" | "end" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  // Why the session never loaded (e.g. the camera is not linked to you),
  // kept apart from later action, sign-out or live-update errors.
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const refreshAfterAction = useRef<(() => void) | null>(null);
  // Whether the camera reports that it can't run the chosen activity, checked
  // against the clock each time a session snapshot arrives.
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  useEffect(() => {
    const unavailable = snapshot
      ? stationSyncLabel(snapshot, Date.now()) ===
        "Activity unavailable on the camera"
      : false;
    queueMicrotask(() => setCameraUnavailable(unavailable));
  }, [snapshot]);
  const needsRefresh = useRef(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const request = useRef(0);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user.id ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, [client]);
  useEffect(() => {
    const epoch = ++generation.current;
    let disposed = false;
    let loaded = false;
    let refreshing = false;
    let refreshAgain = false;
    needsRefresh.current = false;
    queueMicrotask(() => {
      if (disposed) return;
      setSnapshot(null);
      setSelection("");
      setRefreshRequired(false);
      setError(null);
      setLoadError(null);
      onActivity(user ? "Loading activity…" : "Sign in to manage activities");
    });
    if (!user || !station) return;
    async function refresh() {
      if (disposed || locked.current || needsRefresh.current) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      const id = ++request.current;
      if (!loaded) setBusy(true);
      try {
        const next = await readSession(client, station);
        if (disposed || epoch !== generation.current || id !== request.current)
          return;
        loaded = true;
        setSnapshot(next);
        setSelection((previous) =>
          previous && next.activities.some((a) => a.id === previous)
            ? previous
            : (next.session?.current_activity_id ?? ""),
        );
        setError(null);
        setLoadError(null);
        setRefreshRequired(false);
        onActivity(
          next.session
            ? (next.activities.find(
                (a) => a.id === next.session?.current_activity_id,
              )?.name ?? "Activity unavailable")
            : "No activity running",
        );
      } catch (cause) {
        if (
          !disposed &&
          epoch === generation.current &&
          id === request.current
        ) {
          const message =
            cause instanceof Error
              ? cause.message
              : "Session could not be refreshed. Check your camera link and retry.";
          if (!loaded) {
            onActivity("Activity unavailable");
            setLoadError(message);
          }
          setError(message);
          needsRefresh.current = true;
          setRefreshRequired(true);
        }
      } finally {
        refreshing = false;
        if (!disposed && id === request.current) setBusy(false);
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          void refresh();
        }
      }
    }
    refreshAfterAction.current = () => void refresh();
    void refresh();
    const channel = client
      .channel(`session-controls:${station}:${++channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `station_id=eq.${station}`,
        },
        () => void refresh(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "station_runtime",
          filter: `station_id=eq.${station}`,
        },
        () => void refresh(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void refresh();
        else if (
          ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) &&
          !disposed
        ) {
          setError(
            "Live session updates are disconnected. Refresh the session before acting.",
          );
          // A disconnected live channel does not invalidate a successful RPC
          // snapshot. Revision checks still protect actions; polling can recover.
        }
      });
    const online = () => void refresh();
    window.addEventListener("online", online);
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      disposed = true;
      refreshAfterAction.current = null;
      generation.current = epoch + 1;
      clearInterval(timer);
      window.removeEventListener("online", online);
      void client.removeChannel(channel);
    };
  }, [client, station, user, refreshKey, onActivity]);
  async function clearRequests(sessionId: string) {
    const reset = resetRef.current;
    if (!reset || reset.seatIds.length === 0) return;
    const closed: string[] = [];
    for (const seatId of reset.seatIds) {
      try {
        await markSeatReviewed(client, sessionId, seatId);
        closed.push(seatId);
      } catch {
        /* Reported once below; the rest still close. */
      }
    }
    if (closed.length) reset.onReset(closed);
    if (closed.length < reset.seatIds.length)
      setError(
        "Everyone is back to working, but some requests could not be closed. Mark them as reviewed one by one.",
      );
  }
  async function act(activityId: string | null) {
    if (locked.current || !snapshot || refreshRequired) return;
    locked.current = true;
    setPendingAction(
      activityId === null ? "end" : snapshot.session ? "change" : "start",
    );
    request.current++;
    const epoch = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await changeSession(
        client,
        station,
        snapshot.session,
        activityId,
        user,
      );
      if (epoch !== generation.current) return;
      // Adopt the returned session now: rows from the old session, activity or revision stop
      // counting at once, before the slower step below.
      const next = {
        ...snapshot,
        session: result.ended_at ? null : result,
        latest_session: result,
      };
      setSnapshot(next);
      // A new revision already starts every person over in vision; close what was still open
      // for them so the queue and the people row agree.
      if (activityId !== null && !result.ended_at) await clearRequests(result.id);
      if (epoch !== generation.current) return;
      // A successful change removes the Change button; keep focus nearby.
      if (activityId !== null && snapshot.session)
        requestAnimationFrame(() => selectRef.current?.focus());
      onActivity(
        result.ended_at
          ? "No activity running"
          : (snapshot.activities.find(
              (a) => a.id === result.current_activity_id,
            )?.name ?? "Activity unavailable"),
      );
    } catch {
      if (epoch === generation.current) {
        setError(
          "Action could not be saved. Refresh the session to check its state before retrying.",
        );
        needsRefresh.current = true;
        setRefreshRequired(true);
      }
    } finally {
      locked.current = false;
      if (epoch === generation.current) {
        setBusy(false);
        setPendingAction(null);
        refreshAfterAction.current?.();
      }
    }
  }
  // No station yet (still being found, or none set up): no controls and no
  // caption; the classroom panels say what is happening.
  if (!station) return null;
  if (!user && teacherLoginEnabled)
    return (
      <Link className="ws-pill is-dark" href="/login">
        Teacher sign in
      </Link>
    );
  if (!user)
    return (
      <details className="session-sign-in">
        <summary>Teacher sign in</summary>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (locked.current) return;
            const fields = new FormData(event.currentTarget);
            locked.current = true;
            setBusy(true);
            setError(null);
            let signedIn = false;
            try {
              const { error } = await client.auth.signInWithPassword({
                email: String(fields.get("email")),
                password: String(fields.get("password")),
              });
              if (error)
                setError("Sign-in failed. Check your email and password.");
              else signedIn = true;
            } catch {
              setError("Sign-in could not connect. Try again.");
            } finally {
              locked.current = false;
              setBusy(false);
              if (signedIn) setRefreshKey((n) => n + 1);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      </details>
    );
  const controlState = sessionControlState(snapshot, refreshRequired);
  const actions = sessionActions(snapshot, selection);
  // The two states the teacher must act on, shown like an error: a session
  // that isn't theirs (its reviews are hidden from them) and an activity the
  // camera can't run. Calm states ("synced", "waiting…") stay hidden.
  const session = snapshot?.session ?? null;
  const owner = session ? sessionOwnership(session, user) : null;
  const warning =
    owner === "unowned"
      ? "An earlier session is still open. End it, then start yours."
      : owner === "other"
        ? "Another teacher started this session, so its requests go to them."
        : cameraUnavailable
          ? "The camera can’t run this activity. Pick another."
          : null;
  // With reset on and an activity running, the button restarts it for everyone; otherwise (and
  // in the load-error state, or after a failed read or action, where it is the retry) it only
  // reloads the session. Without that retry the controls would stay locked until a page reload.
  const restart = Boolean(
    resetPeople && snapshot?.session && !loadError && !refreshRequired,
  );
  const refreshButton = (
    <button
      type="button"
      className="ws-icon-button"
      aria-label={restart ? RESET_LABEL : "Refresh activity"}
      title={restart ? RESET_LABEL : "Refresh activity"}
      disabled={busy}
      onClick={() => {
        if (!restart) return setRefreshKey((n) => n + 1);
        if (window.confirm(RESET_CONFIRM) && snapshot?.session)
          void act(snapshot.session.current_activity_id);
      }}
    >
      <WorkspaceIcon name="refresh" />
    </button>
  );
  // The session could not load: say so plainly instead of showing controls
  // that can't act, with a way to retry.
  if (!snapshot && loadError && controlState === "refresh")
    return (
      <div className="session-controls is-blocked" aria-busy={busy}>
        <p className="session-line" role="alert">
          {loadError}
        </p>
        <div className="session-row">{refreshButton}</div>
      </div>
    );
  return (
    <div className="session-controls" aria-busy={busy}>
      <div className="session-row">
        <label className="sr-only" htmlFor="session-activity">
          Activity
        </label>
        <select
          id="session-activity"
          ref={selectRef}
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
          disabled={
            busy || controlState === "loading" || controlState === "refresh"
          }
        >
          <option value="">
            {controlState === "loading"
              ? "Loading activities…"
              : "Pick an activity"}
          </option>
          {snapshot?.activities.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {actions.primary ? (
          <button
            type="button"
            className="ws-pill is-dark"
            disabled={
              busy ||
              refreshRequired ||
              (actions.primary === "start" && !selection)
            }
            onClick={() => void act(selection)}
          >
            {actions.primary === "start"
              ? pendingAction === "start"
                ? "Starting…"
                : "Start"
              : pendingAction === "change"
                ? "Changing…"
                : "Change activity"}
          </button>
        ) : null}
        {actions.end ? (
          <button
            type="button"
            className="ws-pill"
            disabled={busy || refreshRequired}
            onClick={() => void act(null)}
          >
            {pendingAction === "end" ? "Ending…" : "End"}
          </button>
        ) : null}
        {refreshButton}
      </div>
      {/* No status captions under the controls; only what the teacher has to
          act on: an action or load error, or one of the warnings above. */}
      {warning && !error ? (
        <p className="session-line is-error" role="alert">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p className="session-line is-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
