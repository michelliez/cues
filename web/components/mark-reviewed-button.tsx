"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markSeatReviewed } from "@/lib/seat-review";

/**
 * "Mark as reviewed" for a flagged child. It closes their open review requests on every
 * page, puts them back to working, and restarts the timer before the next review prompt.
 */
export function MarkReviewedButton({
  client,
  sessionId,
  seatId,
  label = "Mark as reviewed",
  variant = "text",
  onMarked,
}: {
  client: SupabaseClient;
  sessionId: string;
  seatId: string;
  label?: string;
  variant?: "text" | "live";
  onMarked?: (seatId: string) => void;
}) {
  // A synchronous lock, as in TeacherReviewActions, so a double click marks once.
  const locked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session?.user));
    });
    return () => data.subscription.unsubscribe();
  }, [client]);
  async function mark() {
    if (!authenticated || locked.current) return;
    locked.current = true;
    setSaving(true);
    setError(null);
    try {
      await markSeatReviewed(client, sessionId, seatId);
      setDone(true);
      onMarked?.(seatId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not mark as reviewed.",
      );
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="mark-reviewed" aria-busy={saving}>
      <button
        type="button"
        className={variant === "live" ? "ws-pill is-dark" : "ws-pill"}
        disabled={!authenticated || saving || done}
        onClick={() => void mark()}
      >
        {saving ? "Saving…" : done ? "Marked as reviewed" : label}
      </button>
      {!authenticated ? (
        <p className="person-note" role="status">
          Sign in to mark this as reviewed.
        </p>
      ) : null}
      {done ? (
        <p className="person-note" role="status">
          They’ll show as working again in a moment.
        </p>
      ) : null}
      {error ? (
        <p className="person-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
