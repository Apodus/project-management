import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { EscalationMessage, EscalationWithThread } from "@/lib/api";

let timelineData: EscalationWithThread | undefined;

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ escalationId: "esc-1" }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/hooks/use-escalations", () => ({
  useEscalation: () => ({
    data: timelineData,
    isLoading: false,
    isError: false,
  }),
}));

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

function makeThread(
  overrides: Partial<EscalationWithThread>,
): EscalationWithThread {
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

import { EscalationTimelinePage } from "./escalation-timeline-page";

beforeEach(() => {
  vi.clearAllMocks();
  timelineData = undefined;
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
        makeMessage({ id: "m2", seq: 2, authorId: "human-director", body: "second", messageType: "diagnosis" }),
        makeMessage({ id: "m1", seq: 1, authorId: "agent-1", body: "first", messageType: "reply" }),
      ],
    });
    render(<EscalationTimelinePage />);

    const first = screen.getByText("first");
    const second = screen.getByText("second");
    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    // seq 1 (first) must render before seq 2 (second) in document order.
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

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
});
