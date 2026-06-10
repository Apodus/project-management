import { describe, expect, it } from "vitest";
import { getInvalidationKeys } from "./use-sse";
import { trainKeys } from "./use-train";
import { noteKeys } from "./use-notes";
import { claimKeys } from "./use-claims";

describe("getInvalidationKeys — merge-train wiring", () => {
  it("invalidates trainKeys on train.* alert events", () => {
    expect(getInvalidationKeys("train.stuck")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.paused")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.integrator_unhealthy")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("train.abandon_rate_high")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("train.integration_stalled")).toEqual([
      trainKeys.all,
    ]);
  });

  it("invalidates trainKeys on audit.recorded (the audit query lives under trainKeys.all)", () => {
    expect(getInvalidationKeys("audit.recorded")).toEqual([trainKeys.all]);
  });

  it("invalidates trainKeys on merge.* lifecycle events (queue/in-flight moved)", () => {
    expect(getInvalidationKeys("merge.request.landed")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("merge.request.rejected")).toEqual([
      trainKeys.all,
    ]);
    expect(getInvalidationKeys("merge.group.landed")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("merge.batch.formed")).toEqual([trainKeys.all]);
  });

  it("leaves unrelated event prefixes untouched", () => {
    expect(getInvalidationKeys("unknown.thing")).toEqual([]);
  });

  // Campaign C3 §P5a — the stale-claim alert is a toast-only banner event (no
  // cache invalidation: the always-open useClaimsHealth poll owns the refresh,
  // the SSE frame just surfaces the banner). The "claim" prefix has no
  // invalidation map entry, so it correctly returns no keys.
  it("does not invalidate caches on claim.stale_alert (toast-only banner)", () => {
    expect(getInvalidationKeys("claim.stale_alert")).toEqual([]);
  });

  // Campaign C3 — note.* lifecycle invalidates noteKeys.all (the ["notes"]
  // prefix of lists()/detail()/health()): one entry refreshes the inbox list,
  // any open note detail, and notes health together.
  it("invalidates noteKeys on note.* lifecycle events", () => {
    expect(getInvalidationKeys("note.created")).toEqual([noteKeys.all]);
    expect(getInvalidationKeys("note.updated")).toEqual([noteKeys.all]);
    expect(getInvalidationKeys("note.dismissed")).toEqual([noteKeys.all]);
    expect(getInvalidationKeys("note.promoted")).toEqual([noteKeys.all]);
  });

  // note.backlog_alert is a toast-only banner (the toast itself is raised in
  // maybeShowToast, and the useNotesHealth poll owns the authoritative inbox
  // refresh). It carries no dedicated invalidation branch — but because it shares
  // the "note" prefix it still maps to noteKeys.all, which is harmless (a redundant
  // inbox refresh, never a stale view). Unlike claim.stale_alert (no "claim" case
  // in the switch → []), the "note" case necessarily catches this subtype too.
  it("maps note.backlog_alert via prefix to noteKeys.all (toast raised separately)", () => {
    expect(getInvalidationKeys("note.backlog_alert")).toEqual([noteKeys.all]);
  });

  // An unknown note subtype still maps via the "note" prefix → noteKeys.all.
  it("maps an unknown note subtype via prefix to noteKeys.all", () => {
    expect(getInvalidationKeys("note.xyz")).toEqual([noteKeys.all]);
  });

  // Campaign C3 (claims surface) — task/epic/proposal lifecycle events also
  // refresh the claims panel: claim/release/assign/handoff all surface as
  // entity events, and the panel's rows derive from those holders.
  it("invalidates claimKeys on task.* / epic.* / proposal.* events", () => {
    expect(getInvalidationKeys("task.updated")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("task.assigned")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("epic.updated")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("proposal.transitioned")).toContainEqual(
      claimKeys.all,
    );
  });

  it("does NOT invalidate claimKeys on unrelated prefixes", () => {
    expect(getInvalidationKeys("merge.request.landed")).not.toContainEqual(
      claimKeys.all,
    );
    expect(getInvalidationKeys("note.created")).not.toContainEqual(
      claimKeys.all,
    );
  });
});
