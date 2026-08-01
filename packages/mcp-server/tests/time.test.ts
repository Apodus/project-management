import { describe, it, expect } from "vitest";
import { formatAge, formatInstant, elapsedSince, renderClockLine } from "../src/time.js";

// The bug these helpers exist to kill: an agent on a UTC+3 host measured a
// `05:00:19Z` landing against its shell's local `08:26` and manufactured a
// 3-hour stall out of a 3-hour offset. Every assertion below is about the
// reader never having to do that arithmetic.

describe("formatAge", () => {
  it("uses seconds below a minute", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(999)).toBe("0s");
    expect(formatAge(42_000)).toBe("42s");
    expect(formatAge(59_999)).toBe("59s");
  });

  it("uses whole minutes below an hour", () => {
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(26 * 60_000)).toBe("26m");
    expect(formatAge(3_599_999)).toBe("59m"); // last millisecond below an hour
  });

  it("uses hours + minutes below a day", () => {
    expect(formatAge(3_600_000)).toBe("1h");
    expect(formatAge(3_600_000 + 12 * 60_000)).toBe("1h 12m");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
  });

  it("uses days + hours beyond a day", () => {
    expect(formatAge(86_400_000)).toBe("1d");
    expect(formatAge(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("is sign-insensitive (callers own the direction)", () => {
    expect(formatAge(-26 * 60_000)).toBe("26m");
  });
});

describe("formatInstant", () => {
  const now = Date.parse("2026-08-01T05:26:41.000Z");

  it("keeps the UTC instant AND appends a pre-computed age", () => {
    const out = formatInstant("2026-08-01T05:00:19.000Z", now);
    expect(out).toContain("2026-08-01T05:00:19.000Z");
    expect(out).toContain("(26m ago)");
  });

  it("renders a future instant as a countdown, not a negative age", () => {
    const out = formatInstant("2026-08-01T05:30:41.000Z", now);
    expect(out).toContain("(in 4m)");
    expect(out).not.toContain("ago");
  });

  it("collapses sub-second deltas to 'just now'", () => {
    expect(formatInstant("2026-08-01T05:26:41.500Z", now)).toContain("(just now)");
  });

  it("passes an unparseable value through verbatim rather than eating it", () => {
    expect(formatInstant("not-a-timestamp", now)).toBe("not-a-timestamp");
  });

  it("is immune to the host timezone (instants, not wall clocks)", () => {
    // The exact failure mode: the SAME instant pair must yield 26m whatever
    // the reader's local offset is — the age is computed from epoch millis.
    const utcPlus3Wall = Date.parse("2026-08-01T08:26:41.000+03:00");
    expect(utcPlus3Wall).toBe(now);
    expect(formatInstant("2026-08-01T05:00:19.000Z", utcPlus3Wall)).toContain("(26m ago)");
  });
});

describe("elapsedSince", () => {
  const now = Date.parse("2026-08-01T05:26:41.000Z");

  it("returns the age of a valid instant", () => {
    expect(elapsedSince("2026-08-01T05:00:19.000Z", now)).toBe("26m");
  });

  it("returns null for missing / unparseable input", () => {
    expect(elapsedSince(null, now)).toBeNull();
    expect(elapsedSince(undefined, now)).toBeNull();
    expect(elapsedSince("nope", now)).toBeNull();
  });

  it("floors a future instant at zero instead of going negative", () => {
    expect(elapsedSince("2026-08-01T06:00:00.000Z", now)).toBe("0s");
  });
});

describe("renderClockLine", () => {
  it("states UTC-now and local-now side by side", () => {
    const line = renderClockLine(new Date("2026-08-01T05:26:41.000Z"));
    expect(line).toContain("now: 2026-08-01T05:26:41Z");
    expect(line).toContain("local ");
    // The offset is always named, never left to be inferred from a delta.
    expect(line).toMatch(/\(UTC([+-]\d{2}:\d{2})?\)/);
  });

  it("warns about the local-`date` trap only on a non-UTC host", () => {
    const d = new Date("2026-08-01T05:26:41.000Z");
    const offset = d.getTimezoneOffset();
    const line = renderClockLine(d);
    if (offset === 0) {
      expect(line).not.toContain("do NOT subtract");
      expect(line.split("\n")).toHaveLength(1);
    } else {
      expect(line).toContain("do NOT subtract");
      expect(line).toContain("Times below are UTC (Z)");
    }
  });
});
