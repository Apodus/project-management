import { describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatPercent,
  formatFreshness,
} from "./format";

describe("formatDurationMs", () => {
  it("returns '—' for null/undefined (empty data set)", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(undefined)).toBe("—");
  });

  it("never returns NaN for non-finite input", () => {
    expect(formatDurationMs(NaN)).toBe("—");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatDurationMs(47_000)).toBe("47s");
  });

  it("formats minutes + seconds", () => {
    expect(formatDurationMs(9 * 60_000)).toBe("9m 0s");
    expect(formatDurationMs(63_000)).toBe("1m 3s");
  });

  it("formats hours + minutes", () => {
    expect(formatDurationMs(60 * 60_000 + 3 * 60_000)).toBe("1h 3m");
  });
});

describe("formatPercent", () => {
  it("returns '—' for null/undefined (zero-sized sample)", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });

  it("never returns NaN", () => {
    expect(formatPercent(NaN)).toBe("—");
  });

  it("formats a ratio as a rounded percentage", () => {
    expect(formatPercent(0.92)).toBe("92%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
  });
});

describe("formatFreshness", () => {
  it("returns '—' for null/undefined (no heartbeat recorded)", () => {
    expect(formatFreshness(null)).toBe("—");
    expect(formatFreshness(undefined)).toBe("—");
  });

  it("formats seconds / minutes / hours / days", () => {
    expect(formatFreshness(47_000)).toBe("47s ago");
    expect(formatFreshness(3 * 60_000)).toBe("3m ago");
    expect(formatFreshness(2 * 60 * 60_000)).toBe("2h ago");
    expect(formatFreshness(3 * 24 * 60 * 60_000)).toBe("3d ago");
  });
});
