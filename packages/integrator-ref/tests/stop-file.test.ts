import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchStopFile } from "../src/stop-file.js";

/**
 * The per-lane stop.flag must stop a RUNNING daemon (the supervisor alone only
 * reads it between runs), exactly once, and must be left on disk: the
 * supervisor's post-exit check is what tells a stop from a crash.
 */
describe("watchStopFile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the file appears, and never deletes it", () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "stop-file-"));
    try {
      const flag = join(dir, "stop.flag");
      const onStop = vi.fn();
      watchStopFile(flag, onStop, 100);

      vi.advanceTimersByTime(350);
      expect(onStop).not.toHaveBeenCalled();

      writeFileSync(flag, "");
      vi.advanceTimersByTime(100);
      expect(onStop).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(existsSync(flag)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours a flag that already exists at boot without waiting an interval", () => {
    const onStop = vi.fn();
    watchStopFile("x", onStop, 60_000, () => true);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("watches only its own path", () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    watchStopFile("lanes/a/stop.flag", onStop, 100, (p) => p === "lanes/b/stop.flag");
    vi.advanceTimersByTime(1_000);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("the disposer stops polling", () => {
    vi.useFakeTimers();
    let present = false;
    const onStop = vi.fn();
    const dispose = watchStopFile("x", onStop, 100, () => present);
    dispose();
    present = true;
    vi.advanceTimersByTime(1_000);
    expect(onStop).not.toHaveBeenCalled();
  });
});
