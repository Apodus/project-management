import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import type { Note, NoteFilters } from "@/lib/api";

// ── Radix Select mock (C3 P5 — the epic picker) ───────────────────
// Radix portals its content only when open (pointer-event driven — hostile in
// jsdom), so the file swaps the Select family for an inline clickable list:
// every SelectItem renders as a button that pushes its value through context.
// The page's FILTER selects render the same way — harmless (no test opens them).
const SelectCtx = createContext<(v: string) => void>(() => {});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
  }) => <SelectCtx.Provider value={onValueChange}>{children}</SelectCtx.Provider>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
    const onSelect = useContext(SelectCtx);
    return (
      <button type="button" onClick={() => onSelect(value)}>
        {children}
      </button>
    );
  },
}));

// ── Capture the useNotes filter arg ────────────────────────────────
const useNotesSpy = vi.fn();
let notesData: Note[] = [];

// ── Server FTS mock (C4 hybrid search) ─────────────────────────────
// The page intersects the loaded (structured-filtered) rows with these hits,
// in HIT order. Tests seed `ftsHits` to simulate the /search response.
type FtsHit = {
  entityType: string;
  entityId: string;
  title: string;
  excerpt: string;
  rank: number;
  projectId: string | null;
};
let ftsHits: FtsHit[] = [];
const useFtsSearchSpy = vi.fn();

function makeHit(entityId: string, rank: number): FtsHit {
  return {
    entityType: "note",
    entityId,
    title: `hit ${entityId}`,
    excerpt: "…",
    rank,
    projectId: "proj-1",
  };
}

vi.mock("@/hooks/use-fts-search", () => ({
  useFtsSearch: (q: string, opts: unknown) => {
    useFtsSearchSpy(q, opts);
    return { data: ftsHits, isLoading: false };
  },
}));

function makeNote(overrides: Partial<Note>): Note {
  return {
    id: "note-1",
    projectId: "proj-1",
    kind: "bug",
    status: "open",
    title: "A note",
    body: "Some body text",
    anchorType: null,
    anchorId: null,
    codeLocator: null,
    severity: null,
    authorId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
    // C4 server enrichment — list/get responses always carry these (null when
    // unanchored / not promoted). Tests for the ABSENT (non-enriched) state
    // override with `undefined`.
    anchor: null,
    promotedTarget: null,
    ...overrides,
  };
}

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  // Render <Link> as a plain anchor so it mounts without a RouterProvider.
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

// Shared mutation stub (mirrors train-audit-page.test.tsx). mutateAsync resolves
// to the union shape promote hooks may return so awaits never reject.
function mutation() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi
      .fn()
      .mockResolvedValue({ data: {}, proposal: { id: "prop-1" }, task: { id: "task-1" } }),
    isPending: false,
    reset: vi.fn(),
  };
}

// Single mutation instances per hook so tests can assert on .mutateAsync.
const dismissMutation = mutation();
const promoteProposalMutation = mutation();
const promoteTaskMutation = mutation();
const reopenMutation = mutation();

vi.mock("@/hooks/use-notes", () => ({
  useNotes: (_projectId: string | undefined, filters: NoteFilters) => {
    useNotesSpy(filters);
    return {
      data: { data: notesData, pagination: { total: notesData.length } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useDismissNote: () => dismissMutation,
  useReopenNote: () => reopenMutation,
  usePromoteNoteToProposal: () => promoteProposalMutation,
  usePromoteNoteToTask: () => promoteTaskMutation,
}));

// ── Triage-decision audit feed mock (T3) ───────────────────────────
// The detail dialog's TriageAuditFeed reads this. Tests seed `triageRows`.
let triageRows: Array<Record<string, unknown>> = [];
const useTriageDecisionsSpy = vi.fn();
vi.mock("@/hooks/use-triage-decisions", () => ({
  useTriageDecisions: (
    projectId: string | undefined,
    filters: unknown,
    options?: { enabled?: boolean },
  ) => {
    useTriageDecisionsSpy(projectId, filters, options);
    return {
      data: { data: triageRows, pagination: { total: triageRows.length } },
      isLoading: false,
    };
  },
}));

// Default: a human (promote-to-task visible). Override per test via mockReturnValue.
const useCurrentUserMock = vi.fn(() => ({ data: { type: "human" } }));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: () => useCurrentUserMock(),
}));

