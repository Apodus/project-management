/**
 * Clock legibility for the merge-train reads.
 *
 * Every timestamp PM stores and returns is UTC (`...Z`). Agents repeatedly
 * manufactured phantom stalls by measuring one of those against their shell's
 * LOCAL `date`: on a UTC+3 host a 26-minute in-flight cross-repo group read as
 * a "3-hour stall", and the agent came within one call of rejecting and
 * resubmitting a perfectly healthy group. The offset, not the train, was the
 * three hours.
 *
 * The fix is to never leave clock arithmetic to the reader:
 *  - every instant renders with a PRE-COMPUTED age (`(26m ago)`), so the useful
 *    number is already on the page and no subtraction is needed;
 *  - every merge-train read carries a `renderClockLine()` anchor stating
 *    UTC-now and local-now side by side, so a reader who does glance at a local
 *    clock sees the offset spelled out instead of discovering it as a delta;
 *  - the explicit warning is attached only on a non-UTC host — where the trap
 *    actually exists.
 *
 * Ages are computed from instants, so they are offset-proof by construction:
 * a `Z` timestamp parses to an absolute epoch regardless of the host's zone.
 * They are computed MCP-side (the agent's own machine) rather than server-side,
 * which keeps this a bundle-only change — no PM-server redeploy, no migration.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * A duration as a compact, unambiguous string: `42s` / `7m` / `1h 12m` /
 * `2d 3h`. Sub-minute resolution is kept only below a minute — for a merge
 * train "26m" is the decision-grade number, and "26m 04s" is noise.
 */
export function formatAge(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return "0s";
  if (abs < MINUTE_MS) return `${Math.floor(abs / 1000)}s`;
  if (abs < HOUR_MS) return `${Math.floor(abs / MINUTE_MS)}m`;
  if (abs < DAY_MS) {
    const h = Math.floor(abs / HOUR_MS);
    const m = Math.floor((abs % HOUR_MS) / MINUTE_MS);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY_MS);
  const h = Math.floor((abs % DAY_MS) / HOUR_MS);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Render a stored instant with its age: `2026-08-01T05:00:19Z (26m ago)`.
 * A future instant (a lease expiry, a clock skewed by seconds) reads
 * `(in 4m)`. An unparseable value is passed through verbatim — a legibility
 * helper must never eat data it doesn't recognize.
 */
export function formatInstant(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = now - t;
  // Sub-second in either direction: "now" beats a signed "0s ago/in 0s".
  if (Math.abs(delta) < 1000) return `${iso} (just now)`;
  return delta >= 0 ? `${iso} (${formatAge(delta)} ago)` : `${iso} (in ${formatAge(-delta)})`;
}

/**
 * Elapsed time between two instants (`to` defaults to now), or null when
 * either side is missing/unparseable. Callers use this for "in flight for X"
 * — the number that answers "is this wedged?" without any clock comparison.
 */
export function elapsedSince(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return formatAge(Math.max(0, now - t));
}

/** `UTC+03:00` / `UTC-05:30` / `UTC` for the host's current offset. */
function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const m = (abs % 60).toString().padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Local wall-clock as `YYYY-MM-DD HH:MM:SS` (locale-independent by hand). */
function localWallClock(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * The clock anchor every merge-train read carries: UTC-now and the reader's
 * own local-now on one line, so the offset is stated up front rather than
 * discovered as a phantom delay. On a non-UTC host a second line names the
 * trap outright — that host is the only one where it exists.
 */
export function renderClockLine(now: Date = new Date()): string {
  const utc = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // getTimezoneOffset() is minutes BEHIND UTC; negate for the conventional sign.
  const offsetMinutes = -now.getTimezoneOffset();
  const offset = formatOffset(offsetMinutes);
  const head = `  ⏱ now: ${utc}   ·   local ${localWallClock(now)} (${offset})`;
  if (offsetMinutes === 0) return head;
  return (
    `${head}\n` +
    `     Times below are UTC (Z) and every age is already computed for you — ` +
    `do NOT subtract a Z timestamp from local \`date\` output (this host is ${offset}).`
  );
}
