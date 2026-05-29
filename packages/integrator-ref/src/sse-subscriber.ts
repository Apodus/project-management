import type { Logger } from "./logger.js";

/**
 * A resettable deferred: `wait()` returns a promise that resolves when
 * `resolve()` is next called; after it resolves it can be reset for the
 * next wait.
 */
export interface ResettableDeferred {
  wait(): Promise<void>;
  resolve(): void;
}

export function createResettableDeferred(): ResettableDeferred {
  let resolveFn: (() => void) | null = null;
  let pending: Promise<void> | null = null;

  return {
    wait(): Promise<void> {
      if (!pending) {
        pending = new Promise<void>((resolve) => {
          resolveFn = resolve;
        });
      }
      return pending;
    },
    resolve(): void {
      if (resolveFn) {
        resolveFn();
        resolveFn = null;
        pending = null;
      }
    },
  };
}

export interface Subscriber {
  start(): void;
  stop(): void;
  /** Resolves whenever a relevant merge.request event arrives. */
  readonly wakeup: ResettableDeferred;
}

export interface SseSubscriberOptions {
  baseUrl: string;
  token: string;
  projectId: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

// Event names that should wake the integration loop.
const WAKE_EVENTS = new Set([
  "merge.request.queued",
  "merge.request.abandoned",
]);

/**
 * Subscribes to the PM SSE event stream and pokes `wakeup` whenever a
 * relevant merge.request event arrives. SSE is a latency optimization only;
 * the loop's poll is the correctness floor, so this never needs to filter on
 * resource (the frame doesn't carry it) — any matching event triggers a poll.
 */
export function createSseSubscriber(opts: SseSubscriberOptions): Subscriber {
  const { baseUrl, token, projectId, logger } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wakeup = createResettableDeferred();

  let stopped = false;
  let controller: AbortController | null = null;
  let backoffIdx = 0;

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)];
    backoffIdx += 1;
    const t = setTimeout(() => void connect(), delay);
    t.unref?.();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    controller = new AbortController();
    const url = `${baseUrl}/api/v1/events?project_id=${encodeURIComponent(projectId)}`;
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        logger.debug({ status: res.status }, "SSE connect non-ok; will retry");
        scheduleReconnect();
        return;
      }
      // Connected — reset backoff.
      backoffIdx = 0;
      logger.debug("SSE stream connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on SSE frame boundaries (blank line).
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame);
        }
      }
      // Stream ended — reconnect.
      if (!stopped) {
        logger.debug("SSE stream ended; reconnecting");
        scheduleReconnect();
      }
    } catch (err) {
      if (stopped) return;
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "SSE stream error; reconnecting",
      );
      scheduleReconnect();
    }
  }

  function handleFrame(frame: string): void {
    let eventName = "message";
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      }
      // We only need the event name to decide whether to wake; the data
      // payload doesn't carry `resource`, so the loop re-polls regardless.
    }
    if (WAKE_EVENTS.has(eventName)) {
      logger.debug({ event: eventName }, "SSE wakeup");
      wakeup.resolve();
    }
  }

  return {
    start(): void {
      stopped = false;
      void connect();
    },
    stop(): void {
      stopped = true;
      controller?.abort();
      wakeup.resolve();
    },
    wakeup,
  };
}
