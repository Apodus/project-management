import { describe, expect, it, vi, beforeEach } from "vitest";
import { getInvalidationKeys, maybeShowToast } from "./use-sse";
import { trainKeys } from "./use-train";
import { noteKeys } from "./use-notes";
import { triageDecisionKeys } from "./use-triage-decisions";
import { claimKeys } from "./use-claims";
import { escalationKeys } from "./use-escalations";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

describe("getInvalidationKeys — merge-train wiring", () => {
  it("invalidates trainKeys on train.* alert events", () => {
    expect(getInvalidationKeys("train.stuck")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.paused")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.integrator_unhealthy")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.abandon_rate_high")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("train.integration_stalled")).toEqual([trainKeys.all]);
  });

  it("invalidates trainKeys on audit.recorded (the audit query lives under trainKeys.all)", () => {
    expect(getInvalidationKeys("audit.recorded")).toEqual([trainKeys.all]);
  });

  it("invalidates trainKeys on merge.* lifecycle events (queue/in-flight moved)", () => {
    expect(getInvalidationKeys("merge.request.landed")).toEqual([trainKeys.all]);
    expect(getInvalidationKeys("merge.request.rejected")).toEqual([trainKeys.all]);
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

  // T3 — note state-machine events (flag→needs_human + human-only reopen) share
  // the "note" prefix, so they map to noteKeys.all (inbox list + open detail +
  // health refresh together).
  it("maps note.needs_human and note.reopened via prefix to noteKeys.all", () => {
    expect(getInvalidationKeys("note.needs_human")).toEqual([noteKeys.all]);
    expect(getInvalidationKeys("note.reopened")).toEqual([noteKeys.all]);
  });

  // T3 — the triage_decision.* side-log maps to triageDecisionKeys.all (the
  // ["triage-decisions"] prefix of lists()/byNote()), refreshing any open
  // per-note audit feed.
  it("invalidates triageDecisionKeys on triage_decision.recorded", () => {
    expect(getInvalidationKeys("triage_decision.recorded")).toEqual([triageDecisionKeys.all]);
  });

  // Campaign C3 (claims surface) — task/epic/proposal lifecycle events also
  // refresh the claims panel: claim/release/assign/handoff all surface as
  // entity events, and the panel's rows derive from those holders.
  it("invalidates claimKeys on task.* / epic.* / proposal.* events", () => {
    expect(getInvalidationKeys("task.updated")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("task.assigned")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("epic.updated")).toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("proposal.transitioned")).toContainEqual(claimKeys.all);
  });

  it("does NOT invalidate claimKeys on unrelated prefixes", () => {
    expect(getInvalidationKeys("merge.request.landed")).not.toContainEqual(claimKeys.all);
    expect(getInvalidationKeys("note.created")).not.toContainEqual(claimKeys.all);
  });
});

// ─── maybeShowToast — actionable stale-claim toast (Campaign C3 P4) ──

describe("maybeShowToast — claim.stale_alert action", () => {
  beforeEach(() => {
    toastMock.warning.mockClear();
  });

  const stalePayload = {
    entity_type: "project",
    // entity_id IS the projectId on this frame (per-project aggregate alert).
    entity_id: "proj-42",
    action: "stale_alert",
    actor: { id: null, name: "system", type: "system" },
    timestamp: "2026-06-10T00:00:00.000Z",
  };

  it("attaches a View-claims action that navigates to the project claims panel", () => {
    const navigate = vi.fn();
    maybeShowToast("claim.stale_alert", stalePayload, navigate);

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.warning.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Stale claims");
    expect(opts.action?.label).toBe("View claims");

    opts.action!.onClick();
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/claims",
      params: { projectId: "proj-42" },
    });
  });

  it("omits the action when no navigate fn is supplied (still toasts)", () => {
    maybeShowToast("claim.stale_alert", stalePayload);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const opts = toastMock.warning.mock.calls[0][1] as { action?: unknown };
    expect(opts.action).toBeUndefined();
  });
});

// ─── escalation.sla_breached — unanswered-SLA toast (Campaign C4 P3) ──

describe("maybeShowToast — escalation.sla_breached", () => {
  beforeEach(() => {
    toastMock.warning.mockClear();
  });

  const slaPayload = {
    entity_type: "project",
    entity_id: "proj-42",
    action: "sla_breached",
    actor: { id: null, name: "system", type: "system" },
    timestamp: "2026-06-13T00:00:00.000Z",
  };

  it("raises a masked unanswered-SLA warning toast (no ids/counts)", () => {
    maybeShowToast("escalation.sla_breached", slaPayload);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.warning.mock.calls[0] as [string, { description?: string }];
    expect(title).toBe("Escalations going unanswered");
    // Masked copy — no ids/counts leak.
    expect(opts.description).not.toMatch(/proj-42/);
  });
});

// escalation.sla_breached is a toast-only banner (the toast is raised in
// maybeShowToast; the useEscalationMetrics poll owns the authoritative dashboard
// refresh). It shares the "escalation" prefix so it still maps to
// escalationKeys.all (harmless redundant refresh, never a stale view) — mirroring
// note.backlog_alert mapping to noteKeys.all.
describe("getInvalidationKeys — escalation.sla_breached prefix mapping", () => {
  it("maps escalation.sla_breached via prefix to escalationKeys.all (toast raised separately)", () => {
    expect(getInvalidationKeys("escalation.sla_breached")).toEqual([escalationKeys.all]);
  });

  it("subscribes to escalation.sla_breached (assert via the prefix invalidation)", () => {
    // The eventTypes subscription list includes escalation.sla_breached; its
    // handler invalidates via the shared "escalation" prefix.
    expect(getInvalidationKeys("escalation.sla_breached")).not.toEqual([]);
  });
});
