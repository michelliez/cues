"use client";

import { useEffect, useState } from "react";
import { readLocalVision, type LocalVisionReading } from "@/lib/camera-health";
import { mayConnectLocalFeed } from "@/lib/local-feed-policy";

const POLL_MS = 3000;

export type LocalVisionState = {
  /** null until the first reading comes back (or this page may not read the laptop). */
  vision: LocalVisionReading | null;
  /** Known only in the browser: null until then, false on a page that may not reach this laptop. */
  localReadable: boolean | null;
  /** The page's clock in ms, started by the first poll (never read during render). */
  now: number;
};

/**
 * Polls this laptop's vision service (GET /health and /config) once, for everything on
 * the dashboard that speaks about the camera: the health strip and the empty-room
 * message. Only a page allowed to reach this laptop (localhost, or the hosted origin
 * with web.hosted_local_feed) reads it, as the video feed does.
 */
export function useLocalVision(
  hostedEnabled = false,
  hostedOrigin?: string,
): LocalVisionState {
  const [vision, setVision] = useState<LocalVisionReading | null>(null);
  const [now, setNow] = useState(0);
  const [localReadable, setLocalReadable] = useState<boolean | null>(null);
  useEffect(() => {
    let disposed = false;
    const readable = mayConnectLocalFeed(window.location.origin, hostedEnabled, hostedOrigin);
    queueMicrotask(() => {
      if (!disposed) setLocalReadable(readable);
    });
    const tick = () => {
      if (document.hidden) return;
      setNow(Date.now());
      if (!readable) return;
      void readLocalVision().then((reading) => {
        if (!disposed) setVision(reading);
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [hostedEnabled, hostedOrigin]);
  return { vision, localReadable, now };
}
