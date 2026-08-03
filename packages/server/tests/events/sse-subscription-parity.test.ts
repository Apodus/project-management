import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_NAMES } from "../../src/events/event-bus.js";

// ══════════════════════════════════════════════════════════════════
// SSE SUBSCRIPTION PARITY — kills a whole bug class, permanently.
//
// The web client subscribes by EXPLICIT NAME (EventSource.addEventListener),
// so a name that no emitter emits is a listener that never fires: silent, free
// of any error, and indistinguishable from "nothing happened". Campaign
// 2026-08-03 §P5 found three such dead subscriptions shipped
// (merge.batch.formed/landed/rejected — the real names are
// started/member_landed/member_invalidated/completed), which had been quietly
// subscribed since Phase 7.2.
//
// This test lives in the SERVER package on purpose: @pm/web depends on neither
// @pm/shared nor the server, so it cannot import EVENT_NAMES — but EVENT_NAMES
// is the authority. Reading the client source by path is the same technique
// merge-phase-seal.test.ts uses, for the same reason.
// ══════════════════════════════════════════════════════════════════

const USE_SSE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../web/src/hooks/use-sse.ts",
);

/** The `eventTypes` array literal in use-sse.ts, as a list of names. */
function subscribedEventNames(): string[] {
  const source = readFileSync(USE_SSE, "utf8");
  const start = source.indexOf("const eventTypes = [");
  expect(start, "use-sse.ts must declare `const eventTypes = [`").toBeGreaterThan(-1);
  const end = source.indexOf("];", start);
  expect(end, "the eventTypes literal must be closed").toBeGreaterThan(start);
  // Comments FIRST: the list is heavily annotated and those annotations quote
  // event-name fragments ("note", "triage_decision"), which would otherwise be
  // scraped as subscriptions and fail this test for the wrong reason.
  const body = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("SSE subscription parity", () => {
  it("every name the web client subscribes to is a name the server can emit", () => {
    const emitted = new Set<string>(Object.values(EVENT_NAMES));
    const dead = subscribedEventNames().filter((name) => !emitted.has(name));
    expect(dead, "these subscriptions can never fire — no emitter uses these names").toEqual([]);
  });

  it("the extraction actually found the list (a vacuous pass is worse than a failure)", () => {
    const names = subscribedEventNames();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("task.updated");
  });
});
