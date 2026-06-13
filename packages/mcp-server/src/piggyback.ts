import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listUndelivered } from "./api-client.js";
import type { UndeliveredEscalation } from "@pm/shared";

/**
 * Active-turn piggyback (Campaign C2 §P3).
 *
 * Monkey-patches `server.tool` ONCE so that every registered tool's response
 * gains a trailing 📬 envelope when the caller (identified by PM_WORKER_KEY)
 * has unread directed escalation replies. This is the fast path for an
 * IN-SESSION worker to NOTICE replies without polling pm_check_messages — the
 * out-of-band wake daemon is the structural guarantee for ENDED workers.
 *
 * Surfacing ≠ consuming: the piggyback NEVER advances the read cursor (only
 * pm_check_messages does). It is best-effort and byte-identical when there is
 * no worker key, no unread replies, or the lookup throws — and excludes
 * pm_check_messages itself (it already drains).
 */

type ToolResult = { content?: unknown[] } & Record<string, unknown>;

// ─── Throttle: dedupe concurrent + rate-limit the unread lookup ───────
const FETCH_TTL_MS = 10_000;
let fetchCache: { key: string; at: number; promise: Promise<UndeliveredEscalation[]> } | null = null;

/**
 * Fetch the caller's unread escalations, throttled to one live request per
 * (workerKey) per TTL window. Concurrent calls share the in-flight promise.
 * Errors are NOT cached (the next call retries); a throw propagates to
 * appendEnvelope's catch, which swallows it.
 */
function fetchUnreadThrottled(workerKey: string): Promise<UndeliveredEscalation[]> {
  const now = Date.now();
  if (fetchCache && fetchCache.key === workerKey && now - fetchCache.at < FETCH_TTL_MS) {
    return fetchCache.promise;
  }
  const promise = listUndelivered(workerKey);
  // Do NOT cache a rejected promise — drop the cache entry on failure so the
  // next call re-fetches rather than re-throwing a stale error.
  promise.catch(() => {
    if (fetchCache && fetchCache.promise === promise) {
      fetchCache = null;
    }
  });
  fetchCache = { key: workerKey, at: now, promise };
  return promise;
}

/**
 * Render the 📬 envelope: the top-3 escalations with unread replies, an
 * "…and M more." line when truncated, and a call-to-action tail.
 */
function envelopeText(undelivered: UndeliveredEscalation[]): string {
  const lines = ["📬 You have unread escalation repl(y/ies):"];
  for (const { escalation: e, unreadMessages } of undelivered.slice(0, 3)) {
    lines.push(`- [${e.kind}] ${e.title} (${e.id}) — ${unreadMessages.length} unread`);
  }
  if (undelivered.length > 3) {
    lines.push(`- …and ${undelivered.length - 3} more.`);
  }
  lines.push("Call pm_check_messages to read and acknowledge them.");
  return lines.join("\n");
}

/**
 * Best-effort: append the unread-replies envelope as a NEW content block.
 * Byte-identical (returns `result` unchanged) when there's no worker key, no
 * unread replies, the result has no content array, or anything throws.
 */
async function appendEnvelope(
  result: ToolResult,
  getKey: () => string | undefined,
): Promise<ToolResult> {
  try {
    const workerKey = getKey();
    if (!workerKey) return result;
    const undelivered = await fetchUnreadThrottled(workerKey);
    if (!undelivered?.length) return result;
    if (!Array.isArray(result?.content)) return result;
    return {
      ...result,
      content: [...result.content, { type: "text" as const, text: envelopeText(undelivered) }],
    };
  } catch {
    return result;
  }
}

/**
 * Monkey-patch `server.tool` once so every tool registered AFTER this call
 * wraps its callback with the unread-replies piggyback. Returns the same
 * server. Idempotent guard via a marker symbol.
 */
const PATCHED = Symbol.for("pm.piggyback.patched");

export function withPiggyback(
  server: McpServer,
  getKey: () => string | undefined,
): McpServer {
  const marked = server as McpServer & { [PATCHED]?: boolean };
  if (marked[PATCHED]) return server;
  marked[PATCHED] = true;

  const originalTool = server.tool.bind(server);
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ): unknown => {
    const name = args[0];
    // The handler callback is the last function-typed positional argument
    // (intent-robust against the SDK's optional desc/schema/annotations).
    // Hand-rolled reverse scan — Array.prototype.findLastIndex is ES2023 and
    // the project targets ES2022.
    let cbIndex = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === "function") {
        cbIndex = i;
        break;
      }
    }
    if (cbIndex === -1 || name === "pm_check_messages") {
      return originalTool.apply(server, args as Parameters<typeof originalTool>);
    }
    const original = args[cbIndex] as (...callArgs: unknown[]) => unknown;
    args[cbIndex] = async (...callArgs: unknown[]) =>
      appendEnvelope((await original(...callArgs)) as ToolResult, getKey);
    return originalTool.apply(server, args as Parameters<typeof originalTool>);
  };

  return server;
}
