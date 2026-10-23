/**
 * Stop on a file, the way SIGTERM stops the daemon.
 *
 * The generated supervisor runs N lanes on one host, each with its own
 * `lanes/<lane>/stop.flag`. Before this, the flag was read only by the
 * supervisor, and only BETWEEN daemon runs — so a healthy daemon never exited,
 * "stop.flag, then wait for exit" waited forever, and the only way to stop a
 * Windows lane was to kill it (Windows cannot deliver SIGTERM to another
 * process). Now the supervisor passes the lane's flag as `--stop-file` and the
 * daemon takes the same graceful path a signal takes: it finishes the current
 * loop iteration and exits 0.
 *
 * The daemon NEVER deletes the file. The supervisor's post-exit check owns the
 * flag: it is what tells it "this exit was a stop, not a crash — do not restart".
 */
import { existsSync } from "node:fs";

export const STOP_FILE_POLL_MS = 2_000;

/**
 * Poll `path`; call `onStop` exactly once when it exists. Returns a disposer.
 * The timer is unref'd, so a watcher never keeps the process alive by itself.
 */
export function watchStopFile(
  path: string,
  onStop: () => void,
  intervalMs: number = STOP_FILE_POLL_MS,
  exists: (p: string) => boolean = existsSync,
): () => void {
  let fired = false;
  const check = (): void => {
    if (fired || !exists(path)) return;
    fired = true;
    clearInterval(timer);
    onStop();
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  // A flag that already exists at boot is honoured at once, not one interval late.
  check();
  return () => clearInterval(timer);
}
