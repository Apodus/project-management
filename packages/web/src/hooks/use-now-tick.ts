import { useEffect, useState } from "react";

/**
 * Re-render the calling component on a fixed interval and hand back the current
 * epoch-ms, so a reading DERIVED from a timestamp ("last heard 47s ago", "+3m
 * unrecorded") keeps advancing between data refetches instead of freezing at
 * whatever it said when the query last resolved.
 *
 * Scope it to the smallest component that shows a live age — a 1s tick on a
 * page root re-renders the whole page every second for the sake of one counter.
 */
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
