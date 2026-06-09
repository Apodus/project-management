import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ── Mock the router (Link passthrough capturing search/params) ────
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      data-testid="link"
      data-to={to}
      data-params={JSON.stringify(params)}
      data-search={JSON.stringify(search)}
    >
      {children}
    </a>
  ),
}));

// ── Mock the notes hook ──────────────────────────────────────────
const mocks = vi.hoisted(() => ({ useNotes: vi.fn() }));
vi.mock("@/hooks/use-notes", () => ({ useNotes: mocks.useNotes }));

import { AnchoredNotesBadge } from "./anchored-notes-badge";

function setCount(n: number) {
  mocks.useNotes.mockReturnValue({
    data: { data: Array.from({ length: n }, (_, i) => ({ id: `n-${i}` })) },
  });
}

describe("AnchoredNotesBadge", () => {
  it("renders the plural count when there are multiple open findings", () => {
    setCount(3);
    render(
      <AnchoredNotesBadge projectId="proj-1" anchorType="task" anchorId="task-1" />,
    );
    expect(
      screen.getByText("3 open findings reference this"),
    ).toBeInTheDocument();
  });

  it("renders the singular form for exactly one finding", () => {
    setCount(1);
    render(
      <AnchoredNotesBadge projectId="proj-1" anchorType="epic" anchorId="epic-1" />,
    );
    expect(
      screen.getByText("1 open finding reference this"),
    ).toBeInTheDocument();
  });

  it("renders nothing when there are no open findings", () => {
    setCount(0);
    const { container } = render(
      <AnchoredNotesBadge
        projectId="proj-1"
        anchorType="proposal"
        anchorId="prop-1"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the query has no data (e.g. null projectId)", () => {
    mocks.useNotes.mockReturnValue({ data: undefined });
    const { container } = render(
      <AnchoredNotesBadge anchorType="task" anchorId="task-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("deep-links to the inbox with the anchor + open status in search", () => {
    setCount(2);
    render(
      <AnchoredNotesBadge projectId="proj-1" anchorType="task" anchorId="task-9" />,
    );
    const link = screen.getByTestId("link");
    expect(link).toHaveAttribute("data-to", "/projects/$projectId/notes");
    expect(JSON.parse(link.getAttribute("data-params")!)).toEqual({
      projectId: "proj-1",
    });
    expect(JSON.parse(link.getAttribute("data-search")!)).toEqual({
      anchorType: "task",
      anchorId: "task-9",
      status: "open",
    });
  });
});
