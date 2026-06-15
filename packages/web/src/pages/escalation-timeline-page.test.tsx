import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { EscalationMessage, EscalationWithThread, MergeRequest } from "@/lib/api";

let timelineData: EscalationWithThread | undefined;
let mergeRequestsData: MergeRequest[] = [];

// Capture Link targets (route + params) so we can assert the deep links the
// audit chain renders (epic / task / merge-request timeline).
const linkCalls: Array<{ to?: string; params?: Record<string, string> }> = [];

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ escalationId: "esc-1" }),
  Link: ({
    to,
    params,
    children,
  }: {
    to?: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) => {
    linkCalls.push({ to, params });
    return <a>{children}</a>;
  },
}));

vi.mock("@/hooks/use-escalations", () => ({
  useEscalation: () => ({
    data: timelineData,
    isLoading: false,
    isError: false,
  }),
  useEscalationMergeRequests: () => ({ data: mergeRequestsData }),
}));

function makeMergeRequest(overrides: Partial<MergeRequest>): MergeRequest {
  return {
    id: "mr-00000001",
    projectId: "proj-1",
    resource: "main",
    submittedBy: "responder",
    taskId: null,
    resolvedFrom: null,
    escalationId: "esc-1",
    revertOf: null,
    synthetic: false,
    branch: "pm/escalation-esc-1",
    commitSha: "abcdef1234567890",
    verifyCmd: null,
    worktreePath: null,
    status: "landed",
    enqueuedAt: "2026-06-10T00:00:00.000Z",
    pickedUpAt: null,
    resolvedAt: null,
    landedSha: "deadbeef1234567890",
    rejectCategory: null,
    rejectReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<EscalationMessage>): EscalationMessage {
  return {
    id: "m-1",
    escalationId: "esc-1",
    seq: 1,
    authorId: "agent-1",
    body: "message body",
    messageType: "reply",
    metadata: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<EscalationWithThread>): EscalationWithThread {
  return {
    id: "esc-1",
    projectId: "proj-1",
    kind: "bug_report",
    status: "answered",
    severity: "high",
    title: "Build is red",
    body: "The verify step fails on main",
    codeLocator: { path: "src/index.ts", line: 42 },
    anchorType: null,
    anchorId: null,
    originRepo: "game_one",
    originWorkerKey: "worker-3",
    holderId: "human-director",
    authorId: "agent-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T01:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    messages: [],
    ...overrides,
  };
}

import { EscalationTimelinePage, extractAuditChain } from "./escalation-timeline-page";

beforeEach(() => {
  vi.clearAllMocks();
  timelineData = undefined;
  mergeRequestsData = [];
  linkCalls.length = 0;
});

describe("EscalationTimelinePage", () => {
  it("renders the header fields (title, origin, code locator, author)", () => {
    timelineData = makeThread({});
    render(<EscalationTimelinePage />);
    expect(screen.getByText("Build is red")).toBeInTheDocument();
    expect(screen.getByText("The verify step fails on main")).toBeInTheDocument();
    expect(screen.getByText(/game_one · worker-3/)).toBeInTheDocument();
    expect(screen.getByText("src/index.ts:42")).toBeInTheDocument();
    expect(screen.getByText(/author: agent-1/)).toBeInTheDocument();
  });

  it("renders the message thread in ascending seq order with author + type", () => {
    timelineData = makeThread({
      messages: [
        makeMessage({
          id: "m2",
          seq: 2,
          authorId: "human-director",
          body: "second",
          messageType: "diagnosis",
        }),
        makeMessage({ id: "m1", seq: 1, authorId: "agent-1", body: "first", messageType: "reply" }),
      ],
    });
    render(<EscalationTimelinePage />);

    const first = screen.getByText("first");
    const second = screen.getByText("second");
    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    // seq 1 (first) must render before seq 2 (second) in document order.
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByText("Diagnosis")).toBeInTheDocument();
    expect(screen.getByText("Reply")).toBeInTheDocument();
  });

  it("shows the empty-thread copy when there are no messages", () => {
    timelineData = makeThread({ messages: [] });
    render(<EscalationTimelinePage />);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("renders the lifecycle stages including the reached status", () => {
    // Use a status whose label does not collide with a happy-path stage label
    // (e.g. "answered" would also appear as the header status badge).
    timelineData = makeThread({ status: "open" });
    render(<EscalationTimelinePage />);
    // The happy-path stages are all present as labels. "Open" appears twice
    // (header status badge + lifecycle stage) — assert at least one of each.
    expect(screen.getAllByText("Open").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();
    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("flags needs_human as a distinct side-channel stage", () => {
    timelineData = makeThread({ status: "needs_human" });
    render(<EscalationTimelinePage />);
    expect(screen.getByText("Needs human")).toBeInTheDocument();
  });

  // ─── Audit chain (A5 P2) ───────────────────────────────────────

  it("auto-implemented (bounded): renders the disposition badge, landed sha + a timeline link", () => {
    timelineData = makeThread({
      messages: [
        makeMessage({
          id: "m1",
          seq: 1,
          messageType: "diagnosis",
          body: "submitted mr",
          metadata: {
            pendingLand: true,
            mergeRequestId: "mr-00000001",
            branch: "pm/escalation-esc-1",
            commitSha: "abcdef1234567890",
          },
        }),
      ],
    });
    mergeRequestsData = [makeMergeRequest({ id: "mr-00000001" })];
    render(<EscalationTimelinePage />);

    expect(screen.getByText("Auto-implemented (bounded)")).toBeInTheDocument();
    expect(screen.getByText(/landed deadbeef12/)).toBeInTheDocument();
    expect(screen.getByText("View timeline")).toBeInTheDocument();
    // The MR id deep-links to the merge-request timeline route.
    const mrLink = linkCalls.find((c) => c.to === "/merge-requests/$requestId/timeline");
    expect(mrLink?.params).toEqual({ requestId: "mr-00000001" });
  });

  it("auto-driven (arc): renders the epic link, N of M phases landed + per-phase task links", () => {
    timelineData = makeThread({
      messages: [
        makeMessage({
          id: "m1",
          seq: 1,
          messageType: "diagnosis",
          body: "vision created",
          metadata: {
            pendingDrive: true,
            epicId: "epic-99",
            visionPath: "roadmaps/vision-x.md",
          },
        }),
        makeMessage({
          id: "m2",
          seq: 2,
          messageType: "diagnosis",
          body: "phase 1 mr",
          metadata: { pendingArc: true, epicId: "epic-99", phaseTaskId: "task-1" },
        }),
      ],
    });
    mergeRequestsData = [
      makeMergeRequest({ id: "mr-phase-1", status: "landed", taskId: "task-1" }),
      makeMergeRequest({ id: "mr-phase-2", status: "queued", taskId: "task-2", landedSha: null }),
    ];
    render(<EscalationTimelinePage />);

    expect(screen.getByText("Auto-driven (arc)")).toBeInTheDocument();
    // Vision epic deep link.
    const epicLink = linkCalls.find((c) => c.to === "/epics/$epicId");
    expect(epicLink?.params).toEqual({ epicId: "epic-99" });
    // Arc progress: 1 of 2 landed.
    expect(screen.getByText("1 of 2 phases landed")).toBeInTheDocument();
    // Per-phase task links.
    const taskLink = linkCalls.find((c) => c.to === "/tasks/$taskId");
    expect(taskLink).toBeTruthy();
  });

  it("revert chain: renders the 'revert of <sha>' tag + a timeline link", () => {
    timelineData = makeThread({
      messages: [
        makeMessage({
          id: "m1",
          seq: 1,
          messageType: "diagnosis",
          body: "submitted mr",
          metadata: { pendingLand: true, mergeRequestId: "mr-1" },
        }),
      ],
    });
    mergeRequestsData = [
      makeMergeRequest({ id: "mr-revert", revertOf: "cafebabe1234567890", landedSha: null }),
    ];
    render(<EscalationTimelinePage />);

    expect(screen.getAllByText(/revert of cafebabe12/).length).toBeGreaterThanOrEqual(1);
    const mrLink = linkCalls.find(
      (c) => c.to === "/merge-requests/$requestId/timeline" && c.params?.requestId === "mr-revert",
    );
    expect(mrLink).toBeTruthy();
  });

  it("non-auto-implement (no markers, no MRs): the audit-chain card is absent", () => {
    timelineData = makeThread({
      messages: [makeMessage({ id: "m1", seq: 1, messageType: "reply", body: "just a reply" })],
    });
    mergeRequestsData = [];
    render(<EscalationTimelinePage />);

    // The audit-chain card title must NOT render.
    expect(screen.queryByText("Audit chain")).toBeNull();
    // The thread is unchanged.
    expect(screen.getByText("just a reply")).toBeInTheDocument();
  });
});

// ─── extractAuditChain (pure helper) ─────────────────────────────

describe("extractAuditChain", () => {
  it("classifies a bounded land as auto_implemented", () => {
    const chain = extractAuditChain([
      makeMessage({ seq: 1, metadata: { pendingLand: true, mergeRequestId: "mr-1" } }),
    ]);
    expect(chain.disposition).toBe("auto_implemented");
  });

  it("classifies a drive as auto_driven and pulls the latest epic + vision", () => {
    const chain = extractAuditChain([
      makeMessage({
        seq: 1,
        metadata: { pendingDrive: true, epicId: "epic-1", visionPath: "v1.md" },
      }),
      makeMessage({
        seq: 2,
        metadata: { pendingArc: true, epicId: "epic-1", phaseTaskId: "t-1" },
      }),
    ]);
    expect(chain.disposition).toBe("auto_driven");
    expect(chain.epicId).toBe("epic-1");
    expect(chain.visionPath).toBe("v1.md");
  });

  it("flags arcComplete from the arc-complete marker", () => {
    const chain = extractAuditChain([
      makeMessage({
        seq: 1,
        metadata: { pendingArc: true, arcComplete: true, epicId: "epic-1" },
      }),
    ]);
    expect(chain.arcComplete).toBe(true);
  });

  it("classifies a shadow proposal (no land/drive) as shadow_proposal", () => {
    const chain = extractAuditChain([
      makeMessage({ seq: 1, metadata: { shadowProposal: true, branch: "b" } }),
    ]);
    expect(chain.disposition).toBe("shadow_proposal");
    expect(chain.hasShadow).toBe(true);
  });

  it("returns a null disposition for a plain escalation (no markers)", () => {
    const chain = extractAuditChain([
      makeMessage({ seq: 1, messageType: "reply", metadata: null }),
    ]);
    expect(chain.disposition).toBeNull();
    expect(chain.epicId).toBeNull();
  });
});