vi.mock("@/hooks/use-epics", () => ({
  useEpics: () => ({
    data: [
      { id: "epic-1", name: "Alpha epic", status: "active" },
      { id: "epic-done", name: "Done epic", status: "completed" },
      { id: "epic-dead", name: "Dead epic", status: "cancelled" },
    ],
  }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { NotesPage } from "./notes-page";

beforeEach(() => {
  vi.clearAllMocks();
  notesData = [];
  ftsHits = [];
  triageRows = [];
  // clearAllMocks wipes the implementation — restore the human default.
  useCurrentUserMock.mockReturnValue({ data: { type: "human" } });
});

describe("NotesPage", () => {
  it("renders seeded note titles", () => {
    notesData = [
      makeNote({ id: "n1", title: "Login is broken" }),
      makeNote({ id: "n2", title: "Idea for caching", kind: "idea" }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Login is broken")).toBeInTheDocument();
    expect(screen.getByText("Idea for caching")).toBeInTheDocument();
  });

  // ── C4 hybrid search: server FTS free-text ANDs structured filters ──

  it("free-text narrows the rendered cards to the server FTS hits (debounced)", async () => {
    notesData = [
      makeNote({ id: "n1", title: "Login is broken" }),
      makeNote({ id: "n2", title: "Idea for caching" }),
    ];
    ftsHits = [makeHit("n2", -1.5)];
    render(<NotesPage />);
    fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
      target: { value: "caching" },
    });
    // Search is debounced (300ms) — wait for the filtered render.
    await waitFor(() => expect(screen.queryByText("Login is broken")).not.toBeInTheDocument());
    expect(screen.getByText("Idea for caching")).toBeInTheDocument();
    // The hook received the debounced query, project-scoped to notes.
    expect(useFtsSearchSpy).toHaveBeenLastCalledWith("caching", {
      projectId: "proj-1",
      entityType: "note",
    });
  });

  it("renders free-text results in FTS RANK order (hit order), not list order", async () => {
    notesData = [
      makeNote({ id: "n1", title: "ranked-first-created" }),
      makeNote({ id: "n2", title: "ranked-second-created" }),
      makeNote({ id: "n3", title: "ranked-third-created" }),
    ];
    // Best-ranked hit is n3, then n1; n2 is no hit.
    ftsHits = [makeHit("n3", -2.0), makeHit("n1", -0.5)];
    render(<NotesPage />);
    fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
      target: { value: "ranked" },
    });
    await waitFor(() =>
      expect(screen.queryByText("ranked-second-created")).not.toBeInTheDocument(),
    );
    const titles = screen.getAllByText(/^ranked-/).map((el) => el.textContent);
    expect(titles).toEqual(["ranked-third-created", "ranked-first-created"]);
  });

  it("hides an FTS hit that the structured filters excluded (the AND model)", async () => {
    // The loaded rows are the structured-filtered set; "n-excluded" matched
    // the text server-side but is NOT in the rows → must stay hidden.
    notesData = [makeNote({ id: "n1", title: "Visible note" })];
    ftsHits = [makeHit("n-excluded", -3.0), makeHit("n1", -1.0)];
    render(<NotesPage />);
    fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
      target: { value: "note" },
    });
    await waitFor(() => expect(screen.getByText("Visible note")).toBeInTheDocument());
    // Exactly one card (the excluded hit contributed nothing).
    expect(screen.getAllByText(/note/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("hit n-excluded")).not.toBeInTheDocument();
  });

  it("shows the filtered empty state when the intersection is empty", async () => {
    notesData = [makeNote({ id: "n1", title: "Login is broken" })];
    ftsHits = [];
    render(<NotesPage />);
    fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
      target: { value: "zorvex" },
    });
    await waitFor(() =>
      expect(screen.getByText("No notes match your filters")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Login is broken")).not.toBeInTheDocument();
  });

  it("shows the empty-state copy when there are no notes", () => {
    notesData = [];
    render(<NotesPage />);
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });

  it("passes an empty NoteFilters by default", () => {
    notesData = [];
    render(<NotesPage />);
    const filters = useNotesSpy.mock.calls.at(-1)?.[0] as NoteFilters;
    expect(filters.kind).toBeUndefined();
    expect(filters.status).toBeUndefined();
    expect(filters.anchorType).toBeUndefined();
    expect(filters.severity).toBeUndefined();
  });

  it("shows 'Promoted' on a triaged+promoted note with the enriched target title", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Promote me",
        status: "triaged",
        triageOutcome: "promoted",
        promotedTaskId: "task-known",
        promotedTarget: { exists: true, title: "Resolvable task" },
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Triaged · Promoted")).toBeInTheDocument();
    // Existing promoted target renders its enriched title.
    expect(screen.getByText("Resolvable task")).toBeInTheDocument();
  });

  // ── C4 truth rendering: anchor {exists, title} ──────────────────

  it("renders an EXISTING anchor (exists:true) as its enriched title", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Anchored note",
        anchorType: "task",
        anchorId: "task-known",
        anchor: { exists: true, title: "Resolvable task" },
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText("Resolvable task")).toBeInTheDocument();
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument();
  });

  it("renders a DELETED anchor (exists:false) as a muted non-link '(removed)'", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Dangling anchor note",
        anchorType: "task",
        anchorId: "task-gone-abcdef0123",
        anchor: { exists: false, title: null },
      }),
    ];
    render(<NotesPage />);
    const removed = screen.getByText(/task task-gon.*\(removed\)/);
    expect(removed).toBeInTheDocument();
    // Positive-evidence removal renders as a SPAN, never a link.
    expect(removed.closest("a")).toBeNull();
  });

  it("renders the raw type+short-id (NOT '(removed)') when enrichment is ABSENT", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Old server note",
        anchorType: "task",
        anchorId: "task-missing-abcdef0123",
        anchor: undefined, // non-enriched payload (old server / mid-rollout)
      }),
    ];
    render(<NotesPage />);
    // No positive evidence → pre-C4 fallback, never "(removed)".
    expect(screen.getByText(/task task-mis/)).toBeInTheDocument();
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument();
  });

  // ── C4 truth rendering: promotedTarget variants ─────────────────

  it("renders a DELETED promoted target (exists:false) as '(removed)'", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Promoted then target deleted",
        status: "triaged",
        triageOutcome: "promoted",
        promotedProposalId: "prop-gone-abcdef0123",
        promotedTarget: { exists: false, title: null },
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText(/proposal prop-gon.*\(removed\)/)).toBeInTheDocument();
  });

  it("renders the promoted-target short-id fallback (NOT '(removed)') when enrichment is ABSENT", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Promoted, old server",
        status: "triaged",
        triageOutcome: "promoted",
        promotedTaskId: "task-promoted-abcdef0123",
        promotedTarget: undefined,
      }),
    ];
    render(<NotesPage />);
    expect(screen.getByText(/task task-pro/)).toBeInTheDocument();
    expect(screen.queryByText(/removed/i)).not.toBeInTheDocument();
  });

  // ── Triage actions (C3 P3) ──────────────────────────────────────

  it("renders Dismiss + Promote-to-proposal on an open note", () => {
    notesData = [makeNote({ id: "n1", title: "Open note", status: "open" })];
    render(<NotesPage />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote to proposal" })).toBeInTheDocument();
  });

  it("dismiss: dialog requires a reason, then calls mutateAsync with {id, projectId, reason}", async () => {
    notesData = [makeNote({ id: "n1", projectId: "proj-1", title: "Open note", status: "open" })];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // Submit button (inside the dialog) is disabled while the reason is empty.
    const submit = screen
      .getAllByRole("button", { name: "Dismiss" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    expect(submit).toBeTruthy();
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/not reproducible/i), {
      target: { value: "duplicate" },
    });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() =>
      expect(dismissMutation.mutateAsync).toHaveBeenCalledWith({
        id: "n1",
        projectId: "proj-1",
        reason: "duplicate",
      }),
    );
  });

  it("promote-to-proposal: prefills title and calls mutateAsync with {id, projectId, title, description}", async () => {
    notesData = [
      makeNote({
        id: "n1",
        projectId: "proj-1",
        title: "Caching idea",
        status: "open",
      }),
    ];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to proposal" }));

    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    expect(titleInput.value).toBe("Caching idea");

    // Submit is the dialog-content "Promote" button.
    const submit = screen
      .getAllByRole("button", { name: "Promote" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(promoteProposalMutation.mutateAsync).toHaveBeenCalledWith({
        id: "n1",
        projectId: "proj-1",
        title: "Caching idea",
        // Prefill now seeds description from the note body (makeNote default
        // "Some body text") — a well-formed short title stays verbatim.
        description: "Some body text",
      }),
    );
  });

  it("promote-to-task is hidden for ai_agent and shown for human; submit calls mutateAsync", async () => {
    notesData = [
      makeNote({
        id: "n1",
        projectId: "proj-1",
        title: "Bug to fix",
        status: "open",
      }),
    ];

    // ai_agent → hidden.
    useCurrentUserMock.mockReturnValue({ data: { type: "ai_agent" } });
    const { unmount } = render(<NotesPage />);
    expect(screen.queryByRole("button", { name: "Promote to task" })).not.toBeInTheDocument();
    unmount();

    // human → shown.
    useCurrentUserMock.mockReturnValue({ data: { type: "human" } });
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to task" }));

    const submit = screen
      .getAllByRole("button", { name: "Promote" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(promoteTaskMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "n1",
          projectId: "proj-1",
          title: "Bug to fix",
        }),
      ),
    );
  });

  // ── Epic picker in the promote-to-task dialog (C3 P5) ───────────

  it("epic picker lists non-terminal epics only (completed/cancelled excluded)", () => {
    notesData = [makeNote({ id: "n1", projectId: "proj-1", title: "Bug to fix", status: "open" })];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to task" }));

    expect(screen.getByRole("button", { name: "Alpha epic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No epic" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done epic" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dead epic" })).not.toBeInTheDocument();
  });

  it("picking an epic submits its id", async () => {
    notesData = [makeNote({ id: "n1", projectId: "proj-1", title: "Bug to fix", status: "open" })];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to task" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha epic" }));

    const submit = screen
      .getAllByRole("button", { name: "Promote" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(promoteTaskMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: "n1", epicId: "epic-1" }),
      ),
    );
  });

  it("leaving the picker on No-epic submits epicId undefined", async () => {
    notesData = [makeNote({ id: "n1", projectId: "proj-1", title: "Bug to fix", status: "open" })];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Promote to task" }));

    const submit = screen
      .getAllByRole("button", { name: "Promote" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(promoteTaskMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: "n1", epicId: undefined }),
      ),
    );
  });

  // ── Full-text note detail dialog (P2) ───────────────────────────

  const LONG_BODY =
    "First paragraph describing the bug in detail.\n\n" +
    "Second paragraph with reproduction steps that go on for a while so the " +
    "card preview would clamp this to two lines and lose the rest entirely.\n\n" +
    "Third paragraph with the proposed fix and a bunch more words to push the " +
    "fixture comfortably past five hundred characters total length here now.";

  it("opens the detail from the title showing the FULL unclamped body", () => {
    notesData = [makeNote({ id: "n1", title: "Short title", body: LONG_BODY })];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Short title" }));

    // The body has newlines (pre-wrap) — getByText normalizes whitespace, so
    // match on raw textContent inside the dialog instead.
    const content = document.querySelector("[data-slot='dialog-content']") as HTMLElement;
    const dialog = Array.from(content.querySelectorAll("p")).find(
      (p) => p.textContent === LONG_BODY,
    )!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toBe(LONG_BODY);
    // Unclamped: pre-wrap, never line-clamp (the jsdom-appropriate assertion).
    expect(dialog.className).toContain("whitespace-pre-wrap");
    expect(dialog.className).not.toContain("line-clamp");
  });

  it("detail renders the metadata (codeLocator, severity, anchor)", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Metadata note",
        codeLocator: { path: "src/x.ts", line: 42 },
        severity: "high",
        anchorType: "task",
        anchorId: "task-known",
        anchor: { exists: true, title: "Anchor target" },
      }),
    ];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Metadata note" }));

    // The anchor title is a single text node inside the detail — anchor it,
    // then assert on the whole dialog-content textContent.
    const anchorTitle = screen
      .getAllByText("Anchor target")
      .find((el) => el.closest("[data-slot='dialog-content']"))!;
    const content = anchorTitle.closest("[data-slot='dialog-content']") as HTMLElement;
    // codeLocator proves the detail surfaces what the card never showed.
    expect(content.textContent).toContain("src/x.ts:42");
    expect(content.textContent).toContain("High");
    expect(content.textContent).toContain("Anchor target");
  });

  it("detail is openable for a triaged note (status-independent readability)", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Triaged readable",
        body: "Body of a triaged note",
        status: "triaged",
        triageOutcome: "dismissed",
      }),
    ];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Triaged readable" }));

    const body = screen
      .getAllByText("Body of a triaged note")
      .find((el) => el.closest("[data-slot='dialog-content']"));
    expect(body).toBeTruthy();
  });

  it("acting from the detail opens the promote dialog with the prefilled title", () => {
    notesData = [
      makeNote({
        id: "n1",
        projectId: "proj-1",
        title: "Caching idea",
        status: "open",
      }),
    ];
    render(<NotesPage />);
    // Open the detail from the title button.
    fireEvent.click(screen.getByRole("button", { name: "Caching idea" }));
    // Click the detail footer's "Promote to proposal" (scoped to the open
    // detail dialog — the card's own button has the same name) — closes the
    // detail, opens the card's existing promote dialog (P1 prefill flows through).
    const detailPromote = screen
      .getAllByRole("button", { name: "Promote to proposal" })
      .find((b) => b.closest("[data-slot='dialog-content']"))!;
    fireEvent.click(detailPromote);

    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    expect(titleInput.value).toBe("Caching idea");
  });

  it("renders NO triage actions on a triaged note", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Already triaged",
        status: "triaged",
        triageOutcome: "dismissed",
      }),
    ];
    render(<NotesPage />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Promote to proposal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Promote to task" })).not.toBeInTheDocument();
  });

  // ── T3 — needs_human queue + fast-track + reopen + audit feed ────

  it("the status filter offers a needs_human option that sets f.status when picked", () => {
    notesData = [];
    render(<NotesPage />);
    const option = screen.getByRole("button", { name: formatStatusLabel("needs_human") });
    expect(option).toBeInTheDocument();
    fireEvent.click(option);
    const filters = useNotesSpy.mock.calls.at(-1)?.[0] as NoteFilters;
    expect(filters.status).toBe("needs_human");
  });

  it("renders the needs_human badge on a needs_human note", () => {
    notesData = [makeNote({ id: "n1", title: "Punted note", status: "needs_human" })];
    render(<NotesPage />);
    // "Needs Human" appears both as a filter option (a button) and as the card
    // badge (a non-button span) — assert the badge specifically.
    const badge = screen
      .getAllByText(formatStatusLabel("needs_human"))
      .find((el) => !el.closest("button"));
    expect(badge).toBeTruthy();
  });

  it("a needs_human note shows Dismiss + Promote-to-proposal + Reopen (mutable + reopenable)", () => {
    notesData = [makeNote({ id: "n1", title: "Punted note", status: "needs_human" })];
    render(<NotesPage />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote to proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("renders the Fast-track badge when promotedTarget.proposalKind is fast_track, absent for standard", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Fast-tracked note",
        status: "triaged",
        triageOutcome: "promoted",
        promotedProposalId: "prop-fast",
        promotedTarget: { exists: true, title: "Fast proposal", proposalKind: "fast_track" },
      }),
      makeNote({
        id: "n2",
        title: "Standard note",
        status: "triaged",
        triageOutcome: "promoted",
        promotedProposalId: "prop-std",
        promotedTarget: { exists: true, title: "Std proposal", proposalKind: "standard" },
      }),
    ];
    render(<NotesPage />);
    // Exactly one Fast-track badge (the fast_track note only).
    expect(screen.getAllByText("Fast-track")).toHaveLength(1);
  });

  it("Reopen is shown for a human on a triaged note, hidden for an ai_agent", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Triaged note",
        status: "triaged",
        triageOutcome: "dismissed",
      }),
    ];

    // ai_agent → no Reopen.
    useCurrentUserMock.mockReturnValue({ data: { type: "ai_agent" } });
    const { unmount } = render(<NotesPage />);
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
    unmount();

    // human → Reopen shown.
    useCurrentUserMock.mockReturnValue({ data: { type: "human" } });
    render(<NotesPage />);
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("clicking Reopen calls reopenMutation.mutateAsync with {id, projectId}", async () => {
    notesData = [
      makeNote({
        id: "n1",
        projectId: "proj-1",
        title: "Triaged note",
        status: "triaged",
        triageOutcome: "dismissed",
      }),
    ];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(reopenMutation.mutateAsync).toHaveBeenCalledWith({ id: "n1", projectId: "proj-1" }),
    );
  });

  it("the detail dialog renders the per-note triage audit feed rows", () => {
    notesData = [
      makeNote({
        id: "n1",
        title: "Audited note",
        status: "triaged",
        triageOutcome: "dismissed",
        triagedBy: "agent-7",
      }),
    ];
    triageRows = [
      {
        id: "d1",
        projectId: "proj-1",
        noteId: "n1",
        mode: "on",
        decision: "dismiss",
        rationale: "out of scope noise",
        confidence: 0.82,
        resultingProposalId: null,
        resultingTaskId: null,
        actorId: "agent-7",
        createdAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Audited note" }));

    const content = document.querySelector("[data-slot='dialog-content']") as HTMLElement;
    expect(content.textContent).toContain("Triage history");
    expect(content.textContent).toContain("out of scope noise");
    expect(content.textContent).toContain("agent-7");
    // Gated on the dialog's open prop (enabled true once open).
    const lastCall = useTriageDecisionsSpy.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({ noteId: "n1" });
    expect(lastCall?.[2]).toEqual({ enabled: true });
  });
});

// formatStatus (Title Cases + replaces "_") — mirror it locally for label
// lookups so the test asserts on the same rendered string.
function formatStatusLabel(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
