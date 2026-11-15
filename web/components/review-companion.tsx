"use client";

import { useEffect, useState } from "react";
import CuesBlob from "@/components/cues-blob";
import {
  COMPANION_COUNT_KEY,
  COMPANION_COLORS,
  DONE_MS,
  EAT_MS,
  companionStep,
  initialCompanionPhase,
  type CompanionPhase,
} from "@/lib/companion";

// The Cues companion perched on the To review pill. It is always Cues itself,
// never a student, and it reacts only to the teacher's own queue:
//   - nothing waiting: blue, resting on the pill;
//   - a request arrives: it turns orange and hops (again for each new one);
//   - the queue clears: it eats the count, smiles and turns green, then
//     settles back to blue.
// While the review feed isn't live it just rests: a dropped feed is never
// mistaken for a cleared queue. Decoration only (aria-hidden): the pill's
// text and count carry the meaning.
/** The last live count this tab saw, or null (private mode, first visit). */
function rememberedCount(key: string): number | null {
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function ReviewCompanion({
  count,
  rememberAs,
}: {
  count: number | null;
  /** Remember the live count for this tab under this station (the dashboard
   * only; never the landing demo, whose counts are simulated). Per station, so
   * one classroom's count never shows up for another. */
  rememberAs?: string;
}) {
  const memoryKey = rememberAs ? `${COMPANION_COUNT_KEY}:${rememberAs}` : null;
  // The phase follows the count in render (not after paint), so the count it
  // eats is in place in the same frame the pill's own count goes.
  const [previous, setPrevious] = useState(count);
  const [phase, setPhase] = useState<CompanionPhase>(() =>
    initialCompanionPhase(count),
  );
  const [eaten, setEaten] = useState(0);
  const [hop, setHop] = useState(0);
  // Only the first live count after mounting looks at the memory; a feed that
  // drops and reconnects later just shows the queue as it is.
  const [memoryRead, setMemoryRead] = useState(false);
  if (count !== previous) {
    const firstLive = !memoryRead && count !== null;
    if (firstLive) setMemoryRead(true);
    const step = companionStep(
      previous,
      count,
      firstLive && memoryKey ? rememberedCount(memoryKey) : null,
    );
    setPrevious(count);
    if (step.kind === "hop") {
      setPhase("waiting");
      setHop((n) => n + 1);
    } else if (step.kind === "eat") {
      setEaten(step.eaten);
      setPhase("eating");
    } else if (step.kind === "rest") {
      setPhase("rest");
    } else if (step.kind === "sync") {
      setPhase(initialCompanionPhase(count));
    }
  }

  // Remember the live count for this tab, for the eat on the way back.
  useEffect(() => {
    if (!memoryKey || count === null) return;
    try {
      window.sessionStorage.setItem(memoryKey, String(count));
    } catch {}
  }, [count, memoryKey]);

  // Only the timers live in effects; a new count cancels them.
  useEffect(() => {
    if (phase !== "eating") return;
    const timer = window.setTimeout(() => {
      setPhase("done");
      setHop((n) => n + 1);
    }, EAT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => setPhase("rest"), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <>
      {/* The count it eats sits in the count's own slot, so the pill keeps its
          width while it goes. */}
      {phase === "eating" ? (
        <span className="ws-count review-companion-crumb" aria-hidden="true">
          {eaten}
        </span>
      ) : null}
      <span className="review-companion" data-phase={phase} aria-hidden="true">
        <span className="review-companion-body">
          <CuesBlob
            size={30}
            wander={false}
            seed={11}
            color={COMPANION_COLORS[phase]}
            face={
              phase === "eating"
                ? "surprised"
                : phase === "done"
                  ? "happy"
                  : undefined
            }
            look={
              phase === "eating"
                ? [0, -0.2]
                : phase === "rest"
                  ? [0, 0]
                  : [0.5, -0.4]
            }
            bounce={hop}
            mouth
          />
        </span>
      </span>
    </>
  );
}
