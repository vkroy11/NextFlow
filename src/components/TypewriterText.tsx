"use client";

import { useEffect, useState } from "react";

/**
 * Renders `text` with a typewriter animation. The first render snaps
 * to the full text — so persisted/static text mounted from saved
 * NodeRun output appears instantly, no replay. When `text` grows
 * after mount (live Gemini chunks arriving via the realtime stream),
 * `shown` lags behind and a 16 ms interval catches it up at a steady
 * rate, producing the typing effect.
 *
 * Catch-up rate accelerates if we fall far behind so the cursor never
 * trails the actual stream by more than a beat — important when a
 * burst of chunks lands at once after the SSE connection opens.
 */
export function TypewriterText({
  text,
  charsPerTick = 2,
  tickMs = 16,
}: {
  text: string;
  charsPerTick?: number;
  tickMs?: number;
}) {
  const [shown, setShown] = useState<number>(() => text.length);

  useEffect(() => {
    if (text.length < shown) {
      // Text shrunk (run reset / new run started): snap to current
      // length so we don't render past-the-end characters.
      setShown(text.length);
      return;
    }
    if (text.length === shown) return;

    const id = window.setInterval(() => {
      setShown((s) => {
        if (s >= text.length) {
          window.clearInterval(id);
          return s;
        }
        const remaining = text.length - s;
        const step = Math.max(charsPerTick, Math.ceil(remaining / 30));
        const next = Math.min(text.length, s + step);
        if (next >= text.length) window.clearInterval(id);
        return next;
      });
    }, tickMs);

    return () => window.clearInterval(id);
    // We intentionally don't depend on `shown` — when more text arrives
    // (text dep changes) we tear down the old interval and start a new
    // one; otherwise the interval self-cancels when caught up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, charsPerTick, tickMs]);

  const showCursor = shown < text.length;
  return (
    <>
      {text.slice(0, shown)}
      {showCursor ? (
        <span
          aria-hidden
          className="ml-0.5 inline-block w-[1px] animate-pulse bg-current align-text-bottom"
          style={{ height: "1em" }}
        />
      ) : null}
    </>
  );
}
